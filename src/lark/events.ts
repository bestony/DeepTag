import * as Lark from "@larksuiteoapi/node-sdk";

import type { ChatRequest, ChatType } from "../agent/request.ts";
import type { AgentReply } from "../agent/runner.ts";
import { runAgent } from "../agent/service.ts";
import { createSeenSet, type SeenSet } from "../dedupe.ts";
import { logger } from "../logger.ts";

/**
 * Idempotency window for redelivered events. Retaining a key too long only
 * costs a little memory; retaining it too briefly costs the user a duplicate
 * reply and a duplicate model call, so this errs long.
 */
const DEDUPE_TTL_MS = 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 10_000;

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
export type PromptRunner = (request: ChatRequest, prompt: string) => Promise<AgentReply>;

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
  request: ChatRequest,
  messageId: string,
  prompt: string,
): Promise<void> => {
  const chatId = request.chatId;
  let reply: AgentReply;
  try {
    reply = await runPrompt(request, prompt);
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
  seen: SeenSet = createSeenSet({ maxEntries: DEDUPE_MAX_ENTRIES, ttlMs: DEDUPE_TTL_MS }),
): Lark.EventDispatcher =>
  new Lark.EventDispatcher(logging).register({
    "im.message.receive_v1": async (data) => {
      const { message, sender, event_id: eventId } = data;
      const {
        chat_id: chatId,
        chat_type: chatType,
        message_id: messageId,
        message_type: messageType,
        content,
      } = message;

      // Only `p2p` is a private conversation; every other chat kind is treated
      // as a group, which is the conservative reading for memory visibility —
      // an unfamiliar value must not make a chat look private.
      const request: ChatRequest = {
        chatId,
        chatType: (chatType === "p2p" ? "p2p" : "group") satisfies ChatType,
        // Absent for messages the platform does not attribute to a person.
        senderOpenId: sender?.sender_id?.open_id ?? null,
      };

      logger.info("lark message received", {
        eventId,
        chatId,
        chatType,
        senderOpenId: request.senderOpenId,
        messageId,
        messageType,
      });

      // The gateway redelivers events it considers unacknowledged, and this
      // handler acks before the answer exists — so a redelivery would otherwise
      // mean a second reply and a second model call. `event_id` is Lark's
      // idempotency key; `message_id` covers the events that omit it, since one
      // message produces one receive event. The key is namespaced by event type
      // so the fallback cannot collide across event kinds.
      //
      // Claimed before any await: two deliveries racing here must not both pass.
      const idempotencyKey = `im.message.receive_v1:${eventId ?? messageId}`;
      if (!seen.claim(idempotencyKey)) {
        logger.info("duplicate lark event ignored", { eventId, chatId, messageId });
        return;
      }

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
      void answer(client, runPrompt, request, messageId, text);
    },
  });
