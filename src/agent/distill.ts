/**
 * Extracting memory from a finished turn.
 *
 * The `remember` tool covers what the agent noticed it should keep. This covers
 * what it did not: a second, cheap model call that reads the exchange after the
 * fact and files anything durable. Between them the failure modes are opposite —
 * the tool forgets to fire, the distiller over-collects — so the store dedupes
 * and this prompt is written to prefer recording nothing.
 *
 * It runs detached, after the reply has been handed back: the user waits for
 * their answer, never for the bookkeeping. It therefore owns all of its own
 * error handling and must never reject. A turn lost to a shutdown is a turn not
 * remembered, which is an acceptable price for not delaying a reply.
 */

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

import { logger } from "../logger.ts";
import { PROVIDER_ID, type ModelBinding } from "./model.ts";
import { groupSubject, userSubject, type MemoryStore, type MemorySubject } from "./memory.ts";
import type { ChatRequest } from "./request.ts";

/** Shorter than a chat turn's: this is bookkeeping and must not run long. */
const DISTILL_TIMEOUT_MS = 45_000;
/** A single exchange yielding more than this is over-collecting, not observing. */
const MAX_ENTRIES_PER_TURN = 5;
/** Enough of the turn to judge it by, without resending a long tool transcript. */
const MAX_TRANSCRIPT_CHARS = 6_000;

const SYSTEM_PROMPT = [
  "You extract durable facts from one exchange in a work chat, for an assistant's long-term memory.",
  "",
  "Record only things that will still matter in a month:",
  "- decisions made and the reasoning behind them",
  "- commitments, deadlines and ownership",
  "- stable preferences, working style, tools someone insists on",
  "- a person's role, team, or what they are responsible for",
  "- ongoing projects and their state",
  "",
  "Never record: greetings, small talk, one-off factual questions, anything the assistant",
  "merely explained, or restatements of what is already listed as recorded.",
  "",
  'Reply with a JSON array. Each item is {"about": "user" | "group", "text": "..."}.',
  '"user" means the person who sent the message; "group" means the chat as a whole.',
  "Each text must be one self-contained sentence naming its subject, not a pronoun.",
  `Return at most ${MAX_ENTRIES_PER_TURN} items, and return [] whenever nothing qualifies —`,
  "which is the common case. Reply with the JSON array and nothing else.",
].join("\n");

type DistilledItem = { readonly about: string; readonly text: string };

/** Renders the turn as plain text; tool traffic is summarized, not reproduced. */
const renderTurn = (messages: readonly AgentMessage[]): string => {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");
      lines.push(`USER: ${text}`);
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (text !== "") {
        lines.push(`ASSISTANT: ${text}`);
      }
    } else if (message.role === "toolResult") {
      lines.push("(the assistant used a tool here)");
    }
  }
  return lines.join("\n").slice(0, MAX_TRANSCRIPT_CHARS);
};

/**
 * Pulls the JSON array out of a reply that may be fenced or prefaced.
 *
 * Exported because it is where this file can silently do nothing: a parse that
 * quietly returns `[]` looks exactly like a turn with nothing worth recording.
 */
export const parseItems = (reply: string): DistilledItem[] => {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const items: DistilledItem[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const { about, text } = raw as { about?: unknown; text?: unknown };
    if (typeof text !== "string" || text.trim() === "") {
      continue;
    }
    items.push({ about: about === "group" ? "group" : "user", text });
  }
  return items.slice(0, MAX_ENTRIES_PER_TURN);
};

export type DistillOptions = {
  readonly binding: ModelBinding;
  readonly apiKey: string;
  readonly request: ChatRequest;
  /** The messages this turn produced, in order. */
  readonly messages: readonly AgentMessage[];
  /** Texts the `remember` tool already recorded, so the model is not asked to repeat them. */
  readonly alreadyRecorded: readonly string[];
  readonly memory: MemoryStore;
};

/** Reads one finished turn and files whatever is worth keeping. Never rejects. */
export const distillTurn = async (options: DistillOptions): Promise<void> => {
  const { binding, apiKey, request, messages, alreadyRecorded, memory } = options;

  const transcript = renderTurn(messages);
  if (transcript.trim() === "") {
    return;
  }

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model: binding.model, tools: [] },
    streamFn: binding.models.streamSimple.bind(binding.models),
    getApiKey: (provider) => (provider === PROVIDER_ID ? apiKey : undefined),
  });

  const prompt = [
    alreadyRecorded.length === 0
      ? "Nothing has been recorded from this exchange yet."
      : `Already recorded from this exchange, do not repeat:\n${alreadyRecorded.map((t) => `- ${t}`).join("\n")}`,
    "",
    "The exchange:",
    transcript,
  ].join("\n");

  const startedAt = performance.now();
  const timer = setTimeout(() => agent.abort(), DISTILL_TIMEOUT_MS);
  try {
    await agent.prompt(prompt);
  } catch (err) {
    logger.warn("memory distillation failed", {
      chatId: request.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  } finally {
    clearTimeout(timer);
  }

  const last = agent.state.messages.at(-1);
  if (last === undefined || last.role !== "assistant" || last.stopReason === "aborted") {
    logger.warn("memory distillation produced no usable reply", {
      chatId: request.chatId,
      stopReason: last?.role === "assistant" ? last.stopReason : undefined,
    });
    return;
  }

  const reply = last.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const items = parseItems(reply);

  let recorded = 0;
  for (const item of items) {
    // A group chat with no identifiable sender can still have things recorded
    // about the chat itself; only the per-person half needs an open_id.
    const subject: MemorySubject | null =
      item.about === "group"
        ? groupSubject(request.chatId)
        : request.senderOpenId === null
          ? null
          : userSubject(request.senderOpenId);
    if (subject === null) {
      continue;
    }
    if (
      await memory.remember(
        subject,
        item.text,
        { chatId: request.chatId, chatType: request.chatType },
        "distilled",
      )
    ) {
      recorded += 1;
    }
  }

  logger.info("memory distillation finished", {
    chatId: request.chatId,
    durationMs: Math.round(performance.now() - startedAt),
    proposed: items.length,
    recorded,
    skipped: items.length - recorded,
    costUsd: last.usage.cost.total,
    totalTokens: last.usage.totalTokens,
  });
};
