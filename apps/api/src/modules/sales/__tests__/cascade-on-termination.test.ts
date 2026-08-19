import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the cascade helper so we can assert it was called.
vi.mock("../../../lib/cascade-cancel-claims-on-sales-unit-termination", () => ({
  cascadeCancelClaimsOnSalesUnitTermination: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Tx mock used by withTransaction — fields just need to exist; the cascade
// helper itself is mocked so it never reads from tx.
const txMock = {
  salesUnit: { update: vi.fn(async () => ({})) },
};

vi.mock("../sales.repository", () => ({
  listSalesUnits: vi.fn(),
  findSalesUnitById: vi.fn(),
  findSalesUnitByIdTx: vi.fn(),
  findUnitNumberConflict: vi.fn(),
  findProjectByIdScoped: vi.fn(),
  createSalesUnitRow: vi.fn(),
  updateSalesUnitRow: vi.fn(),
  approveSourcingRow: vi.fn(),
  setAmendmentNote: vi.fn(),
  findRenovationProgress: vi.fn(),
  upsertRenovationProgress: vi.fn(),
  appendRenovationTransition: vi.fn(),
  listRenovationTransitions: vi.fn(),
  setSalesUnitPromotedUnitId: vi.fn(),
  setProjectPromotedPropertyId: vi.fn(),
  findOrCreatePromotedProperty: vi.fn(),
  createPromotedUnit: vi.fn(),
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(txMock)),
}));

// `getDb` is used directly by cancelSalesUnitSourcingService for the
// existing-row pre-check before opening the transaction.
const dbMock = {
  salesUnit: {
    findFirst: vi.fn(),
  },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { cascadeCancelClaimsOnSalesUnitTermination } from "../../../lib/cascade-cancel-claims-on-sales-unit-termination";
import {
  findSalesUnitById,
  findSalesUnitByIdTx,
  setAmendmentNote,
} from "../sales.repository";
import {
  cancelSalesUnitSourcingService,
  needsAmendmentSalesUnitService,
  rejectSalesUnitService,
} from "../sales.service";

const ctx = {
  orgId: "org-1",
  actorUserId: "user-1",
  actorRole: "manager" as const,
  ip: "127.0.0.1",
  userAgent: "test",
};

beforeEach(() => {
  vi.mocked(cascadeCancelClaimsOnSalesUnitTermination).mockClear();
  txMock.salesUnit.update.mockClear();
  dbMock.salesUnit.findFirst.mockReset();

  vi.mocked(findSalesUnitById).mockReset();
  vi.mocked(findSalesUnitByIdTx).mockReset();
  vi.mocked(setAmendmentNote).mockReset();

  // Defaults for reject/needs-amendment paths.
  vi.mocked(findSalesUnitById).mockResolvedValue({
    id: "u1",
    organizationId: "org-1",
    amendmentNotes: null,
  } as any);
  vi.mocked(findSalesUnitByIdTx).mockResolvedValue({
    id: "u1",
    organizationId: "org-1",
    amendmentNotes: null,
  } as any);
  vi.mocked(setAmendmentNote).mockResolvedValue({
    id: "u1",
    amendmentNotes: "rejection note",
  } as any);

  // Defaults for cancel path: row exists, agent owns it, not approved/cancelled.
  dbMock.salesUnit.findFirst.mockResolvedValue({
    id: "u1",
    agentPartyId: "agent-1",
    sourcingApproved: false,
    sourcingCancelled: false,
  });
});

describe("cascade-cancel wiring", () => {
  it("rejectSalesUnitService triggers cascade", async () => {
    const result = await rejectSalesUnitService(ctx, "u1", { note: "rejection note" });
    expect(result.ok).toBe(true);
    expect(cascadeCancelClaimsOnSalesUnitTermination).toHaveBeenCalledOnce();
    const args = vi.mocked(cascadeCancelClaimsOnSalesUnitTermination).mock.calls[0];
    expect(args[1]).toBe("u1");
    expect(args[2]).toContain("rejection note");
    expect(args[3]).toBe("user-1");
    expect(args[4]).toBe("org-1");
  });

  it("needsAmendmentSalesUnitService does NOT trigger cascade", async () => {
    const result = await needsAmendmentSalesUnitService(ctx, "u1", { note: "amend note" });
    expect(result.ok).toBe(true);
    expect(cascadeCancelClaimsOnSalesUnitTermination).not.toHaveBeenCalled();
  });

  it("cancelSalesUnitSourcingService triggers cascade with withdraw reason", async () => {
    const result = await cancelSalesUnitSourcingService(ctx, "u1", {
      requireOwnerPartyId: "agent-1",
    });
    expect(result.ok).toBe(true);
    expect(cascadeCancelClaimsOnSalesUnitTermination).toHaveBeenCalledOnce();
    const args = vi.mocked(cascadeCancelClaimsOnSalesUnitTermination).mock.calls[0];
    expect(args[1]).toBe("u1");
    expect(args[2]).toBe("Sales Entry withdrawn by agent");
  });
});
