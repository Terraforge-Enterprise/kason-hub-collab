import { createMiddleware } from "hono/factory";

/**
 * Keep task-backed catalogs dark with the rest of the Tasks workspace.
 * A canonical 404 avoids exposing disabled module routes or their shape.
 */
export const tasksFlagGate = createMiddleware(async (c, next) => {
  if (process.env.ENABLE_PHASE2_TASKS !== "1") {
    return c.json({ error: "not_found" }, 404);
  }
  await next();
});
