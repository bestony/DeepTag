/**
 * Reading the conversations DeepTag has had — this chat's, and other chats'.
 *
 * `transcript.ts` owns the write side and the one transcript a live session
 * resumes from. This is the read side, and it is deliberately a different
 * module with a different shape: it never creates or appends, it spans every
 * chat rather than one, and it answers two questions the runner never asks —
 * "which chats are there" and "what was said in that one".
 *
 * Why it exists: a bot that answers each chat in isolation cannot do the thing
 * a colleague does without thinking — carry what one group is working on into a
 * conversation with another. Memory (`memory.ts`) carries the distilled facts;
 * this carries the conversation itself, including the parts nobody thought to
 * distil, and reaches further back than the 60 messages a turn resends.
 *
 * ## Visibility
 *
 * The rule mirrors `memory.ts`, because the exposure is the same one and two
 * different answers to it would be a bug waiting to happen:
 *
 * - a chat's own history is always readable in that chat;
 * - a *group* chat's history is readable from anywhere, under the default
 *   `shared-groups` scope — it was said in front of others;
 * - a *private* chat's history is readable only in that same private chat.
 *
 * `own-chat` narrows this to the first rule alone, for a deployment that wants
 * no cross-talk at all. Note what `shared-groups` implies, because it is not
 * subtle: anyone who can message the bot privately can read back any group
 * transcript the bot sits in. That is the price of the colleague behaviour, and
 * it is why the scope is configurable.
 *
 * Chats with no entry in the directory (`directory.ts`) are invisible rather
 * than assumed public: without a record there is no chat type, and a rule that
 * cannot be evaluated has to fail closed.
 *
 * ## Reading the files
 *
 * Transcripts are parsed here rather than through the library's session
 * storage, for one specific reason: loading a session *repairs* a torn tail by
 * rewriting the file, and these files are being appended to by live sessions. A
 * read must never be able to truncate a transcript another chat is still
 * writing. So discovery goes through the repo — which only ever reads header
 * lines — while the bodies are streamed line by line here, with anything
 * unparseable skipped, exactly as `memory.ts` treats its own log.
 *
 * The root is taken as an argument rather than read from `config`, so this can
 * be pointed at a temporary directory in a test. Nothing here throws.
 */

import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import type { HistoryScope } from "../config.ts";
import { logger } from "../logger.ts";
import type { ChatDirectory, ChatRecord } from "./directory.ts";
import type { ChatRequest } from "./request.ts";
import { SPEAKER_ENTRY_TYPE } from "./transcript.ts";

/** Default and ceiling for how many chats one listing returns. */
export const HISTORY_CHATS_LIMIT = 15;
export const HISTORY_CHATS_MAX_LIMIT = 50;
/** Default and ceiling for how many messages one read returns. */
export const HISTORY_MESSAGES_LIMIT = 30;
export const HISTORY_MESSAGES_MAX_LIMIT = 150;

/**
 * Transcripts opened for a single listing. Listing is the only call that can
 * touch every chat at once, so this is what keeps its cost proportional to
 * something other than the number of chats the bot has ever been in.
 */
const MAX_SCANNED_CHATS = 60;
/** Characters kept per message. Long enough to be a quote, short enough to skim. */
const MAX_ITEM_CHARS = 400;
/**
 * Ceiling on one tool result. A chat's history is unbounded and the context
 * window is not; the oldest lines are dropped first, and the model is told.
 */
const MAX_OUTPUT_CHARS = 8_000;

/**
 * What one line of rendered history is. `tool` collapses a whole round of tool
 * traffic into the names used: replaying another chat's shell output verbatim
 * would be noise at best, and a second copy of whatever it printed at worst.
 */
export type HistoryItemKind = "user" | "assistant" | "tool";

export type HistoryItem = {
  readonly at: number;
  readonly kind: HistoryItemKind;
  /** Lark `open_id` of whoever spoke, when the transcript recorded one. */
  readonly speaker: string | null;
  readonly text: string;
};

