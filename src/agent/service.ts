/**
 * The application-wide agent instance, wired from configuration.
 *
 * Kept separate from `runner.ts` so the runner stays a plain factory over an
 * injected model binding, and this module owns the one-time resolution and the
 * "not configured" outcomes.
 */

import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { loadInstructions } from "./instructions.ts";
import { PROVIDER_ID, resolveModel } from "./model.ts";
import { createAgentRunner, type AgentReply, type AgentRunner } from "./runner.ts";

export type AgentStatus =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly model: string;
      readonly sessions: number;
      /**
       * Which DATA_DIR files ended up in the system prompt. Empty is a valid
       * state, and reporting it answers "is my AGENTS.md actually loaded?"
       * without reading the process's logs.
       */
      readonly instructionFiles: readonly string[];
    };

/** `undefined` = not resolved yet, `null` = resolution attempted and failed. */
let runner: AgentRunner | null | undefined;

/** Files from DATA_DIR that contributed to the prompt, captured at init. */
let instructionFiles: readonly string[] = [];

/**
 * Resolves the model once. Call at startup so a bad AGENT_MODEL is reported
 * then, rather than on the first chat message.
 */
export const initAgent = (): void => {
  if (runner !== undefined) {
    return;
  }

  const agentConfig = config.agent;
  if (agentConfig === null) {
    logger.warn("deepseek api key not configured, agent disabled", {
      hint: "set DEEPSEEK_API_KEY (see .env.example)",
    });
    runner = null;
    return;
  }

  const resolution = resolveModel(agentConfig.model);
  if (!resolution.ok) {
    logger.error("configured agent model is not in the deepseek catalog", {
      model: agentConfig.model,
      provider: PROVIDER_ID,
      available: resolution.available,
    });
    runner = null;
    return;
  }

  // Read once, here: every session created later shares this prompt, so edits
  // to AGENTS.md or MEMORY.md land on the next restart rather than mid-chat.
  const instructions = loadInstructions(config.dataDir, agentConfig.systemPrompt);
  instructionFiles = instructions.loaded;

  runner = createAgentRunner(
    { ...agentConfig, systemPrompt: instructions.systemPrompt },
    resolution.binding,
  );
  logger.info("agent ready", {
    provider: PROVIDER_ID,
    model: resolution.binding.model.id,
    contextWindow: resolution.binding.model.contextWindow,
    timeoutMs: agentConfig.timeoutMs,
    dataDir: config.dataDir,
    instructionFiles,
  });
};

export const getAgentStatus = (): AgentStatus => {
  if (runner === undefined || runner === null || config.agent === null) {
    return { enabled: false };
  }
  return {
    enabled: true,
    model: config.agent.model,
    sessions: runner.sessionCount(),
    instructionFiles,
  };
};

/**
 * Runs one prompt for a chat. Never rejects: callers are event handlers that
 * must answer the user rather than propagate a failure into the transport.
 */
export const runAgent = async (chatId: string, prompt: string): Promise<AgentReply> => {
  initAgent();
  if (runner === null || runner === undefined) {
    return config.agent === null
      ? { ok: false, reason: "disabled" }
      : { ok: false, reason: "misconfigured" };
  }
  return runner.run(chatId, prompt);
};

/** Drops all sessions; used on shutdown so nothing keeps the process alive. */
export const clearAgentSessions = (): void => {
  runner?.clear();
};
