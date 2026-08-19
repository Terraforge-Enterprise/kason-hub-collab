import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the receipt service so DB/Chromium are never reached — the route is
// tested in isolation (mirrors proof-pack-routes.test.ts pattern exactly).
vi.mock("../owner-ledger-receipt.service", () => ({
  buildReceiptWithBillsPdf: vi.fn(),
}));

import { ownerLedgerRoutes } from "../owner-ledger.routes";
import { buildReceiptWithBillsPdf } from "../owner-ledger-receipt.service";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerLedgerRoutes);
  return app;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const APT = "22222222-2222-4222-8222-222222222222";
const MONTH = "2026-06";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

// A minimal "%PDF-" stream the service returns; the route just streams it.
const FAKE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildReceiptWithBillsPdf).mockResolvedValue(FAKE_PDF);
});

function getReceipt(
  session: SessionPayload | null,
  query = `ownerPartyId=${OWNER}&month=${MONTH}&apartmentId=${APT}`,
) {
  return makeApp(session).request(`/receipt?${query}`, { method: "GET" });
}

describe("GET /receipt (itemized ledger receipt PDF = admin/manager)", () => {
  it("manager gets 200 application/pdf + attachment disposition; ctx + params forwarded", async () => {
    const res = await getReceipt(managerSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(`receipt-${MONTH}.pdf`);
    // Body must be the streamed bytes
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(buildReceiptWithBillsPdf).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u2", actorRole: "manager" }),
      OWNER,
      MONTH,
      APT,
    );
  });

  it("admin is allowed (receipt is admin/manager)", async () => {
    const res = await getReceipt(adminSession);
    expect(res.status).toBe(200);
  });

  it("missing apartmentId forwards apartmentId=null (all units scope)", async () => {
    await getReceipt(adminSession, `ownerPartyId=${OWNER}&month=${MONTH}`);
    expect(buildReceiptWithBillsPdf).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      MONTH,
      null,
    );
  });

  it("maps a null service result (no ledger entries) to HTTP 404", async () => {
    vi.mocked(buildReceiptWithBillsPdf).mockResolvedValueOnce(null);
    const res = await getReceipt(adminSession);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no ledger entries/i);
  });

  it("403s for an editor (below manager)", async () => {
    const res = await getReceipt(editorSession);
    expect(res.status).toBe(403);
    expect(buildReceiptWithBillsPdf).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await getReceipt(ownerPortalSession);
    expect(res.status).toBe(403);
    expect(buildReceiptWithBillsPdf).not.toHaveBeenCalled();
  });

  it("401s for a missing session", async () => {
    const res = await getReceipt(null);
    expect(res.status).toBe(401);
  });

  it("400s a malformed query (missing ownerPartyId)", async () => {
    const res = await getReceipt(adminSession, `month=${MONTH}`);
    expect(res.status).toBe(400);
    expect(buildReceiptWithBillsPdf).not.toHaveBeenCalled();
  });

  it("400s a malformed month (not YYYY-MM)", async () => {
    const res = await getReceipt(adminSession, `ownerPartyId=${OWNER}&month=June%202026`);
    expect(res.status).toBe(400);
    expect(buildReceiptWithBillsPdf).not.toHaveBeenCalled();
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await getReceipt(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
