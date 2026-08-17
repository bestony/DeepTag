/**
 * Environment configuration: the single place that reads `process.env`.
 *
 * The `.env` file is loaded here, during this module's evaluation. Because
 * every consumer imports `config` from this module, the module graph guarantees
 * the file is loaded before any value is read — no reliance on import ordering
 * inside a file, which a formatter or import sorter could silently rearrange.
 *
 * Corollary: other modules must not read `process.env` directly, or they
 * reintroduce exactly that ordering hazard.
 */

import { config as loadDotenv } from "dotenv";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type AppConfig = {
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly nodeEnv: string;
  readonly isProduction: boolean;
};

const DEFAULT_PORT = 3000;
// Loopback by default so a dev server is not exposed to the local network;
// container deployments set HOST=0.0.0.0 explicitly.
const DEFAULT_HOST = "127.0.0.1";

/**
 * Problems found while reading the environment. The logger depends on this
 * module, so nothing here can log; `index.ts` flushes these at startup instead.
 */
export const configWarnings: string[] = [];

// `override` stays off (the default) so real environment variables always beat
// the file: a container's env must not be shadowed by a stray committed .env.
// `quiet` suppresses dotenv's startup banner, which would otherwise interleave
// non-JSON text into the log stream.
const dotenvResult = loadDotenv({ quiet: true });

const dotenvError = dotenvResult.error as NodeJS.ErrnoException | undefined;
// A missing .env is the normal case in production, where the platform injects
// the real environment. Anything else (permissions, malformed path) is not.
if (dotenvError !== undefined && dotenvError.code !== "ENOENT") {
  configWarnings.push(`failed to read .env: ${dotenvError.message}`);
}

/** Key names — never values — contributed by `.env`, safe to log at startup. */
export const envFileKeys: readonly string[] = Object.keys(dotenvResult.parsed ?? {});

/** Reads a variable, treating unset and blank alike. */
const read = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value);

const resolvePort = (): number => {
  const raw = read("PORT");
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    configWarnings.push(`invalid PORT "${raw}", falling back to ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return parsed;
};

const resolveLogLevel = (nodeEnv: string): LogLevel => {
  const raw = read("LOG_LEVEL")?.toLowerCase();
  if (raw === undefined) {
    return nodeEnv === "production" ? "info" : "debug";
  }
  if (isLogLevel(raw)) {
    return raw;
  }
  configWarnings.push(
    `unknown LOG_LEVEL "${raw}", expected one of ${LOG_LEVELS.join(", ")}; falling back to "info"`,
  );
  return "info";
};

const nodeEnv = read("NODE_ENV") ?? "development";

export const config: AppConfig = {
  port: resolvePort(),
  host: read("HOST") ?? DEFAULT_HOST,
  logLevel: resolveLogLevel(nodeEnv),
  nodeEnv,
  isProduction: nodeEnv === "production",
};
