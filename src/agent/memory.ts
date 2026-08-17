/**
 * Long-term memory about people and about chats.
 *
 * `DATA_DIR/MEMORY.md` is one file the operator writes by hand, shared by every
 * conversation. This is the other half: memory the agent accumulates itself,
 * filed under *who* or *where* it is about, so that "what did this person
 * decide" and "what does this team have going on" are separate questions with
 * separate answers.
 *
 * Two subjects exist:
 *
 * - `user` — keyed by Lark `open_id`, so it follows a person between chats;
 * - `group` — keyed by `chat_id`, and only ever the chat being replied in.
 *
 * ## Visibility
 *
 * Every entry records the chat it was learned in, and that decides who may see
 * it again:
 *
 * - learned in a group → recallable anywhere. It was said in front of others.
 * - learned in a private chat → recallable only in a private chat with that
 *   same person.
 *
 * Without that second rule a bot that remembers usefully also gossips: someone
 * confides a plan in a DM and the agent repeats it in a team channel a week
 * later. Cross-chat memory about a person still works — it is the *private*
 * half that stays private. The rule is enforced on read rather than on write,
 * so the record stays complete and auditable.
 *
 * Storage is one JSONL file per subject, appended to and never rewritten. The
 * root is taken as an argument rather than read from `config`, so this can be
 * pointed at a temporary directory in a test. Nothing here throws: memory that
 * cannot be read or written must not cost the user their reply.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../logger.ts";
import { safeName } from "../safe-name.ts";
import type { ChatRequest, ChatType } from "./request.ts";

/** Entries shown for each subject in the system prompt, newest first. */
export const MEMORY_PROMPT_LIMIT = 12;
/** Default and ceiling for what the recall tool returns in one call. */
export const MEMORY_RECALL_LIMIT = 20;
export const MEMORY_RECALL_MAX_LIMIT = 50;
/** Longer than this and it is a document, not a fact worth carrying forever. */
const MAX_ENTRY_LENGTH = 500;

export type MemorySubject =
  | { readonly kind: "user"; readonly openId: string }
  | { readonly kind: "group"; readonly chatId: string };

/** Where an entry came from, which is what the visibility rules are applied to. */
export type MemoryOrigin = {
  readonly chatId: string;
  readonly chatType: ChatType;
};

export type MemoryEntry = {
  readonly text: string;
  readonly createdAt: number;
  readonly origin: MemoryOrigin;
  /** `tool`: the agent chose to record it. `distilled`: extracted after a turn. */
  readonly source: "tool" | "distilled";
};

/** One line of a subject's file; the subject is repeated so lines stand alone. */
type StoredEntry = MemoryEntry & { readonly subject: MemorySubject };

export type RecallOptions = {
  readonly limit?: number;
  /** Case-insensitive substring filter; omitted returns the most recent entries. */
  readonly query?: string;
};

export type MemoryStore = {
  readonly root: string;
  /**
   * Records one fact. Returns false when it was rejected — blank, or something
   * already recorded about this subject. Never rejects.
   */
  remember(
    subject: MemorySubject,
    text: string,
    origin: MemoryOrigin,
    source: MemoryEntry["source"],
  ): Promise<boolean>;
  /**
   * Entries about a subject that `request` is allowed to see, newest first.
   * Never rejects; an unreadable subject reads as empty.
   */
  recall(
    subject: MemorySubject,
    request: ChatRequest,
    options?: RecallOptions,
  ): Promise<MemoryEntry[]>;
};

export const userSubject = (openId: string): MemorySubject => ({ kind: "user", openId });
export const groupSubject = (chatId: string): MemorySubject => ({ kind: "group", chatId });

const subjectPath = (root: string, subject: MemorySubject): string =>
  subject.kind === "user"
    ? join(root, "users", `${safeName(subject.openId)}.jsonl`)
    : join(root, "groups", `${safeName(subject.chatId)}.jsonl`);

/** For logs: identifies the subject without repeating the branching. */
const subjectLabel = (subject: MemorySubject): string =>
  subject.kind === "user" ? `user:${subject.openId}` : `group:${subject.chatId}`;

