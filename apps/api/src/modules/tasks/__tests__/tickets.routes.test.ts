import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { ticketsRoutes } from "../tickets.routes";
import { unitScopedTasksRoutes } from "../units.routes";
import {
  createTicketService,
  quickLogService,
  reopenTicketService,
  resolveTicketService,
  voidTicketService,
} from "../tickets.service";
import { mintHistoryAttachmentUploadUrl, removeTicketAttachment } from "../tasks-media.service";

// Mock all service functions so DB is never reached.
vi.mock("../tickets.service", () => ({
  createTicketService: vi.fn().mockResolvedValue({ ok: true, status: 201, data: { id: "tk1" } }),
  listUnitTicketsService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  getTicketService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "tk1" } }),
  updateTicketService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "tk1" } }),
  resolveTicketService: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    data: { ticket: { id: "tk1" }, history: { id: "h1" } },
  }),
  voidTicketService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "tk1" } }),
  reopenTicketService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "tk1" } }),
  listUnitHistoryService: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  quickLogService: vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    data: { history: { id: "h1" }, ticketId: "tk1" },
  }),
}));

vi.mock("../tasks-media.service", () => ({
  mintTicketAttachmentUploadUrl: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { uploadUrl: "https://upload" } }),
  completeTicketAttachment: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { attachmentKeys: [] } }),
  listTicketAttachmentUrls: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
  removeTicketAttachment: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { attachmentKeys: [] } }),
  mintHistoryAttachmentUploadUrl: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { uploadUrl: "https://upload" } }),
  listUnitHistoryAttachmentUrls: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
}));

function makeTicketsApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ticketsRoutes);
  return app;
}

function makeUnitsApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", unitScopedTasksRoutes);
  return app;
}

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const UNIT_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_ID = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-06-11T00:00:00.000Z";

const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const tenantSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "tenant" };
const ownerSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

type RouteSpec = { method: string; path: string; body?: unknown };

// Every endpoint on the tickets router — used for the 401/403 sweeps.
const TICKETS_ROUTE_TABLE: RouteSpec[] = [
  { method: "GET", path: `/${TICKET_ID}` },
  { method: "PATCH", path: `/${TICKET_ID}`, body: { updatedAt: ISO, title: "New title" } },
  {
    method: "POST",
    path: `/${TICKET_ID}/resolve`,
    body: { updatedAt: ISO, entry: "Replaced washer", occurredOn: ISO },
  },
  { method: "POST", path: `/${TICKET_ID}/void`, body: { updatedAt: ISO } },
  { method: "POST", path: `/${TICKET_ID}/reopen`, body: { updatedAt: ISO } },
  {
    method: "POST",
    path: `/${TICKET_ID}/attachments/upload-url`,
    body: { filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1024 },
  },
  {
    method: "POST",
    path: `/${TICKET_ID}/attachments/complete`,
    body: { storageKey: `tickets/${TICKET_ID}/k.jpg` },
  },
  { method: "GET", path: `/${TICKET_ID}/attachments/download-urls` },
  { method: "DELETE", path: `/${TICKET_ID}/attachments?key=tickets%2Fo1%2Fk.jpg` },
];

// Every endpoint on the unit-scoped router.
const UNITS_ROUTE_TABLE: RouteSpec[] = [
  { method: "GET", path: `/${UNIT_ID}/tickets` },
  { method: "POST", path: `/${UNIT_ID}/tickets`, body: { title: "Leaky tap" } },
  { method: "GET", path: `/${UNIT_ID}/history` },
  {
    method: "POST",
    path: `/${UNIT_ID}/history`,
    body: { entry: "1701 kitchen light replaced", occurredOn: ISO },
  },
  {
    method: "POST",
    path: `/${UNIT_ID}/history/attachments/upload-url`,
    body: { filename: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1024 },
  },
  { method: "GET", path: `/${UNIT_ID}/history/attachments/download-urls` },
];

