import { Hono } from "hono";

import { logger } from "./logger.ts";
import { requestLogger } from "./request-logger.ts";

export const SERVICE_NAME = "deeptag";

/** Response body of `GET /health`. */
export type HealthReport = {
  status: "ok";
  service: string;
  /** Seconds since this process started. */
  uptime: number;
  timestamp: string;
};

/**
 * The Hono application, kept free of any listening/bootstrap concerns so tests
 * can drive it directly via `app.request(...)` without opening a socket.
 */
const app = new Hono();

app.use("*", requestLogger());

app.onError((err, c) => {
  logger.error("unhandled request error", {
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: "Internal Server Error" }, 500);
});

app.get("/", (c) => c.text("Hono!"));

app.get("/health", (c) => {
  const report: HealthReport = {
    status: "ok",
    service: SERVICE_NAME,
    uptime: Math.round(process.uptime() * 1000) / 1000,
    timestamp: new Date().toISOString(),
  };
  return c.json(report);
});

export default app;
