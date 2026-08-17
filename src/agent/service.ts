/**
 * The application-wide agent instance, wired from configuration.
 *
 * Kept separate from `runner.ts` so the runner stays a plain factory over an
 * injected model binding, and this module owns the one-time resolution and the
 * "not configured" outcomes.
 */

import { config, type HistoryScope } from "../config.ts";
import { logger } from "../logger.ts";
import { createChatDirectory } from "./directory.ts";
import { createHistoryStore } from "./history.ts";
import { loadInstructions } from "./instructions.ts";
import { createMemoryStore } from "./memory.ts";
import { PROVIDER_ID, resolveModel } from "./model.ts";
import type { ChatRequest } from "./request.ts";
import { createAgentRunner, type AgentReply, type AgentRunner } from "./runner.ts";
import { createTranscriptStore } from "./transcript.ts";
import { createWorkspaceProvider } from "./workspace.ts";

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
      /**
       * False when WORKSPACE_DIR could not be created; sessions then run
       * without file or shell tools. The path itself stays out of the response
       * and in the startup log.
       */
      readonly workspaceReady: boolean;
      /**
       * How far the history tools may read across chats. Reported because it
       * is a confidentiality setting, and "which one is this deployment on?"
       * should be answerable without reading the environment off the host.
       */
      readonly historyScope: HistoryScope;
    };

/** `undefined` = not resolved yet, `null` = resolution attempted and failed. */
let runner: AgentRunner | null | undefined;

/** Files from DATA_DIR that contributed to the prompt, captured at init. */
let instructionFiles: readonly string[] = [];

/** Whether the workspace root was usable at init. */
let workspaceReady = false;

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

  // One provider for the whole process; it creates the root now so a bad
  // WORKSPACE_DIR is reported at startup, and a per-chat directory beneath it
  // as each session starts.
  const workspaces = createWorkspaceProvider(config.workspace.root, config.workspace.shellEnv);
  workspaceReady = workspaces.ready;

  // Directories under here are created on demand, as each chat's transcript is
  // first written, so there is nothing to prepare or verify at startup.
  const transcripts = createTranscriptStore(config.sessionDir);
  const memory = createMemoryStore(config.memoryDir);
  // Both read the same root as the transcripts: the directory says which chat
  // each transcript belongs to, and the history store reads them back under
  // the configured scope.
  const directory = createChatDirectory(config.sessionDir);
  const history = createHistoryStore(config.sessionDir, directory, config.historyScope);

  runner = createAgentRunner({
    agentConfig: { ...agentConfig, systemPrompt: instructions.systemPrompt },
    binding: resolution.binding,
    workspaces,
    transcripts,
    memory,
    directory,
    history,
  });
  logger.info("agent ready", {
    provider: PROVIDER_ID,
    model: resolution.binding.model.id,
    contextWindow: resolution.binding.model.contextWindow,
    timeoutMs: agentConfig.timeoutMs,
    dataDir: config.dataDir,
    instructionFiles,
    workspaceRoot: config.workspace.root,
    workspaceReady,
    sessionDir: config.sessionDir,
    chatDirectory: directory.path,
    historyScope: config.historyScope,
    memoryDir: config.memoryDir,
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
    workspaceReady,
    historyScope: config.historyScope,
  };
};

/**
 * Runs one prompt for a chat. Never rejects: callers are event handlers that
 * must answer the user rather than propagate a failure into the transport.
 */
export const runAgent = async (
  request: ChatRequest,
  prompt: string,
): Promise<AgentReply> => {
  initAgent();
  if (runner === null || runner === undefined) {
    return config.agent === null
      ? { ok: false, reason: "disabled" }
      : { ok: false, reason: "misconfigured" };
  }
  return runner.run(request, prompt);
};

/** Drops all sessions; used on shutdown so nothing keeps the process alive. */
export const clearAgentSessions = (): void => {
  runner?.clear();
};