function send(
  app: ReturnType<typeof makeTicketsApp>,
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

describe("ticketsRoutes auth sweep", () => {
  it.each(TICKETS_ROUTE_TABLE)("missing session gets 401 on $method $path", async (r) => {
    const res = await send(makeTicketsApp(null), r);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  const portalSessions: Array<[string, SessionPayload]> = [
    ["tenant", tenantSession],
    ["owner", ownerSession],
  ];
  for (const [label, session] of portalSessions) {
    it.each(TICKETS_ROUTE_TABLE)(`portal ${label} gets 403 on $method $path`, async (r) => {
      const res = await send(makeTicketsApp(session), r);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }
});

describe("unitScopedTasksRoutes auth sweep", () => {
  it.each(UNITS_ROUTE_TABLE)("missing session gets 401 on $method $path", async (r) => {
    const res = await send(makeUnitsApp(null), r);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  const portalSessions: Array<[string, SessionPayload]> = [
    ["tenant", tenantSession],
    ["owner", ownerSession],
  ];
  for (const [label, session] of portalSessions) {
    it.each(UNITS_ROUTE_TABLE)(`portal ${label} gets 403 on $method $path`, async (r) => {
      const res = await send(makeUnitsApp(session), r);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }
});

describe("ticketsRoutes role gates (void/reopen are manager-only)", () => {
  it("editor gets 403 on POST /:id/void", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[3]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor gets 403 on POST /:id/reopen", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[4]!);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("manager can POST /:id/void (200) with ticketId merged from the route param", async () => {
    const res = await send(makeTicketsApp(managerSession), TICKETS_ROUTE_TABLE[3]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(voidTicketService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      expect.objectContaining({ ticketId: TICKET_ID, updatedAt: ISO }),
    );
  });

  it("manager can POST /:id/reopen (200)", async () => {
    const res = await send(makeTicketsApp(managerSession), TICKETS_ROUTE_TABLE[4]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(reopenTicketService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "manager" }),
      expect.objectContaining({ ticketId: TICKET_ID, updatedAt: ISO }),
    );
  });
});

describe("ticketsRoutes happy paths (editor)", () => {
  it("editor can GET /:id (200)", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[0]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "tk1" } });
  });

  it("editor can PATCH /:id (200)", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[1]!);
    expect(res.status).toBe(200);
  });

  it("editor can POST /:id/resolve (200) with ticketId merged from the route param", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[2]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ticket: { id: "tk1" }, history: { id: "h1" } } });
    expect(vi.mocked(resolveTicketService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "editor" }),
      expect.objectContaining({
        ticketId: TICKET_ID,
        entry: "Replaced washer",
        occurredOn: ISO,
        attachmentKeys: [],
      }),
    );
  });

  it("editor can POST /:id/attachments/upload-url (200)", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[5]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { uploadUrl: "https://upload" } });
  });

  it("editor can POST /:id/attachments/complete (200)", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[6]!);
    expect(res.status).toBe(200);
  });

  it("editor can GET /:id/attachments/download-urls (200)", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[7]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("editor can DELETE /:id/attachments?key=... (200) and the key reaches the service", async () => {
    const res = await send(makeTicketsApp(editorSession), TICKETS_ROUTE_TABLE[8]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(removeTicketAttachment)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      TICKET_ID,
      "tickets/o1/k.jpg",
    );
  });
});

