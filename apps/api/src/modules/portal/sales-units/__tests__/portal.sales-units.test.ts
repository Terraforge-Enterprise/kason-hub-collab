import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../../../sales/sales.repository", () => ({
  listSalesUnits: vi.fn(async () => []),
  findSalesUnitById: vi.fn(async () => null),
  findSalesUnitByIdTx: vi.fn(async () => null),
  findUnitNumberConflict: vi.fn(async () => null),
  findProjectByIdScoped: vi.fn(async () => ({
    id: "proj-1",
    status: "active",
    promotedPropertyId: null,
    name: "Aurora",
    developer: "ACME",
    city: "KL",
  })),
  createSalesUnitRow: vi.fn(),
  updateSalesUnitRow: vi.fn(),
  approveSourcingRow: vi.fn(),
  setAmendmentNote: vi.fn(),
  findRenovationProgress: vi.fn(async () => null),
  upsertRenovationProgress: vi.fn(),
  appendRenovationTransition: vi.fn(),
  listRenovationTransitions: vi.fn(async () => []),
  setSalesUnitPromotedUnitId: vi.fn(async () => undefined),
  setProjectPromotedPropertyId: vi.fn(async () => undefined),
  findOrCreatePromotedProperty: vi.fn(async () => ({ id: "prop-1" })),
  createPromotedUnit: vi.fn(async () => ({ id: "unit-1" })),
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
}));

import { recordAudit } from "../../../../lib/audit";
import {
  createSalesUnitRow,
  findSalesUnitById,
  findSalesUnitByIdTx,
  listSalesUnits,
  updateSalesUnitRow,
} from "../../../sales/sales.repository";
import {
  createSalesUnitService,
  getSalesUnitByIdService,
  getSalesUnitsService,
  updateSalesUnitService,
} from "../../../sales";
import type { SalesUnitRow } from "../../../sales/sales.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const AGENT = "00000000-0000-0000-0000-000000000aaa";
const OTHER_AGENT = "00000000-0000-0000-0000-000000000bbb";
const SALES_ID = "00000000-0000-0000-0000-0000000000ff";

function fakeSalesUnit(overrides: Partial<SalesUnitRow> = {}): SalesUnitRow {
  return {
    id: SALES_ID,
    organizationId: ORG,
    projectId: "proj-1",
    unitNumber: "A-08-02",
    ownerPartyId: "owner-1",
    salesDate: new Date("2026-04-01T00:00:00.000Z"),
    purpose: "rent",
    bedrooms: 2,
    bathrooms: 1,
    parkingLots: 1,
    expectedRental: 2500,
    purchasePrice: 600000,
    agentPartyId: AGENT,
    inChargePartyId: null,
    sourceFlag: "AGENT_SOURCED",
    sourcingApproved: false,
    sourcingApprovedById: null,
    sourcingApprovedAt: null,
    amendmentNotes: null,
    promotedUnitId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const portalCtx = {
  orgId: ORG,
  actorUserId: AGENT,
  actorRole: "editor" as const,
  ip: "1",
  userAgent: "v",
};

describe("portal sales-units submit (POST)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agent submit injects agentPartyId from session and tags portal audit action", async () => {
    vi.mocked(createSalesUnitRow).mockResolvedValueOnce(fakeSalesUnit());
    const result = await createSalesUnitService(
      portalCtx,
      {
        projectId: "proj-1",
        unitNumber: "A-08-02",
        ownerPartyId: "owner-1",
        salesDate: "2026-04-01T00:00:00.000Z",
        purpose: "rent",
        bedrooms: 2,
        bathrooms: 1,
        parkingLots: 1,
        purchasePrice: 600000,
        // agentPartyId intentionally omitted — overridden from session.
      },
      {
        agentPartyIdOverride: AGENT,
        sourceFlag: "AGENT_SOURCED",
        sourcingApproved: false,
        auditAction: "sales.unit.submit.portal",
      },
    );
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(createSalesUnitRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentPartyId: AGENT,
        sourceFlag: "AGENT_SOURCED",
        sourcingApproved: false,
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.submit.portal" }),
    );
  });

  it("agent without override is blocked (defence-in-depth)", async () => {
    const result = await createSalesUnitService(portalCtx, {
      projectId: "proj-1",
      unitNumber: "A-08-02",
      ownerPartyId: "owner-1",
      salesDate: "2026-04-01T00:00:00.000Z",
      purpose: "rent",
      bedrooms: 2,
      bathrooms: 1,
      parkingLots: 1,
      purchasePrice: 600000,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(createSalesUnitRow).not.toHaveBeenCalled();
  });
});

describe("portal sales-units edit (PATCH)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("agent can edit own row and triggers rebound on approved row", async () => {
    const before = fakeSalesUnit({ sourcingApproved: true });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateSalesUnitRow).mockResolvedValueOnce(
      fakeSalesUnit({
        sourcingApproved: false,
        amendmentNotes: "Edited by agent post-approval",
      }),
    );
    const result = await updateSalesUnitService(
      portalCtx,
      SALES_ID,
      { bedrooms: 3 },
      {
        requireOwnerPartyId: AGENT,
        rebindOnApproval: true,
        auditAction: "sales.unit.update.portal",
      },
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(updateSalesUnitRow).toHaveBeenCalledWith(
      expect.anything(),
      SALES_ID,
      ORG,
      expect.objectContaining({
        bedrooms: 3,
        sourcingApproved: false,
        amendmentNotes: "Edited by agent post-approval",
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.update.portal" }),
    );
  });

  it("agent cannot edit another agent's row (404)", async () => {
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(
      fakeSalesUnit({ agentPartyId: OTHER_AGENT }),
    );
    const result = await updateSalesUnitService(
      portalCtx,
      SALES_ID,
      { bedrooms: 3 },
      { requireOwnerPartyId: AGENT, rebindOnApproval: true },
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(updateSalesUnitRow).not.toHaveBeenCalled();
  });

  it("on un-approved row, edit does NOT touch sourcingApproved (no rebound spurious flip)", async () => {
    const before = fakeSalesUnit({ sourcingApproved: false });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateSalesUnitRow).mockResolvedValueOnce(fakeSalesUnit({ bedrooms: 3 }));

    await updateSalesUnitService(
      portalCtx,
      SALES_ID,
      { bedrooms: 3 },
      { requireOwnerPartyId: AGENT, rebindOnApproval: true },
    );
    const callArgs = vi.mocked(updateSalesUnitRow).mock.calls.at(-1)![3];
    expect(callArgs).not.toHaveProperty("amendmentNotes");
    expect(callArgs).not.toHaveProperty("sourcingApproved");
  });
});

describe("portal sales-units list/get", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list filters by agentPartyIdEq from session", async () => {
    vi.mocked(listSalesUnits).mockResolvedValueOnce([fakeSalesUnit()]);
    await getSalesUnitsService(
      { orgId: ORG, role: "editor" },
      { agentPartyIdEq: AGENT },
    );
    expect(listSalesUnits).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ agentPartyIdEq: AGENT }),
    );
  });

  it("get-by-id 404 when row exists but belongs to another agent (handled at route layer)", async () => {
    // The service itself returns the row for editor+; the route layer is
    // responsible for filtering by session.partyId. Verify the service
    // exposes agentPartyId so the route can do that check.
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(
      fakeSalesUnit({ agentPartyId: OTHER_AGENT }),
    );
    const result = await getSalesUnitByIdService(
      { orgId: ORG, role: "editor" },
      SALES_ID,
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    if (result.ok) expect(result.data.agentPartyId).toBe(OTHER_AGENT);
  });
});
