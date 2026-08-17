/**
 * The chat directory: which chat a transcript on disk belongs to.
 *
 * Transcripts are keyed by the chat's workspace directory (`transcript.ts`),
 * and that directory is named `safeName(chatId)` — lossy and hashed, so it
 * cannot be turned back into a chat id. Reading another chat's history
 * therefore needs the map in the other direction, plus one thing the transcript
 * never records at all: whether that chat is a group or a private one, which is
 * what decides who may read it back (`history.ts`).
 *
 * One append-only JSONL file, `chats.jsonl`, at the root of SESSION_DIR. It
 * sits beside the per-chat transcript directories rather than inside one, which
 * is safe: the session format only ever scans that root for *directories*, so a
 * plain file there is invisible to it.
 *
 * Lines are replayed last-write-wins per chat id, so a chat whose type or
 * workspace changes simply gets a newer line and the older one becomes history.
 * A record is written when a chat's session opens, and skipped when it would
 * repeat what is already there — so the file grows with the number of chats,
 * not with the number of messages.
 *
 * The root is taken as an argument rather than read from `config`, so this can
 * be pointed at a temporary directory in a test. Nothing here throws: a
 * directory that cannot be read costs the agent its view of the other chats,
 * which must not cost the user their reply.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { logger } from "../logger.ts";
import type { ChatType } from "./request.ts";

/** Beside the transcript directories, at the root of SESSION_DIR. */
const DIRECTORY_FILE = "chats.jsonl";

export type ChatRecord = {
  readonly chatId: string;
  readonly chatType: ChatType;
  /** Absolute workspace directory: the `cwd` this chat's transcript is keyed on. */
  readonly cwd: string;
  readonly updatedAt: number;
};

/** What a caller supplies; `updatedAt` is stamped on write. */
export type ChatIdentity = Omit<ChatRecord, "updatedAt">;

export type ChatDirectory = {
  readonly path: string;
  /**
   * Records a chat, doing nothing when the same identity is already on file.
   * Never rejects.
   */
  record(chat: ChatIdentity): Promise<void>;
  /** Every known chat, one record each. Never rejects. */
  list(): Promise<ChatRecord[]>;
};

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Validates one line. Returns null for anything malformed rather than throwing:
 * a bad line should cost that one chat its entry, not the whole directory.
 */
const parseRecord = (value: unknown): ChatRecord | null => {
  const raw = asObject(value);
  if (raw === null) {
    return null;
  }
  const chatId = raw["chatId"];
  const chatType = raw["chatType"];
  const cwd = raw["cwd"];
  const updatedAt = raw["updatedAt"];

  if (typeof chatId !== "string" || chatId === "") {
    return null;
  }
  // Checked explicitly rather than cast: chatType drives visibility, and an
  // unrecognized value must not be allowed to read as "group".
  if (chatType !== "p2p" && chatType !== "group") {
    return null;
  }
  if (typeof cwd !== "string" || cwd === "") {
    return null;
  }
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return null;
  }
  return { chatId, chatType, cwd, updatedAt };
};

export const createChatDirectory = (root: string): ChatDirectory => {
  const path = join(root, DIRECTORY_FILE);

  /** Every line, oldest first. A missing file is an empty directory, not a problem. */
  const readAll = async (): Promise<ChatRecord[]> => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error("chat directory could not be read, treating it as empty", {
          path,
          error: describeError(err),
        });
      }
      return [];
    }

    const records: ChatRecord[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      const record = parseRecord(parsed);
      if (record === null) {
        skipped += 1;
        continue;
      }
      records.push(record);
    }
    if (skipped > 0) {
      logger.warn("chat directory has unusable lines, skipping them", {
        path,
        skipped,
        kept: records.length,
      });
    }
    return records;
  };

  const list: ChatDirectory["list"] = async () => {
    // Insertion order is oldest first, so a later line simply overwrites.
    const byChatId = new Map<string, ChatRecord>();
    for (const record of await readAll()) {
      byChatId.set(record.chatId, record);
    }
    return [...byChatId.values()];
  };

  const record: ChatDirectory["record"] = async (chat) => {
    // Normalized on write so lookups by `cwd` compare resolved paths without
    // every caller having to remember to.
    const cwd = resolve(chat.cwd);
    const known = (await list()).find((entry) => entry.chatId === chat.chatId);
    if (known !== undefined && known.chatType === chat.chatType && known.cwd === cwd) {
      return;
    }

    const stored: ChatRecord = {
      chatId: chat.chatId,
      chatType: chat.chatType,
      cwd,
      updatedAt: Date.now(),
    };
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(stored)}\n`, "utf8");
    } catch (err) {
      logger.error("chat directory entry could not be written, this chat stays invisible", {
        path,
        chatId: chat.chatId,
        error: describeError(err),
      });
      return;
    }

    logger.info(known === undefined ? "chat directory entry added" : "chat directory entry updated", {
      path,
      chatId: stored.chatId,
      chatType: stored.chatType,
      cwd: stored.cwd,
    });
  };

  return { path, record, list };
};