export type ChatSummary = {
  readonly chat: ChatRecord;
  /** Messages in the whole transcript, not just the window that was kept. */
  readonly messages: number;
  readonly lastActivityAt: number;
  /** Newest item, or newest matching item when a query was given. */
  readonly preview: HistoryItem | null;
  readonly isCurrent: boolean;
};

export type ChatWindow = {
  readonly chat: ChatRecord;
  readonly messages: number;
  readonly lastActivityAt: number;
  /** Items matching the query across the whole transcript, before windowing. */
  readonly matches: number;
  /** Oldest first, at most the requested limit. */
  readonly items: readonly HistoryItem[];
  readonly isCurrent: boolean;
};

export type ListChatsOptions = {
  /** Case-insensitive substring; drops chats whose history never mentions it. */
  readonly query?: string;
  readonly limit?: number;
};

export type ReadChatOptions = {
  /** Defaults to the chat the request came from. */
  readonly chatId?: string;
  readonly query?: string;
  readonly limit?: number;
};

export type HistoryStore = {
  readonly root: string;
  readonly scope: HistoryScope;
  /** Chats this request may read, most recently active first. Never rejects. */
  listChats(request: ChatRequest, options?: ListChatsOptions): Promise<ChatSummary[]>;
  /**
   * One chat's conversation. `null` when no such chat is visible from this
   * request — unknown and forbidden deliberately look the same. Never rejects.
   */
  readChat(request: ChatRequest, options?: ReadChatOptions): Promise<ChatWindow | null>;
};

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const bounded = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 1), max);
};

/** Blank and absent mean the same thing for every optional string here. */
const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
};

const truncate = (text: string): string =>
  text.length <= MAX_ITEM_CHARS ? text : `${text.slice(0, MAX_ITEM_CHARS)}…`;

/** Newlines would break the one-line-per-message rendering the model reads. */
const flatten = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim();

/**
 * The rule described at the top of this file. Exported because it is the whole
 * of the confidentiality boundary, and a boundary worth testing on its own.
 */
export const isChatVisible = (
  chat: ChatRecord,
  request: ChatRequest,
  scope: HistoryScope,
): boolean => {
  if (chat.chatId === request.chatId) {
    return true;
  }
  return scope === "shared-groups" && chat.chatType === "group";
};

/**
 * Content blocks of a stored message.
 *
 * Everything below reads the JSON by hand rather than trusting it into
 * `AgentMessage`, because these files are read from disk and may have been
 * written by an older build, edited, or half-flushed. A malformed entry must
 * cost that entry, not the rest of the transcript behind it.
 */
const blocksOf = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content)
    ? content
        .map(asObject)
        .filter((block): block is Record<string, unknown> => block !== null)
    : [];

const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  return blocksOf(content)
    .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
    .map((block) => block["text"] as string)
    .join("");
};

/**
 * Turns one stored message into what a reader should see. An assistant turn can
 * yield two items — what it said, and what it then went and did — because those
 * are separately interesting when catching up on a conversation.
 */
const renderMessage = (
  message: Record<string, unknown>,
  speaker: string | null,
  fallbackAt: number,
): HistoryItem[] => {
  const at = typeof message["timestamp"] === "number" ? message["timestamp"] : fallbackAt;
  const role = message["role"];

  if (role === "user") {
    const text = flatten(textOf(message["content"]));
    return text === "" ? [] : [{ at, kind: "user", speaker, text: truncate(text) }];
  }
  if (role !== "assistant") {
    // toolResult, and anything unrecognized: the assistant's own tool calls
    // below already say what happened, without reproducing the output.
    return [];
  }

  const items: HistoryItem[] = [];
  const text = flatten(textOf(message["content"]));
  if (text !== "") {
    items.push({ at, kind: "assistant", speaker: null, text: truncate(text) });
  }

  const tools = [
    ...new Set(
      blocksOf(message["content"])
        .filter((block) => block["type"] === "toolCall" && typeof block["name"] === "string")
        .map((block) => block["name"] as string),
    ),
  ];
  if (tools.length > 0) {
    items.push({ at, kind: "tool", speaker: null, text: tools.join(", ") });
  }
  return items;
};

