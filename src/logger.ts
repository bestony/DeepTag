/**
 * Minimal leveled logger emitting one JSON object per line.
 *
 * The level is resolved once from `LOG_LEVEL` so production can be narrowed to
 * the essential lines while local runs keep the detail needed for debugging.
 * Defaults: `info` when NODE_ENV=production, `debug` otherwise.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Levels below the configured one are dropped; `silent` drops everything. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

export type LogContext = Record<string, unknown>;

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value);

const resolveLevel = (): LogLevel => {
  const raw = process.env["LOG_LEVEL"]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return process.env["NODE_ENV"] === "production" ? "info" : "debug";
  }
  if (isLogLevel(raw)) {
    return raw;
  }
  // Surface the misconfiguration instead of silently ignoring it.
  console.warn(
    `[logger] unknown LOG_LEVEL "${raw}", expected one of ${LOG_LEVELS.join(", ")}; falling back to "info"`,
  );
  return "info";
};

const currentLevel = resolveLevel();

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
