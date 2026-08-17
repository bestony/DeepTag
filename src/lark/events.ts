import * as Lark from "@larksuiteoapi/node-sdk";

import { logger } from "../logger.ts";

/**
 * `message.content` arrives as a JSON string whose shape depends on
 * `message_type`; only `text` messages carry a `text` field. Returns null for
 * anything else rather than letting `undefined` leak into a reply.
 */
const readTextContent = (raw: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("text" in parsed)) {
    return null;
  }
  const { text } = parsed as { text: unknown };
  return typeof text === "string" ? text : null;
};

/** Logger wiring shared with the rest of the SDK, so its output stays JSON. */
export type DispatcherLogging = {
  logger: Lark.Logger;
  loggerLevel: Lark.LoggerLevel;
};

/**
 * Builds the event dispatcher used by the WebSocket client.
 *
 * The `client` is injected rather than imported so the dispatcher can be built
 * against a stub in tests.
 *
 * Handlers must not reject: an unhandled rejection here would surface as a
 * process-level error rather than a failed reply, so every handler contains its
 * own failures.
 */
export const createEventDispatcher = (
  client: Lark.Client,
  logging: DispatcherLogging,
): Lark.EventDispatcher =>
  new Lark.EventDispatcher(logging).register({
    "im.message.receive_v1": async (data) => {
      const { message, event_id: eventId } = data;
      const {
        chat_id: chatId,
        message_id: messageId,
        message_type: messageType,
        content,
      } = message;

      logger.info("lark message received", { eventId, chatId, messageId, messageType });

      if (messageType !== "text") {
        logger.debug("ignoring non-text message", { messageId, messageType });
        return;
      }

      const text = readTextContent(content);
      if (text === null) {
        logger.warn("text message carried no readable text, skipping reply", { messageId });
        return;
      }

      try {
        const response = await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: Lark.messageCard.defaultCard({ title: `reply: ${text}`, content: "hello" }),
            msg_type: "interactive",
          },
        });
        logger.info("lark reply sent", {
          chatId,
          inReplyTo: messageId,
          replyMessageId: response.data?.message_id,
        });
      } catch (err) {
        logger.error("failed to send lark reply", {
          chatId,
          inReplyTo: messageId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    },
  });
