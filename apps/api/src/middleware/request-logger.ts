import { createMiddleware } from "hono/factory";

export const requestLogger = createMiddleware(async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  const level = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";

  console.log(
    JSON.stringify({
      level,
      method,
      path,
      status,
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    }),
  );
});
