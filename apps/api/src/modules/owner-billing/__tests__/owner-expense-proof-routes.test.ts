import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// Mock the proof service so the DB/bucket is never reached — routes tested in
// isolation (mirrors owner-billing.receipt-routes.test.ts).
vi.mock("../owner-expense-proof.service", () => ({
  attachExpenseProofService: vi.fn(),
  detachExpenseProofService: vi.fn(),
  listExpenseProofUrlsService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import {
  attachExpenseProofService,
  detachExpenseProofService,
  listExpenseProofUrlsService,
} from "../owner-expense-proof.service";

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
const APT = "22222222-2222-4222-8222-222222222222";
const PROOF = "33333333-3333-4333-8333-333333333333";
const MONTH = "2026-06";

const adminSession: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };
const ownerPortalSession: SessionPayload = { userId: "u4", orgId: "o1", role: "viewer", userType: "owner" };

const proofRow = {
  id: PROOF,
  category: "utilities_tnb",
  filename: "tnb.png",
  apartmentId: APT,
  createdAt: "2026-06-15T00:00:00.000Z",
};
const groupRow = {
  category: "utilities_tnb",
  proofs: [
    { id: PROOF, filename: "tnb.png", url: "https://signed.example/x?token=t", source: "manual" as const, readOnly: false },
  ],
};

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(attachExpenseProofService).mockResolvedValue({ ok: true, status: 201, data: [proofRow] });
  vi.mocked(detachExpenseProofService).mockResolvedValue({ ok: true, status: 200, data: { id: PROOF } });
  vi.mocked(listExpenseProofUrlsService).mockResolvedValue({ ok: true, status: 200, data: [groupRow] });
});

// ─── POST /expense-proofs (attach = admin, multipart) ──────────────────────

interface ProofFields {
  ownerPartyId?: string;
  statementMonth?: string;
  apartmentId?: string;
  category?: string;
  withFile?: boolean;
}
const FULL: ProofFields = { ownerPartyId: OWNER, statementMonth: MONTH, apartmentId: APT, category: "utilities_tnb" };

function buildForm(fields: ProofFields): FormData {
  const form = new FormData();
  if (fields.withFile !== false) {
    form.append("files", new File([new Uint8Array([1, 2, 3])], "tnb.png", { type: "image/png" }));
  }
  if (fields.ownerPartyId !== undefined) form.append("ownerPartyId", fields.ownerPartyId);
  if (fields.statementMonth !== undefined) form.append("statementMonth", fields.statementMonth);
  if (fields.apartmentId !== undefined) form.append("apartmentId", fields.apartmentId);
  if (fields.category !== undefined) form.append("category", fields.category);
  return form;
}

function postProof(session: SessionPayload | null, fields: ProofFields = FULL) {
  return makeApp(session).request("/expense-proofs", { method: "POST", body: buildForm(fields) });
}

