/**
 * Minimal leveled logger emitting one JSON object per line.
 *
 * The active level comes from `config` (see LOG_LEVEL), so production can be
 * narrowed to the essential lines while local runs keep debugging detail.
 */

import { config, type LogLevel } from "./config.ts";

/** Levels below the configured one are dropped; `silent` drops everything. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

export type LogContext = Record<string, unknown>;

const currentLevel = config.logLevel;

type EmittableLevel = Exclude<LogLevel, "silent">;

const write = (level: EmittableLevel, message: string, context?: LogContext): void => {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) {
    return;
  }
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(JSON.stringify({ time: new Date().toISOString(), level, message, ...context }));
};

export const logger = {
  /** The level actually in effect, useful to log at startup. */
  level: currentLevel,
  debug: (message: string, context?: LogContext): void => write("debug", message, context),
  info: (message: string, context?: LogContext): void => write("info", message, context),
  warn: (message: string, context?: LogContext): void => write("warn", message, context),
  error: (message: string, context?: LogContext): void => write("error", message, context),
};