describe("unitScopedTasksRoutes happy paths (editor)", () => {
  it("editor can GET /:unitId/tickets (200)", async () => {
    const res = await send(makeUnitsApp(editorSession), UNITS_ROUTE_TABLE[0]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("editor can POST /:unitId/tickets (201) with unitId merged from the route param", async () => {
    const res = await send(makeUnitsApp(editorSession), UNITS_ROUTE_TABLE[1]!);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "tk1" } });
    expect(vi.mocked(createTicketService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2" }),
      expect.objectContaining({ unitId: UNIT_ID, title: "Leaky tap", warrantyFlag: false }),
    );
  });

  it("editor can GET /:unitId/history (200)", async () => {
    const res = await send(makeUnitsApp(editorSession), UNITS_ROUTE_TABLE[2]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("editor can POST /:unitId/history (201 quick-log) with unitId merged", async () => {
    const res = await send(makeUnitsApp(editorSession), UNITS_ROUTE_TABLE[3]!);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { history: { id: "h1" }, ticketId: "tk1" } });
    expect(vi.mocked(quickLogService)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({
        unitId: UNIT_ID,
        entry: "1701 kitchen light replaced",
        occurredOn: ISO,
      }),
    );
  });

  it("editor can POST /:unitId/history/attachments/upload-url (200) with the unitId param", async () => {
    const res = await send(makeUnitsApp(editorSession), UNITS_ROUTE_TABLE[4]!);
    expect(res.status).toBe(200);
    expect(vi.mocked(mintHistoryAttachmentUploadUrl)).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      UNIT_ID,
      expect.objectContaining({ mimeType: "image/jpeg", sizeBytes: 1024 }),
    );
  });

  it("editor can GET /:unitId/history/attachments/download-urls (200)", async () => {
    const res = await send(makeUnitsApp(editorSession), UNITS_ROUTE_TABLE[5]!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });
});

describe("validation (400s)", () => {
  it("POST /:unitId/tickets with empty title returns 400 with fieldErrors", async () => {
    const res = await send(makeUnitsApp(editorSession), {
      method: "POST",
      path: `/${UNIT_ID}/tickets`,
      body: { title: "" },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("title");
  });

  it("POST /:unitId/tickets WITH attachmentKeys returns 400 (strict schema rejects unknown key)", async () => {
    vi.mocked(createTicketService).mockClear();
    const res = await send(makeUnitsApp(editorSession), {
      method: "POST",
      path: `/${UNIT_ID}/tickets`,
      body: { title: "Leaky tap", attachmentKeys: [`tickets/${TICKET_ID}/k.jpg`] },
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(createTicketService)).not.toHaveBeenCalled();
  });

  it("POST /:unitId/history (quick-log) without entry returns 400", async () => {
    const res = await send(makeUnitsApp(editorSession), {
      method: "POST",
      path: `/${UNIT_ID}/history`,
      body: { occurredOn: ISO },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("entry");
  });

  it("POST /:id/resolve without entry returns 400", async () => {
    const res = await send(makeTicketsApp(editorSession), {
      method: "POST",
      path: `/${TICKET_ID}/resolve`,
      body: { updatedAt: ISO, occurredOn: ISO },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(json.fieldErrors).toHaveProperty("entry");
  });

  it("DELETE /:id/attachments without key returns 400 Missing key", async () => {
    const res = await makeTicketsApp(editorSession).request(`/${TICKET_ID}/attachments`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing key" });
  });
});

describe("immutable history — mutation routes must not exist (404 by absence)", () => {
  it.each([
    { method: "PATCH", path: `/${UNIT_ID}/history` },
    { method: "DELETE", path: `/${UNIT_ID}/history` },
    { method: "PATCH", path: `/${UNIT_ID}/history/${HISTORY_ID}` },
    { method: "DELETE", path: `/${UNIT_ID}/history/${HISTORY_ID}` },
  ])("$method $path returns 404 on the unit-scoped router", async (r) => {
    const res = await send(makeUnitsApp(managerSession), {
      ...r,
      body: { entry: "tamper", updatedAt: ISO },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id returns 404 on the tickets router (tickets retire via void)", async () => {
    const res = await makeTicketsApp(managerSession).request(`/${TICKET_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("feature-flag gate", () => {
  it("ticketsRoutes returns canonical 404 not_found while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_TASKS;
    try {
      const res = await send(makeTicketsApp(managerSession), TICKETS_ROUTE_TABLE[0]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_TASKS = "1";
    }
  });

  it("unitScopedTasksRoutes returns canonical 404 not_found while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_TASKS;
    try {
      const res = await send(makeUnitsApp(managerSession), UNITS_ROUTE_TABLE[0]!);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_TASKS = "1";
    }
  });
});
