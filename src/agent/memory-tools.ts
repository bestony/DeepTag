/**
 * The `remember` and `recall` tools.
 *
 * Both are bound to a *turn*, not to a session: in a group chat the speaker
 * changes from message to message, while the tool array is fixed when the
 * session is created. The runner therefore hands these a mutable holder it
 * updates before each run, and the tools read the current speaker from it at
 * call time. Runs for one chat are serialized, so the holder cannot change
 * underneath a tool call.
 *
 * Group memory is always the chat being replied in. The model cannot name
 * another chat, which removes cross-group leakage as a possibility rather than
 * as a rule to be enforced.
 */

import { Type, type Static } from "typebox";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  groupSubject,
  userSubject,
  MEMORY_RECALL_LIMIT,
  MEMORY_RECALL_MAX_LIMIT,
  type MemoryStore,
  type MemorySubject,
} from "./memory.ts";
import type { ChatRequest } from "./request.ts";

/**
 * The current turn, owned by the session and rewritten before each run.
 * `written` lets the distiller skip what the agent already recorded itself.
 */
export type TurnContext = {
  request: ChatRequest;
  /** Texts the `remember` tool accepted during this run. */
  written: string[];
};

const ABOUT_DESCRIPTION =
  'Whose memory: "user" for the person who sent the current message, "group" for this chat as a whole.';

const rememberSchema = Type.Object({
  about: Type.String({ description: ABOUT_DESCRIPTION }),
  text: Type.String({
    description:
      "The fact to record, as one self-contained sentence that will still make sense months from now. Include the subject, not just a pronoun.",
  }),
  open_id: Type.Optional(
    Type.String({
      description:
        "Record this about someone other than the sender, by Lark open_id. Only use an open_id that appears in this conversation. Ignored when about is \"group\".",
    }),
  ),
});

const recallSchema = Type.Object({
  about: Type.String({ description: ABOUT_DESCRIPTION }),
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring filter. Omit to get the most recent entries, which is usually what you want.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum entries to return. Default ${MEMORY_RECALL_LIMIT}, maximum ${MEMORY_RECALL_MAX_LIMIT}.`,
    }),
  ),
  open_id: Type.Optional(
    Type.String({
      description: 'Recall about someone other than the sender, by Lark open_id. Ignored when about is "group".',
    }),
  ),
});

type RememberInput = Static<typeof rememberSchema>;
type RecallInput = Static<typeof recallSchema>;

/**
 * Resolves which subject a call is about.
 *
 * Throws rather than guessing: the loop turns a thrown error into a tool result
 * the model can read and retry from, which is a better outcome than silently
 * filing a fact about the wrong person.
 */
const resolveSubject = (
  about: string,
  openId: string | undefined,
  request: ChatRequest,
): MemorySubject => {
  if (about === "group") {
    return groupSubject(request.chatId);
  }
  if (about !== "user") {
    throw new Error(`Unknown "about" value ${JSON.stringify(about)}; use "user" or "group".`);
  }
  const subject = openId?.trim() === "" ? undefined : openId?.trim();
  const target = subject ?? request.senderOpenId;
  if (target === null || target === undefined) {
    throw new Error(
      "This message carries no sender open_id, so there is nobody to attribute this to. Use about=\"group\" instead.",
    );
  }
  return userSubject(target);
};

const describeSubject = (subject: MemorySubject): string =>
  subject.kind === "user" ? `user ${subject.openId}` : "this chat";

export const createMemoryTools = (
  memory: MemoryStore,
  turn: () => TurnContext,
): AgentTool<any>[] => {
  const remember: AgentTool<typeof rememberSchema> = {
    name: "remember",
    label: "remember",
    description:
      "Record something worth remembering about the person you are talking to, or about this chat: a decision they made, a commitment, a stable preference, their role, or work in progress. Use it when you learn something that should still be true next week. Do not record small talk, transient questions, or anything already in your memory.",
    parameters: rememberSchema,
    execute: async (_toolCallId, params: RememberInput) => {
      const current = turn();
      const subject = resolveSubject(params.about, params.open_id, current.request);
      const written = await memory.remember(
        subject,
        params.text,
        { chatId: current.request.chatId, chatType: current.request.chatType },
        "tool",
      );

      if (written) {
        current.written.push(params.text);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: written
              ? `Recorded about ${describeSubject(subject)}.`
              : `Not recorded about ${describeSubject(subject)}: already known, or empty.`,
          },
        ],
        details: undefined,
      };
    },
  };

  const recall: AgentTool<typeof recallSchema> = {
    name: "recall",
    label: "recall",
    description:
      "Look up what you have recorded about the current speaker or about this chat. Your most recent memory is already in your context, so reach for this when you need older entries, or entries matching a particular topic.",
    parameters: recallSchema,
    execute: async (_toolCallId, params: RecallInput) => {
      const current = turn();
      const subject = resolveSubject(params.about, params.open_id, current.request);
      const entries = await memory.recall(subject, current.request, {
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.query === undefined ? {} : { query: params.query }),
      });

      const text =
        entries.length === 0
          ? `Nothing recorded about ${describeSubject(subject)}${params.query ? ` matching ${JSON.stringify(params.query)}` : ""}.`
          : entries
              .map((entry) => `- [${new Date(entry.createdAt).toISOString().slice(0, 10)}] ${entry.text}`)
              .join("\n");

      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };

  return [remember as AgentTool<any>, recall as AgentTool<any>];
};
