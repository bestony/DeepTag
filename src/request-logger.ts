import type { MiddlewareHandler } from "hono";

import { logger } from "./logger.ts";

/**
 * Structured request logging middleware.
 *
 * Hono's built-in `hono/logger` emits a single pre-formatted, ANSI-colored
 * string, which does not survive being embedded in a JSON log line. This emits
 * the same information as discrete, greppable fields instead.
 *
 * The arrival line is `debug` (useful to spot requests that never finish) while
 * the completion line is `info`, so production keeps one line per request.
 *
 * Query strings are deliberately not logged: they routinely carry tokens.
 */
export const requestLogger = (): MiddlewareHandler => async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;

  logger.debug("request received", { method, path });
  const start = performance.now();

  // A throwing handler rejects here; app.onError owns that reporting path.
  await next();

  logger.info("request completed", {
    method,
    path,
    status: c.res.status,
    durationMs: Math.round((performance.now() - start) * 1000) / 1000,
  });
};
