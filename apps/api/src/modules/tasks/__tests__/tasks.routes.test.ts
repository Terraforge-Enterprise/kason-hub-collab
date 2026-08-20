import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { tasksRoutes } from "../tasks.routes";
import {
  archiveTaskService,
  assignTaskService,
  createTaskService,
  listTasksService,
  moveTaskService,
} from "../tasks.service";
import { removeTaskAttachment } from "../tasks-media.service";

// Mock all service functions so DB is never reached.
vi.mock("../tasks.service", () => ({
  listTasksService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  getTaskService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "t1" } }),
  createTaskService: vi.fn().mockResolvedValue({ ok: true, status: 201, data: { id: "t1" } }),
  updateTaskService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "t1" } }),
  moveTaskService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "t1" } }),
  assignTaskService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "t1" } }),
  archiveTaskService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "t1" } }),
  restoreTaskService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "t1" } }),
}));

vi.mock("../tasks-media.service", () => ({
  mintTaskAttachmentUploadUrl: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { uploadUrl: "https://upload" } }),
  completeTaskAttachment: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { attachmentKeys: [] } }),
  listTaskAttachmentUrls: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  removeTaskAttachment: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { attachmentKeys: [] } }),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", tasksRoutes);
  return app;
}

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const UNIT_ID = "33333333-3333-4333-8333-333333333333";
const ISO = "2026-06-11T00:00:00.000Z";

const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const tenantSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "tenant" };
const ownerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

// Every endpoint on the router — used for the 401/403 sweeps.
const ROUTE_TABLE: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/" },
  { method: "POST", path: "/", body: { title: "Fix kitchen light" } },
  { method: "GET", path: `/${TASK_ID}` },
  { method: "PATCH", path: `/${TASK_ID}`, body: { updatedAt: ISO, title: "New title" } },
  { method: "PATCH", path: `/${TASK_ID}/status`, body: { updatedAt: ISO, status: "todo" } },
  { method: "PATCH", path: `/${TASK_ID}/assignee`, body: { updatedAt: ISO, assigneeUserId: null } },
  { method: "POST", path: `/${TASK_ID}/archive`, body: { updatedAt: ISO } },
  { method: "POST", path: `/${TASK_ID}/restore`, body: { updatedAt: ISO } },
  {
    method: "POST",
    path: `/${TASK_ID}/attachments/upload-url`,
    body: { filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1024 },
  },
  { method: "POST", path: `/${TASK_ID}/attachments/complete`, body: { storageKey: "tasks/o1/k.jpg" } },
  { method: "GET", path: `/${TASK_ID}/attachments/download-urls` },
  { method: "DELETE", path: `/${TASK_ID}/attachments?key=tasks%2Fo1%2Fk.jpg` },
];

