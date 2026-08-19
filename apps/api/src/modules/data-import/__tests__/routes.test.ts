// HTTP-harness tests for the data-import routes (M9).
//
// Mocks ./service so this tests ONLY the HTTP/role/flag wiring.
// The flag gate reads process.env per-request (lib/feature-flags), so tests
// toggle ENABLE_PHASE2_TENANT_TRACKER without any module re-import tricks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../service", () => ({
  listRunsService: vi.fn(async () => ({ ok: true, status: 200, data: [] })),
  getRunService: vi.fn(async () => ({ ok: true, status: 200, data: { id: "r1" } })),
  runImport: vi.fn(async () => ({
    ok: true,
    status: 200,
    data: { runId: "r1", counts: {}, reportKey: null },
  })),
}));

import { listRunsService, getRunService, runImport } from "../service";
import { dataImportRoutes } from "../routes";

const listRunsMock = vi.mocked(listRunsService);
const getRunMock = vi.mocked(getRunService);
const runImportMock = vi.mocked(runImport);

// ── Harness ──────────────────────────────────────────────────────────────────

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/api/data-import", dataImportRoutes);
  return app;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

const ORG = "00000000-0000-4000-8000-000000000001";

const adminSession: SessionPayload = {
  userId: "u-admin",
  orgId: ORG,
  role: "admin",
  userType: "operator",
};
const editorSession: SessionPayload = {
  userId: "u-editor",
  orgId: ORG,
  role: "editor",
  userType: "operator",
};
const viewerSession: SessionPayload = {
  userId: "u-viewer",
  orgId: ORG,
  role: "viewer",
  userType: "operator",
};

// ── Env lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.ENABLE_PHASE2_TENANT_TRACKER = "true";
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
});

// ── GET /runs ─────────────────────────────────────────────────────────────────

describe("GET /api/data-import/runs", () => {
  it("viewer → 403", async () => {
    const res = await makeApp(viewerSession).request("/api/data-import/runs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor → 200, body []", async () => {
    const res = await makeApp(editorSession).request("/api/data-import/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(listRunsMock).toHaveBeenCalledTimes(1);
  });
});

// ── GET /runs/:id ─────────────────────────────────────────────────────────────

describe("GET /api/data-import/runs/:id", () => {
  it("editor → 200 with run data", async () => {
    const res = await makeApp(editorSession).request("/api/data-import/runs/r1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "r1" });
    expect(getRunMock).toHaveBeenCalledTimes(1);
  });

  it("editor → 404 when getRunService returns not-ok 404", async () => {
    getRunMock.mockResolvedValueOnce({ ok: false, status: 404, error: "import run not found" });
    const res = await makeApp(editorSession).request("/api/data-import/runs/missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "import run not found" });
  });
});

// ── POST /runs ────────────────────────────────────────────────────────────────

describe("POST /api/data-import/runs", () => {
  it("editor → 403 (POST is admin-only)", async () => {
    const res = await makeApp(editorSession).request("/api/data-import/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(runImportMock).not.toHaveBeenCalled();
  });

  it("admin → 200 with {dryRun:true}", async () => {
    const res = await makeApp(adminSession).request("/api/data-import/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "r1", counts: {}, reportKey: null });
    expect(runImportMock).toHaveBeenCalledTimes(1);
    expect(runImportMock.mock.calls[0]![1]).toEqual({ dryRun: true });
  });

  it("admin → 200 with no body (dryRun defaults to true)", async () => {
    const res = await makeApp(adminSession).request("/api/data-import/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(runImportMock.mock.calls[0]![1]).toEqual({ dryRun: true });
  });

  it("admin → 400 when body has invalid dryRun type", async () => {
    const res = await makeApp(adminSession).request("/api/data-import/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: "not-a-boolean" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(runImportMock).not.toHaveBeenCalled();
  });
});

// ── Flag OFF ──────────────────────────────────────────────────────────────────

describe("flag OFF — per-request gate", () => {
  it("GET /runs → 404 { error: 'not_found' }", async () => {
    delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
    const res = await makeApp(adminSession).request("/api/data-import/runs");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("POST /runs → 404 { error: 'not_found' }", async () => {
    delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
    const res = await makeApp(adminSession).request("/api/data-import/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it('flag value "false" is OFF too', async () => {
    process.env.ENABLE_PHASE2_TENANT_TRACKER = "false";
    const res = await makeApp(adminSession).request("/api/data-import/runs");
    expect(res.status).toBe(404);
  });
});
