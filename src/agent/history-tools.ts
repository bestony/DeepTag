/**
 * The `list_chats` and `read_chat` tools.
 *
 * Bound to a *turn* rather than to a session, for the same reason the memory
 * tools are: the tool array is fixed when the session is created, while what a
 * caller is allowed to read depends on the chat and speaker of the message
 * being answered. The runner hands these a mutable holder it rewrites before
 * each run, and every call reads the current request out of it. Runs for one
 * chat are serialized, so the holder cannot change underneath a call.
 *
 * Unlike the memory tools, these do take a chat id from the model — that is the
 * point of them. It is not trusted: `history.ts` resolves it against the chat
 * directory and applies the visibility rule, and an id the caller may not read
 * is answered exactly like an id that does not exist.
 */

import { Type, type Static } from "typebox";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  renderChatList,
  renderChatWindow,
  HISTORY_CHATS_LIMIT,
  HISTORY_CHATS_MAX_LIMIT,
  HISTORY_MESSAGES_LIMIT,
  HISTORY_MESSAGES_MAX_LIMIT,
  type HistoryStore,
} from "./history.ts";
import type { TurnContext } from "./memory-tools.ts";

const listChatsSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring. Keeps only chats whose history mentions it, so you can find which chat a topic was discussed in. Omit to see every chat.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum chats to return. Default ${HISTORY_CHATS_LIMIT}, maximum ${HISTORY_CHATS_MAX_LIMIT}.`,
    }),
  ),
});

const readChatSchema = Type.Object({
  chat_id: Type.Optional(
    Type.String({
      description:
        "Which chat to read, as listed by list_chats. Omit to read this conversation's own older history.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring. Returns only messages containing it, which is how you reach further back than the most recent ones.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum messages to return, newest kept. Default ${HISTORY_MESSAGES_LIMIT}, maximum ${HISTORY_MESSAGES_MAX_LIMIT}.`,
    }),
  ),
});

type ListChatsInput = Static<typeof listChatsSchema>;
type ReadChatInput = Static<typeof readChatSchema>;

const text = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
  details: undefined,
});

export const createHistoryTools = (
  history: HistoryStore,
  turn: () => TurnContext,
): AgentTool<any>[] => {
  // Said in the descriptions rather than discovered by trying: under `own-chat`
  // every cross-chat call fails, and a model that has been told so spends its
  // turn answering instead of probing.
  const reach =
    history.scope === "shared-groups"
      ? "You can see group chats and this conversation; other people's private chats are never visible."
      : "This deployment restricts you to this conversation's own history — no other chat is visible.";

  const listChats: AgentTool<typeof listChatsSchema> = {
    name: "list_chats",
    label: "list chats",
    description:
      "List the Lark chats you take part in, most recently active first, with a line of what was last said in each. Use it to see what colleagues are working on elsewhere, or with a query to find which chat a topic came up in. It returns the chat_id that read_chat takes. " +
      reach,
    parameters: listChatsSchema,
    execute: async (_toolCallId, params: ListChatsInput) => {
      const current = turn();
      const summaries = await history.listChats(current.request, {
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.query === undefined ? {} : { query: params.query }),
      });
      return text(renderChatList(summaries, params.query));
    },
  };

  const readChat: AgentTool<typeof readChatSchema> = {
    name: "read_chat",
    label: "read chat",
    description:
      "Read a conversation's messages, oldest first. Pass a chat_id from list_chats to catch up on another chat before answering about it; omit it to page back through this conversation, whose transcript on disk goes further back than what you still have in context. Pass a query to search rather than to browse. Quote or summarize what you find rather than pasting it wholesale, and say which chat it came from. " +
      reach,
    parameters: readChatSchema,
    execute: async (_toolCallId, params: ReadChatInput) => {
      const current = turn();
      const window = await history.readChat(current.request, {
        ...(params.chat_id === undefined ? {} : { chatId: params.chat_id }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.query === undefined ? {} : { query: params.query }),
      });

      if (window === null) {
        // Deliberately one answer for both "no such chat" and "not yours to
        // read": which of the two it is, is itself information.
        return text(
          `No chat with id ${JSON.stringify(params.chat_id ?? "")} is visible from here. Use list_chats to see the ones that are.`,
        );
      }
      return text(renderChatWindow(window, params.query));
    },
  };

  return [listChats as AgentTool<any>, readChat as AgentTool<any>];
};