function send(
  app: ReturnType<typeof makeApp>,
  r: { method: string; path: string; body?: unknown },
) {
  return app.request(r.path, {
    method: r.method,
    ...(r.body !== undefined
      ? { body: JSON.stringify(r.body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

beforeAll(() => {
  process.env.ENABLE_PHASE2_TASKS = "1";
});

afterAll(() => {
  delete process.env.ENABLE_PHASE2_TASKS;
});

describe("tasksRoutes auth sweep", () => {
  it.each(ROUTE_TABLE)("missing session gets 401 on $method $path", async (r) => {
    const res = await send(makeApp(null), r);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  const portalSessions: Array<[string, SessionPayload]> = [
    ["tenant", tenantSession],
    ["owner", ownerSession],
  ];
  for (const [label, session] of portalSessions) {
    it.each(ROUTE_TABLE)(`portal ${label} gets 403 on $method $path`, async (r) => {
      const res = await send(makeApp(session), r);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }
});

describe("tasksRoutes happy paths", () => {
  it("editor can GET / (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[0]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("GET /?relatedUnitId=<uuid> passes the filter through to listTasksService", async () => {
    const res = await send(makeApp(editorSession), {
      method: "GET",
      path: `/?relatedUnitId=${UNIT_ID}`,
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(listTasksService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2" }),
      expect.objectContaining({ relatedUnitId: UNIT_ID }),
    );
  });

  it("editor can POST / (201) and parsed body reaches the service", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[1]!);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "t1" } });
    expect(vi.mocked(createTaskService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "editor" }),
      expect.objectContaining({ title: "Fix kitchen light", priority: "medium" }),
    );
  });

  it("editor can GET /:id (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[2]!);
    expect(res.status).toBe(200);
  });

  it("editor can PATCH /:id (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[3]!);
    expect(res.status).toBe(200);
  });

  it("editor can PATCH /:id/status (200) with taskId merged from the route param", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(moveTaskService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ taskId: TASK_ID, status: "todo", updatedAt: ISO }),
    );
  });

  it("editor can PATCH /:id/assignee (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[5]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(assignTaskService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ taskId: TASK_ID, assigneeUserId: null }),
    );
  });

  it("manager can POST /:id/archive (200)", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[6]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(archiveTaskService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      expect.objectContaining({ taskId: TASK_ID, updatedAt: ISO }),
    );
  });

  it("manager can POST /:id/restore (200)", async () => {
    const res = await send(makeApp(managerSession), ROUTE_TABLE[7]!);
    expect(res.status).toBe(200);
  });

  it("editor gets 403 on POST /:id/archive (manager-only)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[6]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor gets 403 on POST /:id/restore (manager-only)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[7]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor can POST /:id/attachments/upload-url (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[8]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { uploadUrl: "https://upload" } });
  });

  it("editor can POST /:id/attachments/complete (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[9]!);
    expect(res.status).toBe(200);
  });

  it("editor can GET /:id/attachments/download-urls (200)", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[10]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("editor can DELETE /:id/attachments?key=... (200) and the key reaches the service", async () => {
    const res = await send(makeApp(editorSession), ROUTE_TABLE[11]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(removeTaskAttachment)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      TASK_ID,
      "tasks/o1/k.jpg",
    );
  });
});

describe("tasksRoutes validation", () => {
  it("POST / with empty title returns 400 with fieldErrors", async () => {
    const res = await send(makeApp(editorSession), {
      method: "POST",
      path: "/",
      body: { title: "" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("title");
  });

  it("GET /?relatedUnitId=not-a-uuid returns 400 (schema guards the filter)", async () => {
    const res = await send(makeApp(editorSession), {
      method: "GET",
      path: "/?relatedUnitId=not-a-uuid",
    });
    expect(res.status).toBe(400);
  });

  it("POST / with malformed JSON returns 400 Invalid JSON body", async () => {
    const res = await makeApp(editorSession).request("/", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("PATCH /:id/status with a bad status returns 400", async () => {
    const res = await send(makeApp(editorSession), {
      method: "PATCH",
      path: `/${TASK_ID}/status`,
      body: { updatedAt: ISO, status: "archived" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("status");
  });

  it("PATCH /:id/assignee with a non-uuid assignee returns 400", async () => {
    const res = await send(makeApp(editorSession), {
      method: "PATCH",
      path: `/${TASK_ID}/assignee`,
      body: { updatedAt: ISO, assigneeUserId: "not-a-uuid" },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /:id/attachments without key returns 400 Missing key", async () => {
    const res = await makeApp(editorSession).request(`/${TASK_ID}/attachments`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing key" });
  });

  it("PATCH /:id with valid body forwards assignee uuid input untouched", async () => {
    const res = await send(makeApp(editorSession), {
      method: "PATCH",
      path: `/${TASK_ID}/assignee`,
      body: { updatedAt: ISO, assigneeUserId: USER_ID },
    });
    expect(res.status).toBe(200);
  });
});

describe("tasksRoutes service error translation", () => {
  it("maps a service 409 to HTTP 409 with the error message", async () => {
    vi.mocked(moveTaskService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Record changed — reloaded",
    });
    const res = await send(makeApp(editorSession), ROUTE_TABLE[4]!);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Record changed — reloaded" });
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(createTaskService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Unit not found",
    });
    const res = await send(makeApp(editorSession), ROUTE_TABLE[1]!);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unit not found" });
  });
});

describe("tasksRoutes feature-flag gate", () => {
  it("returns canonical 404 not_found while ENABLE_PHASE2_TASKS is dark, even for manager", async () => {
    delete process.env.ENABLE_PHASE2_TASKS;
    try {
      const res = await send(makeApp(managerSession), ROUTE_TABLE[0]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_TASKS = "1";
    }
  });
});
