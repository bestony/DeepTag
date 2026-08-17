/**
 * Who is asking, and from where.
 *
 * A chat session is keyed by `chatId`, but in a group the *speaker* changes
 * from one message to the next — so identity belongs to the request, not to the
 * session. Memory scoping (`memory.ts`) depends on this distinction, which is
 * why it is a type of its own rather than a widening of the runner's signature.
 */

/** `p2p` is a private chat with one person; anything else is treated as a group. */
export type ChatType = "p2p" | "group";

export type ChatRequest = {
  readonly chatId: string;
  readonly chatType: ChatType;
  /**
   * Lark `open_id` of whoever sent the message, or `null` when the event did
   * not carry one. Null means nothing can be remembered about the speaker —
   * there is no one to attribute it to — and the turn still runs.
   */
  readonly senderOpenId: string | null;
};