/** Collapses formatting differences so "the same fact" written twice is caught. */
const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The rule described at the top of this file. Applied per entry, so a subject
 * can hold both public and private facts and each reader sees only its share.
 */
export const isVisible = (
  subject: MemorySubject,
  entry: MemoryEntry,
  request: ChatRequest,
): boolean => {
  if (entry.origin.chatType === "group") {
    return true;
  }
  // Learned in private. Only a private conversation may see it again, and only
  // the one belonging to whoever it is about.
  if (request.chatType !== "p2p") {
    return false;
  }
  return subject.kind === "user"
    ? subject.openId === request.senderOpenId
    : subject.chatId === request.chatId;
};

export const createMemoryStore = (root: string): MemoryStore => {
  /**
   * Reads a subject's whole file, oldest first. A missing file is an empty
   * memory, not a problem; a corrupt line is skipped rather than discarding
   * every other fact in the file with it.
   */
  const readEntries = async (subject: MemorySubject): Promise<StoredEntry[]> => {
    const path = subjectPath(root, subject);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error("memory file could not be read, treating it as empty", {
          subject: subjectLabel(subject),
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return [];
    }

    const entries: StoredEntry[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as StoredEntry);
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      logger.warn("memory file has unparseable lines, skipping them", {
        subject: subjectLabel(subject),
        path,
        skipped,
        kept: entries.length,
      });
    }
    return entries;
  };

  const remember: MemoryStore["remember"] = async (subject, text, origin, source) => {
    const trimmed = text.trim().slice(0, MAX_ENTRY_LENGTH);
    if (trimmed === "") {
      logger.debug("memory entry rejected, nothing to record", {
        subject: subjectLabel(subject),
        source,
      });
      return false;
    }

    const existing = await readEntries(subject);
    // Both write paths run on the same turn — the agent may record a decision
    // the distiller then extracts again — so this is the normal case, not a
    // corner case.
    if (existing.some((entry) => normalize(entry.text) === normalize(trimmed))) {
      logger.debug("memory entry skipped, already recorded", {
        subject: subjectLabel(subject),
        source,
        text: trimmed,
      });
      return false;
    }

    const stored: StoredEntry = { subject, text: trimmed, createdAt: Date.now(), origin, source };
    const path = subjectPath(root, subject);
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(stored)}\n`, "utf8");
    } catch (err) {
      logger.error("memory entry could not be written", {
        subject: subjectLabel(subject),
        path,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    logger.info("memory recorded", {
      subject: subjectLabel(subject),
      source,
      originChatId: origin.chatId,
      originChatType: origin.chatType,
      text: trimmed,
      entries: existing.length + 1,
    });
    return true;
  };

  const recall: MemoryStore["recall"] = async (subject, request, options) => {
    const limit = Math.min(options?.limit ?? MEMORY_RECALL_LIMIT, MEMORY_RECALL_MAX_LIMIT);
    const needle = options?.query?.trim().toLowerCase();

    const all = await readEntries(subject);
    const visible = all.filter((entry) => isVisible(subject, entry, request));
    const matching =
      needle === undefined || needle === ""
        ? visible
        : visible.filter((entry) => entry.text.toLowerCase().includes(needle));

    logger.debug("memory recalled", {
      subject: subjectLabel(subject),
      chatId: request.chatId,
      total: all.length,
      visible: visible.length,
      matching: matching.length,
      returned: Math.min(matching.length, limit),
      query: options?.query,
    });

    // Newest first, then capped: the most recent facts are the ones that matter.
    return matching.reverse().slice(0, limit);
  };

  return { root, remember, recall };
};

/**
 * Renders entries as a system prompt block. Returns "" for an empty list, so a
 * subject nobody has recorded anything about adds nothing at all to the prompt.
 */
export const renderMemoryBlock = (
  tag: string,
  lead: string,
  entries: readonly MemoryEntry[],
): string => {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((entry) => {
    const date = new Date(entry.createdAt).toISOString().slice(0, 10);
    return `- [${date}] ${entry.text}`;
  });
  return [`<${tag}>`, lead, "", ...lines, `</${tag}>`].join("\n");
};
