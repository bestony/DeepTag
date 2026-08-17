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
 * That registry is a cache, not the record. Every session is seeded from, and
 * appended to, the transcript on disk (`transcript.ts`), so a chat dropped by
 * the bounds above — or by a redeploy — picks its conversation back up on the
 * next message. What is bounded is memory, not the conversation.
 *
 * A session also owns a workspace — the directory it works in, and the file and
 * shell tools bound to it. Both are opened when the session is created, which
 * is what "the agent starts in its workspace" means in practice: no session
 * exists without one, and no tool can be called before the directory is there.
 *
 * The runner takes its model binding, workspace provider and transcript store
 * as arguments rather than reading config, so it can be exercised against a
 * faux provider and a temporary directory. `service.ts` wires the
 * application-wide instance.
 */

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

import type { AgentConfig } from "../config.ts";
import { logger } from "../logger.ts";
import { distillTurn } from "./distill.ts";
import {
  groupSubject,
  renderMemoryBlock,
  userSubject,
  MEMORY_PROMPT_LIMIT,
  type MemoryStore,
} from "./memory.ts";
import { createMemoryTools, type TurnContext } from "./memory-tools.ts";
import { PROVIDER_ID, type ModelBinding } from "./model.ts";
import type { ChatRequest } from "./request.ts";
import type { ChatTranscript, TranscriptStore } from "./transcript.ts";
import type { ChatWorkspace, WorkspaceProvider } from "./workspace.ts";

/** Chats held in memory at once; the least recently used is dropped beyond this. */
const MAX_SESSIONS = 200;
/** A chat with no traffic for this long is dropped from memory, not forgotten. */
const SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * Transcript messages kept in the model's context. DeepSeek V4's context window
 * is large, but every turn resends the history, so this caps cost growth on a
 * long chat. It bounds what is *sent*, not what is *stored*: the transcript on
 * disk keeps everything, and this is also how much of it is restored.
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
  run(request: ChatRequest, prompt: string): Promise<AgentReply>;
  sessionCount(): number;
  /** Aborts in-flight runs and drops all sessions. */
  clear(): void;
};

/** A chat's live session: created once, reused by every run for that chat. */
type Session = {
  readonly agent: Agent;
  readonly workspace: ChatWorkspace;
  readonly transcript: ChatTranscript;
  /**
   * Rewritten before each run. The session belongs to a chat, but the speaker
   * belongs to a message, and the memory tools need the latter.
   */
  readonly turn: TurnContext;
  /** Base prompt for this session — instructions plus workspace, memory aside. */
  readonly basePrompt: string;
};

/**
 * A chat's registry entry.
 *
 * Separate from `Session` because opening one is asynchronous — it reads the
 * transcript off disk — while the bookkeeping that keeps concurrent runs in
 * order must happen synchronously, before any `await` gives a second message
 * the chance to interleave. Holding the *promise* of a session is what lets
 * both be true: two messages arriving at once queue against the same tail and
 * then await the same open.
 */
