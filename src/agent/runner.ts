/**
 * Agent sessions, one per chat.
 *
 * The `Agent` from pi-agent-core is stateful — it owns the transcript — so a
 * chat's conversation continuity is just "reuse that chat's Agent". Two things
 * follow, and both are handled here:
 *
 * - the registry must be bounded, or a busy tenant leaks memory one chat at a
 *   time;
 * - runs for one chat must be serialized, because driving a single stateful
 *   Agent from two concurrent messages interleaves their transcripts.
 *
 * A session also owns a workspace — the directory it works in, and the file and
 * shell tools bound to it. Both are opened when the session is created, which
 * is what "the agent starts in its workspace" means in practice: no session
 * exists without one, and no tool can be called before the directory is there.
 *
 * The runner takes its model binding and workspace provider as arguments rather
 * than reading config, so it can be exercised against a faux provider and a
 * temporary directory. `service.ts` wires the application-wide instance.
 */

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

import type { AgentConfig } from "../config.ts";
import { logger } from "../logger.ts";
import { PROVIDER_ID, type ModelBinding } from "./model.ts";
import type { ChatWorkspace, WorkspaceProvider } from "./workspace.ts";

/** Chats tracked at once; the least recently used is dropped beyond this. */
const MAX_SESSIONS = 200;
/** A chat with no traffic for this long starts fresh next time. */
const SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * Transcript messages kept per chat. DeepSeek V4's context window is large, but
 * every turn resends the history, so this caps cost growth on a long chat.
 */
const MAX_HISTORY_MESSAGES = 60;

export type AgentReply =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      /**
       * `disabled`: no API key. `misconfigured`: key present, model unusable.
       * `timeout`: exceeded AGENT_TIMEOUT_MS. `failed`: everything else.
       */
      readonly reason: "disabled" | "misconfigured" | "timeout" | "failed";
      readonly detail?: string;
    };

export type AgentRunner = {
  /** Runs one prompt for a chat. Never rejects. */
  run(chatId: string, prompt: string): Promise<AgentReply>;
  sessionCount(): number;
  /** Aborts in-flight runs and drops all sessions. */
  clear(): void;
};

type Session = {
  readonly agent: Agent;
  readonly workspace: ChatWorkspace;
  lastUsedAt: number;
  /** Tail of this chat's run chain; see the serialization note above. */
  tail: Promise<unknown>;
};

/**
 * Drops the oldest history while making sure the surviving transcript never
 * begins with a `toolResult`, which would be an orphan without the assistant
 * message that requested it.
 */
const pruneHistory = (messages: AgentMessage[]): AgentMessage[] => {
  if (messages.length <= MAX_HISTORY_MESSAGES) {
    return messages;
  }
  let start = messages.length - MAX_HISTORY_MESSAGES;
  while (start < messages.length && messages[start]?.role === "toolResult") {
    start += 1;
  }
  return messages.slice(start);
};

const extractText = (message: AgentMessage): string => {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
};

