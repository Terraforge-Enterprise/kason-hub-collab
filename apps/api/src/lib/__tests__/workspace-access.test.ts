import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../auth";
import { workspacesFor, hasWorkspace, requireWorkspaceOrRank } from "../workspace-access";

it("admin and manager are in both workspaces (superset)", () => {
  for (const r of ["admin", "manager"]) {
    expect(hasWorkspace(r, "operations")).toBe(true);
    expect(hasWorkspace(r, "accounting")).toBe(true);
  }
});

it("accountant is accounting-only", () => {
  expect(hasWorkspace("accountant", "accounting")).toBe(true);
  expect(hasWorkspace("accountant", "operations")).toBe(false);
});

it("editor/operator/viewer are operations-only", () => {
  for (const r of ["editor", "operator", "viewer"]) {
    expect(hasWorkspace(r, "operations")).toBe(true);
    expect(hasWorkspace(r, "accounting")).toBe(false);
  }
});

it("an unmapped role gets the empty set (default-deny)", () => {
  expect(workspacesFor("ghost").size).toBe(0);
  expect(hasWorkspace(undefined, "accounting")).toBe(false);
});

function appWith(role: string | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { c.set("session", role ? ({ role } as never) : (undefined as never)); await next(); });
  app.get("/x", requireWorkspaceOrRank("accounting", "editor"), (c) => c.json({ ok: true }));
  return app;
}
describe("requireWorkspaceOrRank", () => {
  it("accountant admitted by workspace", async () => {
    const res = await appWith("accountant").request("/x");
    expect(res.status).toBe(200);
  });
  it("editor admitted by rank", async () => {
    const res = await appWith("editor").request("/x");
    expect(res.status).toBe(200);
  });
  it("viewer denied", async () => {
    const res = await appWith("viewer").request("/x");
    expect(res.status).toBe(403);
  });
  it("no session 401", async () => {
    const res = await appWith(null).request("/x");
    expect(res.status).toBe(401);
  });
});