/** Reads the `openId` out of a `speaker` entry's payload, tolerating anything else. */
const readSpeaker = (data: unknown): string | null => {
  const openId = asObject(data)?.["openId"];
  return typeof openId === "string" && openId !== "" ? openId : null;
};

type ScanOptions = {
  /** How many items to keep. The newest are kept; the rest are counted only. */
  readonly limit: number;
  readonly query?: string;
};

type TranscriptScan = {
  /** Oldest first, at most `limit` items. */
  readonly items: HistoryItem[];
  readonly messages: number;
  readonly matches: number;
  readonly lastActivityAt: number;
};

const EMPTY_SCAN: TranscriptScan = { items: [], messages: 0, matches: 0, lastActivityAt: 0 };

/**
 * Streams one transcript, keeping a window of the newest items and counting the
 * rest. Streamed rather than read whole because a chat that has run a lot of
 * shell commands has a large transcript, while the window stays small whatever
 * the file size.
 *
 * Never rejects: a transcript that cannot be read reads as empty, which for a
 * tool answering "what were they talking about" is the right kind of wrong.
 */
const scanTranscript = async (path: string, options: ScanOptions): Promise<TranscriptScan> => {
  const needle = options.query?.toLowerCase();
  const items: HistoryItem[] = [];
  let messages = 0;
  let matches = 0;
  let lastActivityAt = 0;
  let skipped = 0;
  let speaker: string | null = null;

  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      if (line.trim() === "") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A file another session is mid-append to can present a torn last
        // line. Skipping it is the whole reason this parses by hand.
        skipped += 1;
        continue;
      }

      const raw = asObject(parsed);
      if (raw === null || raw["kind"] !== "entry") {
        continue;
      }
      const lane = raw["lane"];
      if (lane !== undefined && lane !== "main") {
        continue;
      }

      const at = typeof raw["timestamp"] === "number" ? raw["timestamp"] : 0;
      if (at > lastActivityAt) {
        lastActivityAt = at;
      }

      const type = raw["type"];
      if (type === "custom") {
        if (raw["customType"] === SPEAKER_ENTRY_TYPE) {
          speaker = readSpeaker(raw["data"]);
        }
        continue;
      }
      if (type !== "message") {
        continue;
      }
      const message = asObject(raw["message"]);
      if (message === null) {
        skipped += 1;
        continue;
      }
      // Tool results are part of the record but not of the conversation, and
      // counting them would make a chat look far busier than it reads.
      if (message["role"] === "user" || message["role"] === "assistant") {
        messages += 1;
      }

      for (const item of renderMessage(message, speaker, at)) {
        if (needle !== undefined && !item.text.toLowerCase().includes(needle)) {
          continue;
        }
        matches += 1;
        items.push(item);
        if (items.length > options.limit) {
          items.shift();
        }
      }
    }
  } catch (err) {
    // Including ENOENT: a directory entry can outlive its transcript.
    logger.debug("transcript could not be read in full", {
      path,
      itemsSoFar: items.length,
      error: describeError(err),
    });
  } finally {
    lines.close();
    stream.destroy();
  }

  if (skipped > 0) {
    logger.debug("transcript had unreadable lines, skipping them", { path, skipped });
  }
  return { items, messages, matches, lastActivityAt };
};

type Transcript = { readonly path: string; readonly modifiedAt: number };