type Slot = {
  /** Resolves to the session; rejects only if opening it failed outright. */
  readonly session: Promise<Session>;
  lastUsedAt: number;
  /** Tail of this chat's run chain; see the serialization note above. */
  tail: Promise<unknown>;
};

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

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
  transcripts: TranscriptStore,
  memory: MemoryStore,
): AgentRunner => {
  const slots = new Map<string, Slot>();

  /**
   * Drops a chat from memory and releases what it holds. Neither the workspace
   * directory nor the transcript is deleted: this frees memory and stops stray
   * child processes, it does not end the conversation.
   */
  const dropSlot = (chatId: string, slot: Slot): void => {
    slots.delete(chatId);
    // The session may still be opening; wait for it rather than leaking
    // whatever it is about to create.
    void slot.session.then(
      (session) => {
        session.agent.abort();
        return session.workspace.cleanup();
      },
      () => undefined,
    );
  };

  const evictStaleSlots = (now: number): void => {
    for (const [chatId, slot] of slots) {
      if (now - slot.lastUsedAt > SESSION_TTL_MS) {
        dropSlot(chatId, slot);
        logger.debug("agent session expired, transcript kept", { chatId });
      }
    }
    // Map iterates in insertion order and every use re-inserts, so the first
    // key is the least recently used.
    while (slots.size > MAX_SESSIONS) {
      const oldest = slots.entries().next();
      if (oldest.done === true) {
        break;
      }
      const [chatId, slot] = oldest.value;
      dropSlot(chatId, slot);
      logger.debug("agent session evicted, session limit reached, transcript kept", {
        chatId,
        limit: MAX_SESSIONS,
      });
    }
  };

  const openSession = async (request: ChatRequest): Promise<Session> => {
    const chatId = request.chatId;
    // Opened before the Agent exists, so the directory is on disk before the
    // model can be told about it, let alone call a tool against it.
    const workspace = workspaces.open(chatId);
    // Keyed on the workspace directory, which is this chat's stable identity.
    const transcript = await transcripts.open(chatId, workspace.dir, MAX_HISTORY_MESSAGES);

    // The workspace block goes after the instructions: it describes where this
    // session is running, which is the most concrete and least general thing
    // the model is told, and the only part that differs between chats.
    const basePrompt =
      workspace.prompt === ""
        ? agentConfig.systemPrompt
        : `${agentConfig.systemPrompt}\n\n${workspace.prompt}`;

    const turn: TurnContext = { request, written: [] };

    const agent = new Agent({
      initialState: {
        // Replaced before every run by `composePrompt`, which appends the
        // memory of whoever is speaking. This is only the starting value.
        systemPrompt: basePrompt,
        model: binding.model,
        tools: [...workspace.tools, ...createMemoryTools(memory, () => turn)],
        // What makes this a resumed conversation rather than a new one.
        messages: [...transcript.messages],
      },
      streamFn: binding.models.streamSimple.bind(binding.models),
      transformContext: async (messages) => pruneHistory(messages),
      // Supplying the key keeps config.ts the only module reading process.env;
      // pi-ai would otherwise resolve DEEPSEEK_API_KEY on its own.
      getApiKey: (provider) => (provider === PROVIDER_ID ? agentConfig.apiKey : undefined),
      // Lets the provider scope any prompt caching to this chat.
      sessionId: chatId,
    });

    logger.debug("agent session opened", {
      chatId,
      sessions: slots.size,
      resumed: transcript.resumed,
      restoredMessages: transcript.messages.length,
      workspaceDir: workspace.dir,
      workspaceReady: workspace.ready,
      tools: agent.state.tools.map((tool) => tool.name),
    });
    return { agent, workspace, transcript, turn, basePrompt };
  };

  const getSlot = (request: ChatRequest): Slot => {
    const chatId = request.chatId;
    const now = Date.now();
    evictStaleSlots(now);

    const existing = slots.get(chatId);
    if (existing !== undefined) {
      existing.lastUsedAt = now;
      // Re-insert to mark as most recently used.
      slots.delete(chatId);
      slots.set(chatId, existing);
      return existing;
    }

    // Registered synchronously, so a second message arriving while this one is
    // still reading the transcript joins the same session instead of opening a
    // second one over the same files.
    const created: Slot = {
      session: openSession(request),
      lastUsedAt: now,
      tail: Promise.resolve(),
    };
    slots.set(chatId, created);
    return created;
  };

  /**
   * Builds the system prompt for one turn: the session's fixed part, then who
   * is speaking and what is remembered about them and about this chat.
   *
   * Memory belongs in the system prompt rather than in the user message, for
   * two reasons. It is instruction, not conversation. And the system prompt is
   * never written to the transcript, so a snapshot of memory taken today does
   * not sit in the history forever, being resent long after it went stale.
   */
  const composePrompt = async (session: Session, request: ChatRequest): Promise<string> => {
    const [speakerEntries, chatEntries] = await Promise.all([
      request.senderOpenId === null
        ? Promise.resolve([])
        : memory.recall(userSubject(request.senderOpenId), request, { limit: MEMORY_PROMPT_LIMIT }),
      memory.recall(groupSubject(request.chatId), request, { limit: MEMORY_PROMPT_LIMIT }),
    ]);

    const identity = [
      "<conversation>",
      request.chatType === "p2p"
        ? "This is a private chat with one person."
        : "This is a group chat, and the person speaking can differ from message to message.",
      request.senderOpenId === null
        ? "The current message carries no sender open_id, so you cannot record anything about the speaker."
        : `The current message is from open_id ${request.senderOpenId}.`,
      "</conversation>",
    ].join("\n");

    // Empty blocks render as "", so a stranger's first message carries no
    // memory scaffolding at all.
    return [
      session.basePrompt,
      identity,
      renderMemoryBlock(
        "speaker_memory",
        "What you have recorded about the person speaking now, newest first. Use it; do not recite it back at them.",
        speakerEntries,
      ),
      renderMemoryBlock(
        "chat_memory",
        "What you have recorded about this chat, newest first.",
        chatEntries,
      ),
    ]
      .filter((block) => block !== "")
      .join("\n\n");
  };

  const execute = async (
    session: Session,
    request: ChatRequest,
    prompt: string,
  ): Promise<AgentReply> => {
    const chatId = request.chatId;
    // Rewritten per run: in a group the speaker changes, and both the memory
    // tools and the prompt below must follow that rather than the session.
    session.turn.request = request;
    session.turn.written = [];
    session.agent.state.systemPrompt = await composePrompt(session, request);

    const startedAt = performance.now();
    // Everything appended from here on belongs to this run: it is both what
    // gets persisted below and how the tool calls are counted.
    const messagesBefore = session.agent.state.messages.length;
    // abort() rather than racing a rejection: it also stops the provider stream.
    const timer = setTimeout(() => session.agent.abort(), agentConfig.timeoutMs);

    let failure: { readonly error: unknown } | undefined;
    try {
      await session.agent.prompt(prompt);
    } catch (err) {
      failure = { error: err };
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const produced = session.agent.state.messages.slice(messagesBefore);

    // Persisted before answering, and on the failure path too: the file should
    // mirror the transcript in memory, and a turn that failed halfway is still
    // part of the conversation. Awaited rather than fired and forgotten, so a
    // crash just after the reply cannot lose the exchange it was replying to.
    await session.transcript.append(produced);

    if (failure !== undefined) {
      logger.error("agent run threw", {
        chatId,
        durationMs,
        error: describeError(failure.error),
        stack: failure.error instanceof Error ? failure.error.stack : undefined,
      });
      return { ok: false, reason: "failed", detail: describeError(failure.error) };
    }

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
      toolCalls: produced.filter((message) => message.role === "toolResult").length,
      persistedMessages: produced.length,
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
    // Only a turn that actually answered is worth distilling. Note that a
    // provider failure does not throw — it comes back as `stopReason: "error"` —
    // so this has to sit past every check above, or every broken turn would
    // cost a second model call to mine an exchange that never happened.
    //
    // Detached on purpose: it is that second model call, and the user is
    // waiting. `distillTurn` never rejects, so it cannot surface as an
    // unhandled rejection.
    void distillTurn({
      binding,
      apiKey: agentConfig.apiKey,
      request,
      messages: produced,
      alreadyRecorded: [...session.turn.written],
      memory,
    });

    return { ok: true, text };
  };

  return {
    run: async (request, prompt) => {
      const slot = getSlot(request);
      // Queue behind this chat's previous run. `execute` resolves rather than
      // rejects, so the chain cannot be poisoned by one bad run.
      const started = slot.tail.then(async () => execute(await slot.session, request, prompt));
      slot.tail = started.catch(() => undefined);

      try {
        return await started;
      } catch (err) {
        // Only opening the session can land here. Drop the slot so the next
        // message retries instead of inheriting a permanently broken one.
        slots.delete(request.chatId);
        logger.error("agent session could not be opened", {
          chatId: request.chatId,
          error: describeError(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return { ok: false, reason: "failed", detail: describeError(err) };
      }
    },
    sessionCount: () => slots.size,
    clear: () => {
      for (const [chatId, slot] of slots) {
        dropSlot(chatId, slot);
      }
    },
  };
};