export const createAgentRunner = (
  agentConfig: AgentConfig,
  binding: ModelBinding,
  workspaces: WorkspaceProvider,
): AgentRunner => {
  const sessions = new Map<string, Session>();

  /**
   * Drops a session and releases its workspace. The directory itself stays on
   * disk — only the transcript and any processes the shell tool left running
   * are discarded.
   */
  const dropSession = (chatId: string, session: Session): void => {
    sessions.delete(chatId);
    session.agent.abort();
    void session.workspace.cleanup();
  };

  const evictStaleSessions = (now: number): void => {
    for (const [chatId, session] of sessions) {
      if (now - session.lastUsedAt > SESSION_TTL_MS) {
        dropSession(chatId, session);
        logger.debug("agent session expired", { chatId });
      }
    }
    // Map iterates in insertion order and every use re-inserts, so the first
    // key is the least recently used.
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.entries().next();
      if (oldest.done === true) {
        break;
      }
      const [chatId, session] = oldest.value;
      dropSession(chatId, session);
      logger.debug("agent session evicted, session limit reached", {
        chatId,
        limit: MAX_SESSIONS,
      });
    }
  };

  const getSession = (chatId: string): Session => {
    const now = Date.now();
    evictStaleSessions(now);

    const existing = sessions.get(chatId);
    if (existing !== undefined) {
      existing.lastUsedAt = now;
      // Re-insert to mark as most recently used.
      sessions.delete(chatId);
      sessions.set(chatId, existing);
      return existing;
    }

    // Opened before the Agent exists, so the directory is on disk before the
    // model can be told about it, let alone call a tool against it.
    const workspace = workspaces.open(chatId);

    const agent = new Agent({
      initialState: {
        // The workspace block goes last: it describes where this session is
        // running, which is the most concrete and least general instruction the
        // model has, and it is the only part that differs between chats.
        systemPrompt:
          workspace.prompt === ""
            ? agentConfig.systemPrompt
            : `${agentConfig.systemPrompt}\n\n${workspace.prompt}`,
        model: binding.model,
        tools: [...workspace.tools],
      },
      streamFn: binding.models.streamSimple.bind(binding.models),
      transformContext: async (messages) => pruneHistory(messages),
      // Supplying the key keeps config.ts the only module reading process.env;
      // pi-ai would otherwise resolve DEEPSEEK_API_KEY on its own.
      getApiKey: (provider) => (provider === PROVIDER_ID ? agentConfig.apiKey : undefined),
      // Lets the provider scope any prompt caching to this chat.
      sessionId: chatId,
    });

    const created: Session = { agent, workspace, lastUsedAt: now, tail: Promise.resolve() };
    sessions.set(chatId, created);
    logger.debug("agent session created", {
      chatId,
      sessions: sessions.size,
      workspaceDir: workspace.dir,
      tools: workspace.tools.map((tool) => tool.name),
    });
    return created;
  };

  const execute = async (
    session: Session,
    chatId: string,
    prompt: string,
  ): Promise<AgentReply> => {
    const startedAt = performance.now();
    // Everything appended from here on belongs to this run, which is how the
    // tool calls below are counted.
    const messagesBefore = session.agent.state.messages.length;
    // abort() rather than racing a rejection: it also stops the provider stream.
    const timer = setTimeout(() => session.agent.abort(), agentConfig.timeoutMs);

    try {
      await session.agent.prompt(prompt);
    } catch (err) {
      logger.error("agent run threw", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {
        ok: false,
        reason: "failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const last = session.agent.state.messages.at(-1);

    if (last === undefined || last.role !== "assistant") {
      logger.error("agent run produced no assistant message", { chatId, durationMs });
      return { ok: false, reason: "failed", detail: "no assistant message" };
    }

    logger.info("agent run finished", {
      chatId,
      model: last.model,
      stopReason: last.stopReason,
      durationMs,
      workspaceDir: session.workspace.dir,
      // A turn that used tools takes several model round-trips, so this is the
      // first thing to look at when a run is slow or hits the timeout.
      toolCalls: session.agent.state.messages
        .slice(messagesBefore)
        .filter((message) => message.role === "toolResult").length,
      inputTokens: last.usage.input,
      outputTokens: last.usage.output,
      reasoningTokens: last.usage.reasoning,
      totalTokens: last.usage.totalTokens,
      costUsd: last.usage.cost.total,
      historyMessages: session.agent.state.messages.length,
    });

    if (last.stopReason === "aborted") {
      return { ok: false, reason: "timeout", detail: `exceeded ${agentConfig.timeoutMs}ms` };
    }
    if (last.stopReason === "error") {
      return { ok: false, reason: "failed", detail: last.errorMessage ?? "model reported an error" };
    }

    const text = extractText(last);
    if (text === "") {
      return {
        ok: false,
        reason: "failed",
        detail: `model returned no text (stopReason: ${last.stopReason})`,
      };
    }
    return { ok: true, text };
  };

  return {
    run: async (chatId, prompt) => {
      const session = getSession(chatId);
      // Queue behind this chat's previous run. `execute` resolves rather than
      // rejects, so the chain cannot be poisoned by one bad run.
      const started = session.tail.then(() => execute(session, chatId, prompt));
      session.tail = started.catch(() => undefined);
      return started;
    },
    sessionCount: () => sessions.size,
    clear: () => {
      for (const [chatId, session] of sessions) {
        dropSession(chatId, session);
      }
    },
  };
};