export const createHistoryStore = (
  root: string,
  directory: ChatDirectory,
  scope: HistoryScope,
): HistoryStore => {
  // The same repo the transcript store uses, but only ever for `list`, which
  // reads header lines and never opens — see the note at the top of this file.
  const repo = new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd: root }),
    sessionsRoot: root,
  });

  /**
   * The newest transcript for each workspace directory. Normally there is one;
   * a crash mid-create can leave more, and the newest is the live one.
   */
  const transcriptsByCwd = async (cwd?: string): Promise<Map<string, Transcript>> => {
    let sessions;
    try {
      sessions = cwd === undefined ? await repo.list() : await repo.list({ cwd });
    } catch (err) {
      logger.error("transcripts could not be listed, history is unavailable", {
        root,
        cwd,
        error: describeError(err),
      });
      return new Map();
    }

    // `list` returns newest modification first, so the first hit per directory
    // is the one to keep.
    const newest = new Map<string, Transcript>();
    for (const session of sessions) {
      const key = resolve(session.cwd);
      if (!newest.has(key)) {
        newest.set(key, { path: session.path, modifiedAt: session.modifiedAt });
      }
    }
    return newest;
  };

  const listChats: HistoryStore["listChats"] = async (request, options = {}) => {
    const limit = bounded(options.limit, HISTORY_CHATS_LIMIT, HISTORY_CHATS_MAX_LIMIT);
    const query = trimmed(options.query);

    const [chats, transcripts] = await Promise.all([directory.list(), transcriptsByCwd()]);

    const candidates: { chat: ChatRecord; transcript: Transcript }[] = [];
    const recognized = new Set<string>();
    let hidden = 0;
    for (const chat of chats) {
      const key = resolve(chat.cwd);
      const transcript = transcripts.get(key);
      if (transcript !== undefined) {
        recognized.add(key);
      }
      if (!isChatVisible(chat, request, scope)) {
        hidden += 1;
        continue;
      }
      if (transcript === undefined) {
        // Recorded but never written to: a chat whose first turn is still in
        // flight, or one whose transcript has been removed.
        continue;
      }
      candidates.push({ chat, transcript });
    }

    // Ordered by file modification, which is free, and only the cheapest end of
    // the list is opened. The survivors are re-sorted below on what was read.
    candidates.sort((a, b) => b.transcript.modifiedAt - a.transcript.modifiedAt);
    const scanned = candidates.slice(0, MAX_SCANNED_CHATS);

    const scans = await Promise.all(
      scanned.map(async (candidate) =>
        scanTranscript(candidate.transcript.path, {
          limit: 1,
          ...(query === undefined ? {} : { query }),
        }),
      ),
    );

    const summaries: ChatSummary[] = [];
    for (const [index, scan] of scans.entries()) {
      const candidate = scanned[index];
      if (candidate === undefined) {
        continue;
      }
      if (query !== undefined && scan.matches === 0) {
        continue;
      }
      summaries.push({
        chat: candidate.chat,
        messages: scan.messages,
        lastActivityAt:
          scan.lastActivityAt === 0 ? candidate.transcript.modifiedAt : scan.lastActivityAt,
        preview: scan.items.at(-1) ?? null,
        isCurrent: candidate.chat.chatId === request.chatId,
      });
    }
    summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const returned = summaries.slice(0, limit);

    logger.debug("chat history listed", {
      chatId: request.chatId,
      scope,
      query,
      known: chats.length,
      hidden,
      // Transcripts on disk that no directory entry claims: chats whose session
      // has not been opened since the directory existed. They stay invisible.
      unrecorded: transcripts.size - recognized.size,
      scanned: scanned.length,
      dropped: candidates.length - scanned.length,
      matched: summaries.length,
      returned: returned.length,
    });
    return returned;
  };

  const readChat: HistoryStore["readChat"] = async (request, options = {}) => {
    const limit = bounded(options.limit, HISTORY_MESSAGES_LIMIT, HISTORY_MESSAGES_MAX_LIMIT);
    const query = trimmed(options.query);
    const target = trimmed(options.chatId) ?? request.chatId;

    const chat = (await directory.list()).find((entry) => entry.chatId === target);
    if (chat === undefined || !isChatVisible(chat, request, scope)) {
      logger.debug("chat history refused", {
        chatId: request.chatId,
        scope,
        target,
        reason: chat === undefined ? "unknown chat" : "not visible from here",
      });
      return null;
    }

    const transcript = (await transcriptsByCwd(chat.cwd)).get(resolve(chat.cwd));
    const scan =
      transcript === undefined
        ? EMPTY_SCAN
        : await scanTranscript(transcript.path, {
            limit,
            ...(query === undefined ? {} : { query }),
          });

    logger.debug("chat history read", {
      chatId: request.chatId,
      scope,
      target,
      query,
      limit,
      messages: scan.messages,
      matches: scan.matches,
      returned: scan.items.length,
    });

    return {
      chat,
      messages: scan.messages,
      lastActivityAt: scan.lastActivityAt,
      matches: scan.matches,
      items: scan.items,
      isCurrent: chat.chatId === request.chatId,
    };
  };

  return { root, scope, listChats, readChat };
};