describe("POST /expense-proofs (attach = admin)", () => {
  it("admin gets 201; ctx + parsed fields + files forwarded", async () => {
    const res = await postProof(adminSession);
    expect(res.status).toBe(201);
    expect(attachExpenseProofService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1", actorRole: "admin" }),
      { ownerPartyId: OWNER, statementMonth: MONTH, apartmentId: APT, category: "utilities_tnb" },
      expect.arrayContaining([
        expect.objectContaining({ filename: "tnb.png", mimeType: "image/png" }),
      ]),
    );
  });

  it("a missing apartmentId field forwards apartmentId: null (legacy combined)", async () => {
    await postProof(adminSession, { ownerPartyId: OWNER, statementMonth: MONTH, category: "utilities_tnb" });
    expect(attachExpenseProofService).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apartmentId: null }),
      expect.any(Array),
    );
  });

  it("403s for a manager (attach requires admin)", async () => {
    const res = await postProof(managerSession);
    expect(res.status).toBe(403);
    expect(attachExpenseProofService).not.toHaveBeenCalled();
  });

  it("403s for an editor", async () => {
    const res = await postProof(editorSession);
    expect(res.status).toBe(403);
  });

  it("403s for a portal (owner) session", async () => {
    const res = await postProof(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await postProof(null);
    expect(res.status).toBe(401);
  });

  it("400s when no file field is present", async () => {
    const res = await postProof(adminSession, { ...FULL, withFile: false });
    expect(res.status).toBe(400);
    expect(attachExpenseProofService).not.toHaveBeenCalled();
  });

  it("400s when a required field (ownerPartyId) is missing", async () => {
    const res = await postProof(adminSession, { statementMonth: MONTH, apartmentId: APT, category: "utilities_tnb" });
    expect(res.status).toBe(400);
    expect(attachExpenseProofService).not.toHaveBeenCalled();
  });

  it("400s a malformed statementMonth", async () => {
    const res = await postProof(adminSession, { ...FULL, statementMonth: "June 2026" });
    expect(res.status).toBe(400);
    expect(attachExpenseProofService).not.toHaveBeenCalled();
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(attachExpenseProofService).mockResolvedValueOnce({ ok: false, status: 404, error: "x" });
    const res = await postProof(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark, before the role check", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await postProof(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

// ─── GET /expense-proofs (list signed = admin/manager) ─────────────────────

function getProofs(
  session: SessionPayload | null,
  query = `ownerPartyId=${OWNER}&statementMonth=${MONTH}&apartmentId=${APT}`,
) {
  return makeApp(session).request(`/expense-proofs?${query}`, { method: "GET" });
}

describe("GET /expense-proofs (list signed = admin/manager)", () => {
  it("admin gets 200 + grouped data; ctx + params forwarded", async () => {
    const res = await getProofs(adminSession);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof groupRow[] };
    expect(body.data).toEqual([groupRow]);
    expect(listExpenseProofUrlsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorUserId: "u1" }),
      OWNER,
      MONTH,
      APT,
    );
  });

  it("manager is allowed to read (the list is admin/manager)", async () => {
    const res = await getProofs(managerSession);
    expect(res.status).toBe(200);
  });

  it("a missing apartmentId query forwards apartmentId: null", async () => {
    await getProofs(adminSession, `ownerPartyId=${OWNER}&statementMonth=${MONTH}`);
    expect(listExpenseProofUrlsService).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      MONTH,
      null,
    );
  });

  it("403s for an editor (below manager)", async () => {
    const res = await getProofs(editorSession);
    expect(res.status).toBe(403);
    expect(listExpenseProofUrlsService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await getProofs(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("401s for a missing session", async () => {
    const res = await getProofs(null);
    expect(res.status).toBe(401);
  });

  it("400s a malformed query (missing ownerPartyId)", async () => {
    const res = await getProofs(adminSession, `statementMonth=${MONTH}`);
    expect(res.status).toBe(400);
    expect(listExpenseProofUrlsService).not.toHaveBeenCalled();
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await getProofs(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});

// ─── DELETE /expense-proofs/:id (detach = admin) ───────────────────────────

function deleteProof(session: SessionPayload | null, id = PROOF) {
  return makeApp(session).request(`/expense-proofs/${id}`, { method: "DELETE" });
}

describe("DELETE /expense-proofs/:id (detach = admin)", () => {
  it("admin gets 200; ctx + id forwarded", async () => {
    const res = await deleteProof(adminSession);
    expect(res.status).toBe(200);
    expect(detachExpenseProofService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorRole: "admin" }),
      PROOF,
    );
  });

  it("403s for a manager (detach requires admin)", async () => {
    const res = await deleteProof(managerSession);
    expect(res.status).toBe(403);
    expect(detachExpenseProofService).not.toHaveBeenCalled();
  });

  it("403s for a portal (owner) session", async () => {
    const res = await deleteProof(ownerPortalSession);
    expect(res.status).toBe(403);
  });

  it("maps a service 404 to HTTP 404", async () => {
    vi.mocked(detachExpenseProofService).mockResolvedValueOnce({ ok: false, status: 404, error: "x" });
    const res = await deleteProof(adminSession);
    expect(res.status).toBe(404);
  });

  it("404s while the flag is dark", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const res = await deleteProof(adminSession);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
