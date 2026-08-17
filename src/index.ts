/**
 * DeepTag server entry point: binds the Hono app to a Node.js HTTP server.
 *
 * Configuration (all optional):
 *   PORT       listening port, default 3000
 *   HOST       bind address, default 127.0.0.1 (use 0.0.0.0 in containers)
 *   LOG_LEVEL  debug | info | warn | error | silent
 */

import { serve } from "@hono/node-server";

import app from "./app.ts";
import { logger } from "./logger.ts";

const DEFAULT_PORT = 3000;
// Loopback by default so a dev server is not exposed to the local network;
// container deployments set HOST=0.0.0.0 explicitly.
const DEFAULT_HOST = "127.0.0.1";

const resolvePort = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    logger.warn("invalid PORT, falling back to default", { raw, fallback: DEFAULT_PORT });
    return DEFAULT_PORT;
  }
  return parsed;
};

const port = resolvePort(process.env["PORT"]);
const hostname = process.env["HOST"]?.trim() || DEFAULT_HOST;

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  logger.info("server listening", {
    url: `http://${hostname}:${info.port}`,
    address: info.address,
    port: info.port,
    family: info.family,
    pid: process.pid,
    nodeVersion: process.version,
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    logLevel: logger.level,
  });
});

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info("shutdown signal received, closing server", { signal });
  server.close((err) => {
    if (err) {
      logger.error("server failed to close cleanly", { signal, error: err.message });
      process.exitCode = 1;
      return;
    }
    logger.info("server closed", { signal });
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
