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

import { resolve, sep } from "node:path";

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

export type WorkspaceConfig = {
  /**
   * Absolute root of all workspaces. Each chat works in its own directory
   * beneath it; the root itself holds no files of its own.
   */
  readonly root: string;
  /**
   * Environment handed to shell commands the agent runs. See
   * SHELL_ENV_ALLOWLIST — this is built by allowlist, not by filtering.
   */
  readonly shellEnv: Readonly<Record<string, string>>;
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
  /** Where agent sessions do their work; see WORKSPACE_DIR. */
  readonly workspace: WorkspaceConfig;
  /**
   * Absolute root of the persisted session transcripts, one JSONL file per
   * chat. Kept away from the workspace on purpose: the agent must not be able
   * to rewrite the record of what it was asked to do.
   */
  readonly sessionDir: string;
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

// A sibling of DATA_DIR rather than a directory inside it, and deliberately so:
// the agent can write and run shell commands in its workspace, so nesting the
// two would let it rewrite its own AGENTS.md. Overlap is warned about below.
const DEFAULT_WORKSPACE_DIR = "workspace";

const DEFAULT_SESSION_DIR = "sessions";

/**
 * Variable names copied into the agent's shell environment.
 *
 * An allowlist, not a filtered copy of this process's environment: DEEPSEEK_API_KEY
 * and the Lark credentials live here, and `env` is one command away from
 * printing them into a chat. Building up rather than tearing down means a
 * secret added to `.env` later is excluded because nobody thought about it,
 * which is the only way this stays safe over time.
 *
 * Adding a name here deliberately exposes that variable to the model.
 */
const SHELL_ENV_ALLOWLIST = [
  // Without PATH the shell resolves almost nothing.
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  // Windows equivalents; absent names are simply skipped elsewhere.
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "TEMP",
  "TMP",
] as const;

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

/**
 * Copies the allowlisted variables. Values are taken verbatim — unlike `read`,
 * which trims and treats blank as unset, since a variable's exact value is what
 * a shell command expects to see.
 */
const resolveShellEnv = (): Record<string, string> => {
  const shellEnv: Record<string, string> = {};
  for (const name of SHELL_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      shellEnv[name] = value;
    }
  }
  return shellEnv;
};

/** True when one path is the other, or is nested inside it. */
const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

const nodeEnv = read("NODE_ENV") ?? "development";

// `resolve` leaves an absolute value untouched and anchors a relative one to the
// working directory.
const dataDir = resolve(read("DATA_DIR") ?? DEFAULT_DATA_DIR);
const workspaceRoot = resolve(read("WORKSPACE_DIR") ?? DEFAULT_WORKSPACE_DIR);
const sessionDir = resolve(read("SESSION_DIR") ?? DEFAULT_SESSION_DIR);

/**
 * The three directories must stay disjoint, and for the same reason each time:
 * the agent can write and run shell commands inside its workspace, so anything
 * nested there is something it can rewrite — the instructions it was given, or
 * the record of what it did. Warned about rather than rejected, because an
 * operator may genuinely mean it.
 */
const warnIfOverlapping = (nameA: string, pathA: string, nameB: string, pathB: string): void => {
  if (overlaps(pathA, pathB)) {
    configWarnings.push(
      `${nameA} (${pathA}) overlaps ${nameB} (${pathB}); keep them separate, or the agent can rewrite files it should only ever read`,
    );
  }
};

warnIfOverlapping("WORKSPACE_DIR", workspaceRoot, "DATA_DIR", dataDir);
warnIfOverlapping("SESSION_DIR", sessionDir, "WORKSPACE_DIR", workspaceRoot);
warnIfOverlapping("SESSION_DIR", sessionDir, "DATA_DIR", dataDir);

export const config: AppConfig = {
  port: readInt("PORT", { min: 0, max: 65535, fallback: DEFAULT_PORT }),
  host: read("HOST") ?? DEFAULT_HOST,
  logLevel: resolveLogLevel(nodeEnv),
  nodeEnv,
  isProduction: nodeEnv === "production",
  dataDir,
  workspace: { root: workspaceRoot, shellEnv: resolveShellEnv() },
  sessionDir,
  lark: resolveLark(),
  agent: resolveAgent(),
};
