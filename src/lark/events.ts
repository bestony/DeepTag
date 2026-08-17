import * as Lark from "@larksuiteoapi/node-sdk";

import type { AgentReply } from "../agent/runner.ts";
import { runAgent } from "../agent/service.ts";
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

/** Turns an agent outcome into the card the user sees. */
const renderReply = (reply: AgentReply): { title: string; content: string } => {
  if (reply.ok) {
    return { title: "DeepTag", content: reply.text };
  }
  switch (reply.reason) {
    case "disabled":
      return {
        title: "DeepTag is not configured",
        content: "No DeepSeek API key is set on the server, so I cannot answer yet.",
      };
    case "misconfigured":
      return {
        title: "DeepTag is misconfigured",
        content: "The configured model is unavailable. Check the server logs for details.",
      };
    case "timeout":
      return { title: "DeepTag timed out", content: "That took too long. Please try again." };
    default:
      // The detail is for the logs, not the chat: it can carry provider internals.
      return { title: "DeepTag hit an error", content: "Something went wrong. Please try again." };
  }
};

/** Injected so tests can drive the handler without a live model. */
export type PromptRunner = (chatId: string, prompt: string) => Promise<AgentReply>;

/** Logger wiring shared with the rest of the SDK, so its output stays JSON. */
export type DispatcherLogging = {
  logger: Lark.Logger;
  loggerLevel: Lark.LoggerLevel;
};

/**
 * Answers one message. Runs detached from the event handler, so it owns all of
 * its own error reporting and must never reject.
 */
const answer = async (
  client: Lark.Client,
  runPrompt: PromptRunner,
  chatId: string,
  messageId: string,
  prompt: string,
): Promise<void> => {
  let reply: AgentReply;
  try {
    reply = await runPrompt(chatId, prompt);
  } catch (err) {
    // runAgent is documented not to reject; treat a breach as a failed turn
    // rather than letting it escape as an unhandled rejection.
    logger.error("agent runner rejected unexpectedly", {
      chatId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    reply = { ok: false, reason: "failed" };
  }

  if (!reply.ok) {
    logger.warn("agent did not produce an answer", {
      chatId,
      inReplyTo: messageId,
      reason: reply.reason,
      detail: reply.detail,
    });
  }

  const card = renderReply(reply);
  try {
    const response = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: Lark.messageCard.defaultCard(card),
        msg_type: "interactive",
      },
    });
    logger.info("lark reply sent", {
      chatId,
      inReplyTo: messageId,
      replyMessageId: response.data?.message_id,
      answered: reply.ok,
    });
  } catch (err) {
    logger.error("failed to send lark reply", {
      chatId,
      inReplyTo: messageId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
};

/**
 * Builds the event dispatcher used by the WebSocket client.
 *
 * The `client` and `runPrompt` are injected rather than imported so the
 * dispatcher can be built against stubs in tests.
 *
 * Handlers must not reject: an unhandled rejection here would surface as a
 * process-level error rather than a failed reply, so every handler contains its
 * own failures.
 */
export const createEventDispatcher = (
  client: Lark.Client,
  logging: DispatcherLogging,
  runPrompt: PromptRunner = runAgent,
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

      // Deliberately not awaited. The gateway redelivers events whose handler
      // does not return promptly, and a model turn can take tens of seconds.
      // The reply is a separate API call, so acking first loses nothing; runs
      // for one chat are still serialized inside the agent runner.
      void answer(client, runPrompt, chatId, messageId, text);
    },
  });
