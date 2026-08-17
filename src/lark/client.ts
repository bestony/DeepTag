/**
 * Lark/Feishu integration lifecycle.
 *
 * The WebSocket client runs alongside the HTTP server in the same process: it
 * holds a long-lived connection to the Lark gateway and receives events pushed
 * over it, so no public callback URL is needed.
 */

import * as Lark from "@larksuiteoapi/node-sdk";

import { config, type LarkDomain, type LogLevel } from "../config.ts";
import { logger } from "../logger.ts";
import { createEventDispatcher } from "./events.ts";

export type LarkStatus =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly state: string; readonly reconnectAttempts: number };

/** Keeps the SDK's own verbosity in step with LOG_LEVEL. */
const SDK_LOGGER_LEVEL: Record<LogLevel, Lark.LoggerLevel> = {
  silent: Lark.LoggerLevel.fatal,
  error: Lark.LoggerLevel.error,
  warn: Lark.LoggerLevel.warn,
  info: Lark.LoggerLevel.info,
  debug: Lark.LoggerLevel.debug,
};

const SDK_DOMAIN: Record<LarkDomain, Lark.Domain> = {
  feishu: Lark.Domain.Feishu,
  lark: Lark.Domain.Lark,
};

/**
 * The SDK passes its message parts inconsistently — sometimes as varargs,
 * sometimes as a single array argument. Flatten so `detail` reads the same
 * either way, and unwrap the common single-value case.
 */
const sdkDetail = (parts: unknown[]): unknown => {
  const flat = parts.flat();
  return flat.length === 1 ? flat[0] : flat;
};

/**
 * Adapter so SDK output joins the JSON log stream instead of writing raw lines
 * to the console, which would break log parsing downstream.
 */
const sdkLogger = {
  error: (...parts: unknown[]): void => logger.error("lark sdk", { detail: sdkDetail(parts) }),
  warn: (...parts: unknown[]): void => logger.warn("lark sdk", { detail: sdkDetail(parts) }),
  info: (...parts: unknown[]): void => logger.info("lark sdk", { detail: sdkDetail(parts) }),
  debug: (...parts: unknown[]): void => logger.debug("lark sdk", { detail: sdkDetail(parts) }),
  // The SDK's trace tier has no counterpart here; it belongs with debug.
  trace: (...parts: unknown[]): void => logger.debug("lark sdk", { detail: sdkDetail(parts) }),
};

let wsClient: Lark.WSClient | undefined;

/** Connection snapshot for the health endpoint. */
export const getLarkStatus = (): LarkStatus => {
  if (wsClient === undefined) {
    return { enabled: false };
  }
  const { state, reconnectAttempts } = wsClient.getConnectionStatus();
  return { enabled: true, state, reconnectAttempts };
};

/**
 * Opens the Lark WebSocket connection. Never rejects: a bot that cannot connect
 * must not take the HTTP server down with it, so failures are logged and the
 * SDK's own reconnect loop owns recovery.
 */
export const startLark = async (): Promise<void> => {
  const larkConfig = config.lark;
  if (larkConfig === null) {
    logger.warn("lark credentials not configured, bot disabled", {
      hint: "set LARK_APP_ID and LARK_APP_SECRET (see .env.example)",
    });
    return;
  }

  const loggerLevel = SDK_LOGGER_LEVEL[config.logLevel];
  const domain = SDK_DOMAIN[larkConfig.domain];
  const credentials = {
    appId: larkConfig.appId,
    appSecret: larkConfig.appSecret,
    domain,
    logger: sdkLogger,
    loggerLevel,
  };

  const client = new Lark.Client(credentials);

  wsClient = new Lark.WSClient({
    ...credentials,
    onReady: () => logger.info("lark websocket connected", { domain: larkConfig.domain }),
    onError: (err) => logger.error("lark websocket stopped retrying", { error: err.message }),
    onReconnecting: () => logger.warn("lark websocket reconnecting"),
    onReconnected: () => logger.info("lark websocket reconnected"),
  });

  logger.info("starting lark websocket client", {
    // appId identifies the app but does not authorize anything; appSecret is
    // never logged, here or anywhere else.
    appId: larkConfig.appId,
    domain: larkConfig.domain,
    sdkLoggerLevel: Lark.LoggerLevel[loggerLevel],
  });

  try {
    const eventDispatcher = createEventDispatcher(client, { logger: sdkLogger, loggerLevel });
    await wsClient.start({ eventDispatcher });
  } catch (err) {
    logger.error("failed to start lark websocket client", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
};

/** Closes the connection so the process can exit promptly on a signal. */
export const stopLark = (): void => {
  if (wsClient === undefined) {
    return;
  }
  logger.info("closing lark websocket client");
  try {
    wsClient.close();
  } catch (err) {
    logger.warn("lark websocket did not close cleanly", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  wsClient = undefined;
};
