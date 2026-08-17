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

import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** `feishu` is the mainland China deployment, `lark` the international one. */
export const LARK_DOMAINS = ["feishu", "lark"] as const;

export type LarkDomain = (typeof LARK_DOMAINS)[number];

export type LarkConfig = {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: LarkDomain;
};

export type AgentConfig = {
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly timeoutMs: number;
};

export type AppConfig = {
  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  /**
   * Absolute path to the directory holding operator-editable state — today
   * AGENTS.md and MEMORY.md, which shape the agent's system prompt. Absolute so
   * every log line names the same location regardless of the working directory
   * a deployment happens to start in. The directory need not exist.
   */
  readonly dataDir: string;
  /** `null` when credentials are absent — the bot is then simply disabled. */
  readonly lark: LarkConfig | null;
  /** `null` without a DeepSeek API key — messages then get a "not configured" reply. */
  readonly agent: AgentConfig | null;
};

const DEFAULT_PORT = 3000;
// Loopback by default so a dev server is not exposed to the local network;
// container deployments set HOST=0.0.0.0 explicitly.
const DEFAULT_HOST = "127.0.0.1";

// Relative to the working directory, which for every documented way of starting
// the server is the project root.
const DEFAULT_DATA_DIR = "data";

export const DEFAULT_AGENT_MODEL = "deepseek-v4-flash";

const DEFAULT_SYSTEM_PROMPT =
  "You are DeepTag, an assistant replying inside a Lark chat. " +
  "Answer concisely, in the same language the user writes in. " +
  "Format replies as short markdown suitable for a chat card.";

// DeepSeek V4 is a reasoning model, so a full answer can take a while; this cap
// exists to stop a hung request from blocking a chat forever, not to be tight.
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

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

/** Reads an integer variable, warning and falling back when out of range. */
const readInt = (
  name: string,
  bounds: { min: number; max: number; fallback: number },
): number => {
  const raw = read(name);
  if (raw === undefined) {
    return bounds.fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    configWarnings.push(
      `invalid ${name} "${raw}", expected an integer in ${bounds.min}-${bounds.max}; falling back to ${bounds.fallback}`,
    );
    return bounds.fallback;
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

const isLarkDomain = (value: string): value is LarkDomain =>
  (LARK_DOMAINS as readonly string[]).includes(value);

const resolveLarkDomain = (): LarkDomain => {
  const raw = read("LARK_DOMAIN")?.toLowerCase();
  if (raw === undefined) {
    return "feishu";
  }
  if (isLarkDomain(raw)) {
    return raw;
  }
  configWarnings.push(
    `unknown LARK_DOMAIN "${raw}", expected one of ${LARK_DOMAINS.join(", ")}; falling back to "feishu"`,
  );
  return "feishu";
};

/**
 * Credentials are optional. Without them the HTTP server still starts and only
 * the Lark bot stays disabled, so a fresh clone can run `pnpm dev` and hit
 * /health without holding any secrets.
 */
const resolveLark = (): LarkConfig | null => {
  const appId = read("LARK_APP_ID");
  const appSecret = read("LARK_APP_SECRET");

  if (appId === undefined && appSecret === undefined) {
    return null;
  }
  // Half-configured is a mistake worth naming: silently disabling the bot when
  // one of the pair is set would look like the credentials were simply wrong.
  if (appId === undefined || appSecret === undefined) {
    const missing = appId === undefined ? "LARK_APP_ID" : "LARK_APP_SECRET";
    configWarnings.push(
      `${missing} is missing; LARK_APP_ID and LARK_APP_SECRET must be set together, so the Lark client stays disabled`,
    );
    return null;
  }
  return { appId, appSecret, domain: resolveLarkDomain() };
};

/**
 * The DeepSeek key is what enables the agent. Without it the Lark bot still
 * receives messages and answers that it is not configured, which is easier to
 * diagnose than silence.
 */
const resolveAgent = (): AgentConfig | null => {
  const apiKey = read("DEEPSEEK_API_KEY");
  if (apiKey === undefined) {
    return null;
  }
  return {
    apiKey,
    model: read("AGENT_MODEL") ?? DEFAULT_AGENT_MODEL,
    systemPrompt: read("AGENT_SYSTEM_PROMPT") ?? DEFAULT_SYSTEM_PROMPT,
    timeoutMs: readInt("AGENT_TIMEOUT_MS", {
      min: 1_000,
      max: 600_000,
      fallback: DEFAULT_AGENT_TIMEOUT_MS,
    }),
  };
};

const nodeEnv = read("NODE_ENV") ?? "development";

export const config: AppConfig = {
  port: readInt("PORT", { min: 0, max: 65535, fallback: DEFAULT_PORT }),
  host: read("HOST") ?? DEFAULT_HOST,
  logLevel: resolveLogLevel(nodeEnv),
  nodeEnv,
  isProduction: nodeEnv === "production",
  // `resolve` leaves an absolute DATA_DIR untouched and anchors a relative one
  // to the working directory.
  dataDir: resolve(read("DATA_DIR") ?? DEFAULT_DATA_DIR),
  lark: resolveLark(),
  agent: resolveAgent(),
};
