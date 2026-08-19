import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireRole } from "../require-role";

function app(minRole: "admin" | "manager" | "editor") {
  const a = new Hono<{ Variables: { session: any } }>();
  a.use("*", async (c, next) => {
    c.set("session", (globalThis as any).__testSession);
    return next();
  });
  a.use("*", requireRole(minRole));
  a.get("/", (c) => c.json({ ok: true }));
  return a;
}

function withSession(session: any, fn: () => Response | Promise<Response>) {
  (globalThis as any).__testSession = session;
  return Promise.resolve(fn()).finally(() => ((globalThis as any).__testSession = undefined));
}

describe("requireRole", () => {
  it("rejects when session missing", async () => {
    const res = await withSession(null, () => app("editor").request("/"));
    expect(res.status).toBe(401);
  });

  it("rejects when userType is not operator", async () => {
    const res = await withSession({ userType: "tenant", role: "admin" }, () => app("editor").request("/"));
    expect(res.status).toBe(403);
  });

  it("allows admin to hit editor-gated route", async () => {
    const res = await withSession({ userType: "operator", role: "admin" }, () => app("editor").request("/"));
    expect(res.status).toBe(200);
  });

  it("allows manager to hit editor-gated route", async () => {
    const res = await withSession({ userType: "operator", role: "manager" }, () => app("editor").request("/"));
    expect(res.status).toBe(200);
  });

  it("allows editor to hit editor-gated route", async () => {
    const res = await withSession({ userType: "operator", role: "editor" }, () => app("editor").request("/"));
    expect(res.status).toBe(200);
  });

  it("rejects editor from manager-gated route", async () => {
    const res = await withSession({ userType: "operator", role: "editor" }, () => app("manager").request("/"));
    expect(res.status).toBe(403);
  });

  it("rejects manager from admin-gated route", async () => {
    const res = await withSession({ userType: "operator", role: "manager" }, () => app("admin").request("/"));
    expect(res.status).toBe(403);
  });

  it("rejects viewer from any admin-tier gate", async () => {
    const res = await withSession({ userType: "operator", role: "viewer" }, () => app("editor").request("/"));
    expect(res.status).toBe(403);
  });
});