/** UTC, minute precision: enough to order a conversation, short enough to repeat. */
const formatAt = (at: number): string =>
  at === 0 ? "unknown" : new Date(at).toISOString().slice(0, 16).replace("T", " ");

const renderItem = (item: HistoryItem): string => {
  const stamp = `[${formatAt(item.at)}]`;
  if (item.kind === "assistant") {
    return `${stamp} you: ${item.text}`;
  }
  if (item.kind === "tool") {
    return `${stamp} you used: ${item.text}`;
  }
  // The open_id is spelled out rather than abbreviated: it is what `remember`
  // and `recall` take, so a name the model can act on beats a tidy one.
  return `${stamp} ${item.speaker ?? "someone"}: ${item.text}`;
};

/**
 * Renders lines newest first until the budget runs out, then puts them back in
 * reading order. Dropping the oldest is what keeps a long window useful rather
 * than merely cut off at an arbitrary point.
 */
const withinBudget = (lines: readonly string[]): { lines: string[]; dropped: number } => {
  const kept: string[] = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (kept.length > 0 && chars + line.length > MAX_OUTPUT_CHARS) {
      return { lines: kept.reverse(), dropped: index + 1 };
    }
    chars += line.length + 1;
    kept.push(line);
  }
  return { lines: kept.reverse(), dropped: 0 };
};

const describeType = (chat: ChatRecord): string => (chat.chatType === "p2p" ? "private" : "group");

export const renderChatList = (
  summaries: readonly ChatSummary[],
  query: string | undefined,
): string => {
  if (summaries.length === 0) {
    return query === undefined
      ? "No chats are visible from here yet."
      : `No visible chat mentions ${JSON.stringify(query)}.`;
  }

  const lines = summaries.map((summary) => {
    const head = [
      summary.chat.chatId,
      describeType(summary.chat),
      `${summary.messages} messages`,
      `last active ${formatAt(summary.lastActivityAt)}`,
      ...(summary.isCurrent ? ["this chat"] : []),
    ].join(" · ");
    return summary.preview === null ? `- ${head}` : `- ${head}\n  ${renderItem(summary.preview)}`;
  });

  return [
    `${summaries.length} chat(s)${query === undefined ? "" : ` mentioning ${JSON.stringify(query)}`}, most recently active first. Times are UTC.`,
    "",
    ...lines,
  ].join("\n");
};

export const renderChatWindow = (window: ChatWindow, query: string | undefined): string => {
  const heading = [
    `Chat ${window.chat.chatId}`,
    `· ${describeType(window.chat)}${window.isCurrent ? ", this chat" : ""}`,
    `· ${window.messages} messages`,
    `· last active ${formatAt(window.lastActivityAt)} UTC`,
  ].join(" ");

  if (window.items.length === 0) {
    return query === undefined
      ? `${heading}\n\nNothing has been said in it yet.`
      : `${heading}\n\nNothing in it matches ${JSON.stringify(query)}.`;
  }

  const budgeted = withinBudget(window.items.map(renderItem));
  // Lines, not messages: a round of tool use is a line of its own, so the two
  // counts differ and the heading's "N messages" should not be read as this.
  const lead =
    query === undefined
      ? `Showing the last ${budgeted.lines.length} lines, oldest first.`
      : `Showing ${budgeted.lines.length} of ${window.matches} lines matching ${JSON.stringify(query)}, oldest first.`;

  return [
    heading,
    budgeted.dropped === 0
      ? lead
      : `${lead} ${budgeted.dropped} older line(s) did not fit — search this chat with a query to reach them.`,
    "",
    ...budgeted.lines,
  ].join("\n");
};
