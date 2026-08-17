/**
 * DeepTag server entry point: binds the Hono app to a Node.js HTTP server.
 *
 * Configuration is read from the environment, with a `.env` file loaded at
 * startup as a fallback layer; see src/config.ts and .env.example.
 */

import { serve } from "@hono/node-server";

import app from "./app.ts";
import { config, configWarnings, envFileKeys } from "./config.ts";
import { startLark, stopLark } from "./lark/client.ts";
import { logger } from "./logger.ts";

// Config is parsed before the logger exists, so its complaints are replayed
// here — first, so a bad value is visible above everything it may explain.
for (const warning of configWarnings) {
  logger.warn("configuration problem", { detail: warning });
}

logger.debug("environment loaded", {
  // Names only: values may be secrets.
  envFileKeys,
  envFileFound: envFileKeys.length > 0,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  logger.info("server listening", {
    url: `http://${config.host}:${info.port}`,
    address: info.address,
    port: info.port,
    family: info.family,
    pid: process.pid,
    nodeVersion: process.version,
    nodeEnv: config.nodeEnv,
    logLevel: logger.level,
  });
});

// Not awaited: the HTTP server must start serving immediately rather than wait
// on a gateway handshake. startLark contains its own failures and never rejects.
void startLark();

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info("shutdown signal received, closing server", { signal });
  stopLark();
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
