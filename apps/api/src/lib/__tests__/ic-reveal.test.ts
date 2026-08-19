import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../auth";

type PartyRow = { id: string; organizationId: string; idNumber: string | null };
const partyStore = new Map<string, PartyRow>();

const dbMock = {
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock)),
  party: {
    findFirst: vi.fn(async (args: { where: { id?: string; organizationId?: string } }) => {
      const row = args.where.id ? partyStore.get(args.where.id) : undefined;
      if (!row || row.organizationId !== args.where.organizationId) return null;
      return { id: row.id, idNumber: row.idNumber };
    }),
  },
};

vi.mock("@kason/db", () => ({ getDb: () => dbMock }));
vi.mock("../audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { recordAudit } from "../audit";
import { maskIdNumber, recordIcRevealService } from "../ic-reveal";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const P_ALICE = "00000000-0000-4000-8000-000000000061";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const session: SessionPayload = { userId: "u1", orgId: ORG, role: "manager", userType: "operator" };

describe("maskIdNumber", () => {
  it("masks all but the last 4 chars", () => {
    expect(maskIdNumber("990101-14-5678")).toBe("••••5678");
  });
  it("fully masks values of length <= 4", () => {
    expect(maskIdNumber("1234")).toBe("••••");
    expect(maskIdNumber("12")).toBe("••••");
  });
  it("returns null for null", () => {
    expect(maskIdNumber(null)).toBeNull();
  });
});

describe("recordIcRevealService", () => {
  beforeEach(() => {
    partyStore.clear();
    partyStore.set(P_ALICE, { id: P_ALICE, organizationId: ORG, idNumber: "990101-14-5678" });
  });
  afterEach(() => vi.clearAllMocks());

  it("returns raw idNumber + writes ONE audit row in the same tx", async () => {
    const r = await recordIcRevealService(session, P_ALICE);
    expect(r).toEqual({ ok: true, status: 200, data: { partyId: P_ALICE, idNumber: "990101-14-5678" } });
    expect(vi.mocked(recordAudit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAudit).mock.calls[0]![1]).toMatchObject({
      action: "leasing.tenant.ic_reveal",
      entityType: "Party",
      entityId: P_ALICE,
    });
  });

  it("404 PARTY_NOT_FOUND for unknown id — no audit", async () => {
    const r = await recordIcRevealService(session, UNKNOWN);
    expect(r).toEqual({ ok: false, status: 404, error: "PARTY_NOT_FOUND" });
    expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
  });

  it("404 PARTY_NOT_FOUND for a cross-org party (org isolation)", async () => {
    partyStore.set(P_ALICE, { id: P_ALICE, organizationId: OTHER_ORG, idNumber: "x" });
    const r = await recordIcRevealService(session, P_ALICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("404 NO_IC when party has no stored idNumber — no audit (return before recordAudit)", async () => {
    partyStore.set(P_ALICE, { id: P_ALICE, organizationId: ORG, idNumber: null });
    const r = await recordIcRevealService(session, P_ALICE);
    expect(r).toEqual({ ok: false, status: 404, error: "NO_IC" });
    expect(vi.mocked(recordAudit)).not.toHaveBeenCalled();
  });
});
