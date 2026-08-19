import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the receipt service so the DB/bucket is never reached — routes tested
// in isolation (mirrors owner-billing.statement-line-routes.test.ts).
vi.mock("../owner-billing-receipts.service", () => ({
  uploadReceiptsService: vi.fn(),
  detachReceiptService: vi.fn(),
  listReceiptUrlsService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import {
  detachReceiptService,
  listReceiptUrlsService,
  uploadReceiptsService,
} from "../owner-billing-receipts.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerBillingRoutes);
  return app;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const INVOICE = "44444444-4444-4444-8444-444444444444";
const CHARGE = "55555555-5555-4555-8555-555555555555";
const KEY = `owner-statements/${OWNER}/receipts/66666666-7777-4777-8777-777777777777.pdf`;

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

const statementRow = {
  id: INVOICE,
  invoiceNumber: "OS-202606-11111111",
  invoiceType: "owner_statement",
  status: "draft",
  ownerPartyId: OWNER,
  partyId: OWNER,
  periodMonth: "2026-06-01T00:00:00.000Z",
  invoiceDate: "2026-06-15T00:00:00.000Z",
  dueDate: null,
  currency: "MYR",
  totalAmount: "120.00",
  sstAmount: "0.00",
  pdfKey: null,
  attachmentKeys: [KEY],
  lines: [],
  createdAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

const SIGNED = `https://signed.example/${encodeURIComponent(KEY)}?token=t`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uploadReceiptsService).mockResolvedValue({ ok: true, status: 201, data: statementRow });
  vi.mocked(detachReceiptService).mockResolvedValue({ ok: true, status: 200, data: statementRow });
  vi.mocked(listReceiptUrlsService).mockResolvedValue({
    ok: true,
    status: 200,
    data: [{ key: KEY, url: SIGNED }],
  });
});

function uploadReceipt(session: SessionPayload | null, opts: { chargeId?: string; withFile?: boolean } = {}) {
  const form = new FormData();
  if (opts.withFile !== false) {
    form.append("files", new File([new Uint8Array([1, 2, 3])], "r.pdf", { type: "application/pdf" }));
  }
  if (opts.chargeId) form.append("chargeId", opts.chargeId);
  return makeApp(session).request(`/statements/${INVOICE}/receipts`, { method: "POST", body: form });
}

describe("POST /statements/:id/receipts (bulk upload = admin)", () => {
  it("admin gets 201 + the statement; id + parsed files forwarded", async () => {
    const res = await uploadReceipt(adminSession);
    expect(res.status).toBe(201);
    expect(uploadReceiptsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      INVOICE,
      expect.arrayContaining([
        expect.objectContaining({ filename: "r.pdf", mimeType: "application/pdf" }),
      ]),
      undefined,
    );
  });

  it("forwards a chargeId from the form (line-level)", async () => {
    await uploadReceipt(adminSession, { chargeId: CHARGE });
    expect(uploadReceiptsService).toHaveBeenCalledWith(
      expect.anything(),
      INVOICE,
      expect.any(Array),
      CHARGE,
    );
  });

  it("403s for a manager (upload requires admin)", async () => {
    const res = await uploadReceipt(managerSession);
    expect(res.status).toBe(403);
    expect(uploadReceiptsService).not.toHaveBeenCalled();
  });

  it("403s for an editor", async () => {
    const res = await uploadReceipt(editorSession);
    expect(res.status).toBe(403);
  });

  it("403s for a portal (owner) session", async () => {
    const res = await uploadReceipt(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await uploadReceipt(null);
    expect(res.status).toBe(401);
  });

  it("400s when no file field is present", async () => {
    const res = await uploadReceipt(adminSession, { withFile: false });
    expect(res.status).toBe(400);
    expect(uploadReceiptsService).not.toHaveBeenCalled();
  });

  it("maps a service 404 (cross-org statement) to HTTP 404", async () => {
    vi.mocked(uploadReceiptsService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await uploadReceipt(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s the POST while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await uploadReceipt(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

function detachReceipt(session: SessionPayload | null, key = KEY) {
  return makeApp(session).request(
    `/statements/${INVOICE}/receipts/${encodeURIComponent(key)}/detach`,
    { method: "POST" },
  );
}

describe("POST /statements/:id/receipts/:key/detach (detach = admin)", () => {
  it("admin gets 200; id + decoded key forwarded", async () => {
    const res = await detachReceipt(adminSession);
    expect(res.status).toBe(200);
    expect(detachReceiptService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      INVOICE,
      KEY,
    );
  });

  it("403s for a manager", async () => {
    const res = await detachReceipt(managerSession);
    expect(res.status).toBe(403);
    expect(detachReceiptService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await detachReceipt(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(detachReceiptService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Receipt not found on this statement",
    });
    const res = await detachReceipt(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await detachReceipt(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

function receiptUrls(session: SessionPayload | null) {
  return makeApp(session).request(`/statements/${INVOICE}/receipts/urls`, { method: "GET" });
}

describe("GET /statements/:id/receipts/urls (signed view URLs = admin)", () => {
  it("admin gets 200 + one {key,url} per attachmentKey; id forwarded", async () => {
    const res = await receiptUrls(adminSession);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ key: string; url: string }> };
    expect(body.data).toEqual([{ key: KEY, url: SIGNED }]);
    expect(listReceiptUrlsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      INVOICE,
    );
  });

  it("403s for a manager (signing receipts requires admin, like upload/detach)", async () => {
    const res = await receiptUrls(managerSession);
    expect(res.status).toBe(403);
    expect(listReceiptUrlsService).not.toHaveBeenCalled();
  });

  it("403s for an editor", async () => {
    const res = await receiptUrls(editorSession);
    expect(res.status).toBe(403);
  });

  it("403s for a portal (owner) session", async () => {
    const res = await receiptUrls(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await receiptUrls(null);
    expect(res.status).toBe(401);
  });

  it("maps a service 404 (cross-org / unknown statement) to HTTP 404", async () => {
    vi.mocked(listReceiptUrlsService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await receiptUrls(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await receiptUrls(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
