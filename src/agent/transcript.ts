/**
 * Persisted transcripts, so a chat keeps its conversation across restarts.
 *
 * An in-memory session is a cache, not the record. The registry in `runner.ts`
 * is bounded and expires idle chats, and a deployment restarts whenever it is
 * redeployed — none of which a user in a chat window has any reason to
 * experience as amnesia. The transcript on disk is what makes a session
 * reusable: it is read back when a chat's session is (re)created, and appended
 * to after every run.
 *
 * Storage is pi-agent-core's own JSONL session format, keyed by the chat's
 * workspace directory — the `cwd` the format indexes on. Using the library's
 * store rather than a bespoke file keeps the on-disk format one that its
 * tooling already understands, and leaves the door open to adopting
 * `AgentHarness` later without migrating anything.
 *
 * Only a slice of that format is used: messages appended to the `main` lane.
 * Branching, forking, compaction records and usage accounting are all things
 * the harness writes and we do not.
 *
 * Nothing here throws. A transcript that cannot be read or written costs the
 * conversation its memory, which is bad; it must not cost the user their reply,
 * which would be worse.
 */

import {
  JsonlSessionRepo,
  type AgentMessage,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { logger } from "../logger.ts";

export type ChatTranscript = {
  /** Messages restored from disk, oldest first; empty for a new chat. */
  readonly messages: readonly AgentMessage[];
  /** True when this chat had a transcript already — it is being resumed, not started. */
  readonly resumed: boolean;
  /** Appends the messages one run produced. Never rejects. */
  append(messages: readonly AgentMessage[]): Promise<void>;
};

export type TranscriptStore = {
  readonly root: string;
  /**
   * Opens the transcript for a chat, resuming the existing one when there is
   * one. `cwd` is the chat's workspace directory and is what the transcript is
   * keyed on. Never rejects.
   */
  open(chatId: string, cwd: string, limit: number): Promise<ChatTranscript>;
};

/** What a chat gets when persistence is unavailable: a working, forgetful session. */
const EPHEMERAL: ChatTranscript = {
  messages: [],
  resumed: false,
  append: async () => {},
};

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Restores the tail of the conversation.
 *
 * Only the last `limit` messages are read, because that is all `runner.ts`
 * would send to the model anyway — the rest stays on disk as the record. A
 * transcript that begins with a `toolResult` is trimmed further: without the
 * assistant message that requested it, it is an orphan the provider rejects.
 */
const restoreMessages = async (
  session: Session<JsonlSessionMetadata>,
  limit: number,
): Promise<AgentMessage[]> => {
  const entries = await session.findEntriesOnBranch({
    type: "message",
    order: "newestFirst",
    limit,
  });

  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .reverse();

  let start = 0;
  while (start < messages.length && messages[start]?.role === "toolResult") {
    start += 1;
  }
  return messages.slice(start);
};

export const createTranscriptStore = (root: string): TranscriptStore => {
  // NodeExecutionEnv is the library's own Node filesystem implementation and
  // satisfies the subset the repo needs; its cwd is irrelevant here because
  // every path handed to the repo is absolute.
  const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });

  const open = async (chatId: string, cwd: string, limit: number): Promise<ChatTranscript> => {
    let session: Session<JsonlSessionMetadata>;
    let messages: AgentMessage[];
    let resumed: boolean;

    try {
      const existing = await repo.list({ cwd });
      resumed = existing.length > 0;
      // Normally there is exactly one. If a crash mid-create left more behind,
      // the newest is the live one.
      session = resumed
        ? await repo.open(existing.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b)))
        : await repo.create({ cwd });
      messages = await restoreMessages(session, limit);
    } catch (err) {
      logger.error("transcript could not be opened, this session will not be remembered", {
        chatId,
        cwd,
        root,
        error: describeError(err),
      });
      return EPHEMERAL;
    }

    logger.debug(resumed ? "transcript resumed" : "transcript created", {
      chatId,
      cwd,
      restoredMessages: messages.length,
    });

    return {
      messages,
      resumed,
      append: async (produced) => {
        // Sequentially: the storage layer queues writes anyway, and appending
        // in order is what makes the file replayable.
        try {
          for (const message of produced) {
            await session.appendMessage(message);
          }
        } catch (err) {
          logger.error("transcript append failed, those messages are lost", {
            chatId,
            cwd,
            messages: produced.length,
            error: describeError(err),
          });
        }
      },
    };
  };

  return { root, open };
};
