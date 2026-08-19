import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../sales.repository", () => ({
  listSalesUnits: vi.fn(async () => []),
  findSalesUnitById: vi.fn(async () => null),
  findSalesUnitByIdTx: vi.fn(async () => null),
  findUnitNumberConflict: vi.fn(async () => null),
  findProjectByIdScoped: vi.fn(async () => ({
    id: "proj-1",
    status: "active",
    promotedPropertyId: null,
    name: "P",
    developer: "D",
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
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({
      project: { findUnique: vi.fn(async () => ({
        id: "proj-1",
        name: "Aurora",
        city: "KL",
        promotedPropertyId: null,
        organizationId: "00000000-0000-0000-0000-000000000001",
      })) },
      // Stubs for the reject-path cascade
      // (cascadeCancelClaimsOnSalesUnitTermination). The cascade is fired
      // inside withTransaction on the reject path, so these tx methods must
      // exist or the helper throws. Returning empty arrays / no-ops is fine
      // because rejection-cascade behaviour is covered by its own dedicated
      // test (cascade-on-termination.test.ts).
      salesClaim: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      salesClaimTransition: { createMany: vi.fn(async () => ({ count: 0 })) },
      renovationClaim: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      renovationClaimTransition: { createMany: vi.fn(async () => ({ count: 0 })) },
      renovationProgress: { updateMany: vi.fn(async () => ({ count: 0 })) },
    }),
  ),
}));

import { recordAudit } from "../../../lib/audit";
import {
  approveSourcingRow,
  createPromotedUnit,
  createSalesUnitRow,
  findOrCreatePromotedProperty,
  findProjectByIdScoped,
  findRenovationProgress,
  findSalesUnitById,
  findSalesUnitByIdTx,
  findUnitNumberConflict,
  listSalesUnits,
  setAmendmentNote,
  setProjectPromotedPropertyId,
  setSalesUnitPromotedUnitId,
  updateSalesUnitRow,
  upsertRenovationProgress,
  withTransaction,
} from "../sales.repository";
import {
  approveSalesUnitService,
  createSalesUnitService,
  getSalesUnitByIdService,
  getSalesUnitsService,
  listSourceQueueService,
  needsAmendmentSalesUnitService,
  rejectSalesUnitService,
  setRenovationStatusService,
  updateSalesUnitService,
} from "../sales.service";
import type { RenovationProgressRow, SalesUnitRow } from "../sales.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const SALES_ID = "00000000-0000-0000-0000-0000000000bb";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000cc";
const AGENT_ID = "00000000-0000-0000-0000-0000000000dd";

function fakeSalesUnit(overrides: Partial<SalesUnitRow> = {}): SalesUnitRow {
  return {
    id: SALES_ID,
    organizationId: ORG,
    projectId: PROJECT_ID,
    unitNumber: "A-08-02",
    ownerPartyId: "owner-1",
    salesDate: new Date("2026-04-01T00:00:00.000Z"),
    purpose: "rent",
    bedrooms: 2,
    bathrooms: 1,
    parkingLots: 1,
    expectedRental: 2500,
    purchasePrice: 600000,
    agentPartyId: AGENT_ID,
    inChargePartyId: null,
    sourceFlag: "AGENT_SOURCED",
    sourcingApproved: false,
    sourcingApprovedById: null,
    sourcingApprovedAt: null,
    amendmentNotes: null,
    promotedUnitId: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeProgress(overrides: Partial<RenovationProgressRow> = {}): RenovationProgressRow {
  return {
    id: "prog-1",
    organizationId: ORG,
    salesUnitId: SALES_ID,
    status: "not_started",
    startDate: null,
    expectedCompletion: null,
    actualCompletion: null,
    notes: null,
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedById: USER,
    ...overrides,
  };
}

function baseCtx(role: "admin" | "manager" | "editor" = "manager") {
  return {
    orgId: ORG,
    actorUserId: USER,
    actorRole: role,
    ip: "10.0.0.1",
    userAgent: "vitest",
  } as const;
}

function baseCreateInput() {
  return {
    projectId: PROJECT_ID,
    unitNumber: "A-08-02",
    ownerPartyId: "00000000-0000-0000-0000-000000000ee0",
    salesDate: "2026-04-01T00:00:00.000Z",
    purpose: "rent" as const,
    bedrooms: 2,
    bathrooms: 1,
    parkingLots: 1,
    purchasePrice: 600000,
    agentPartyId: AGENT_ID,
  };
}

describe("createSalesUnitService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects editor with 403", async () => {
    const result = await createSalesUnitService(baseCtx("editor"), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(createSalesUnitRow).not.toHaveBeenCalled();
  });

  it("404 when project not found", async () => {
    vi.mocked(findProjectByIdScoped).mockResolvedValueOnce(null);
    const result = await createSalesUnitService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("succeeds against an active project", async () => {
    vi.mocked(findProjectByIdScoped).mockResolvedValueOnce({
      id: "proj-1",
      status: "active",
      promotedPropertyId: null,
      name: "P",
      developer: "D",
      city: "KL",
    });
    vi.mocked(createSalesUnitRow).mockResolvedValueOnce(fakeSalesUnit());
    const result = await createSalesUnitService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: true, status: 201 });
  });

  it("400 when project is unverified", async () => {
    vi.mocked(findProjectByIdScoped).mockResolvedValueOnce({
      id: "proj-1",
      status: "unverified",
      promotedPropertyId: null,
      name: "P",
      developer: "D",
      city: "KL",
    });
    const result = await createSalesUnitService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 400, error: "Project is not active" });
    expect(createSalesUnitRow).not.toHaveBeenCalled();
  });

  it("400 when project is archived", async () => {
    vi.mocked(findProjectByIdScoped).mockResolvedValueOnce({
      id: "proj-1",
      status: "archived",
      promotedPropertyId: null,
      name: "P",
      developer: "D",
      city: "KL",
    });
    const result = await createSalesUnitService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 400, error: "Project is not active" });
    expect(createSalesUnitRow).not.toHaveBeenCalled();
  });

  it("409 on duplicate unit number within the same project", async () => {
    vi.mocked(findUnitNumberConflict).mockResolvedValueOnce({ id: "x" });
    const result = await createSalesUnitService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("creates SalesUnit row with audit", async () => {
    vi.mocked(createSalesUnitRow).mockResolvedValueOnce(fakeSalesUnit());
    const result = await createSalesUnitService(baseCtx(), baseCreateInput());
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(createSalesUnitRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        agentPartyId: AGENT_ID,
        unitNumber: "A-08-02",
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "sales.unit.create",
        entityType: "SalesUnit",
        entityId: SALES_ID,
      }),
    );
  });

  it("portal-flow: bypasses manager gate via agentPartyIdOverride", async () => {
    vi.mocked(createSalesUnitRow).mockResolvedValueOnce(fakeSalesUnit());
    const result = await createSalesUnitService(
      baseCtx("editor"),
      { ...baseCreateInput(), agentPartyId: undefined },
      { agentPartyIdOverride: AGENT_ID, auditAction: "sales.unit.submit.portal" },
    );
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.submit.portal" }),
    );
  });
});

describe("updateSalesUnitService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when missing", async () => {
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(null);
    const result = await updateSalesUnitService(baseCtx(), SALES_ID, { bedrooms: 3 });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("editor 403 (admin path)", async () => {
    const result = await updateSalesUnitService(baseCtx("editor"), SALES_ID, { bedrooms: 3 });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("portal: ownership check — non-owner agent gets 404", async () => {
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(
      fakeSalesUnit({ agentPartyId: "other" }),
    );
    const result = await updateSalesUnitService(
      baseCtx("editor"),
      SALES_ID,
      { bedrooms: 3 },
      { requireOwnerPartyId: AGENT_ID },
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(updateSalesUnitRow).not.toHaveBeenCalled();
  });

  it("edit-after-approval rebound: portal edit on approved row resets sourcingApproved=false", async () => {
    const before = fakeSalesUnit({ sourcingApproved: true });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before);
    const after = fakeSalesUnit({
      sourcingApproved: false,
      amendmentNotes: "Edited by agent post-approval",
    });
    vi.mocked(updateSalesUnitRow).mockResolvedValueOnce(after);

    const result = await updateSalesUnitService(
      baseCtx("editor"),
      SALES_ID,
      { bedrooms: 3 },
      { requireOwnerPartyId: AGENT_ID, rebindOnApproval: true, auditAction: "sales.unit.update.portal" },
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(updateSalesUnitRow).toHaveBeenCalledWith(
      expect.anything(),
      SALES_ID,
      ORG,
      expect.objectContaining({
        sourcingApproved: false,
        amendmentNotes: "Edited by agent post-approval",
        sourcingApprovedById: null,
        sourcingApprovedAt: null,
      }),
    );
  });
});

describe("approveSalesUnitService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 403", async () => {
    const result = await approveSalesUnitService(baseCtx("editor"), SALES_ID);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("404 when missing", async () => {
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(null);
    const result = await approveSalesUnitService(baseCtx(), SALES_ID);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("409 when already approved (idempotency guard)", async () => {
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(
      fakeSalesUnit({ sourcingApproved: true }),
    );
    const result = await approveSalesUnitService(baseCtx(), SALES_ID);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(approveSourcingRow).not.toHaveBeenCalled();
  });

  it("flips sourcingApproved + sets inChargePartyId=agent + audits", async () => {
    const before = fakeSalesUnit();
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before);
    vi.mocked(approveSourcingRow).mockResolvedValueOnce(
      fakeSalesUnit({
        sourcingApproved: true,
        sourcingApprovedById: USER,
        inChargePartyId: AGENT_ID,
      }),
    );
    const result = await approveSalesUnitService(baseCtx(), SALES_ID);
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(approveSourcingRow).toHaveBeenCalledWith(
      expect.anything(),
      SALES_ID,
      USER,
      AGENT_ID,
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.sourcing.approve" }),
    );
  });
});

describe("reject + needs-amendment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejectSalesUnit: editor 403", async () => {
    const result = await rejectSalesUnitService(baseCtx("editor"), SALES_ID, { note: "x" });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejectSalesUnit: writes amendmentNotes + audits sales.unit.sourcing.reject", async () => {
    const before = fakeSalesUnit();
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before);
    vi.mocked(setAmendmentNote).mockResolvedValueOnce(
      fakeSalesUnit({ amendmentNotes: "spec mismatch" }),
    );
    const result = await rejectSalesUnitService(baseCtx(), SALES_ID, { note: "spec mismatch" });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(setAmendmentNote).toHaveBeenCalledWith(expect.anything(), SALES_ID, "spec mismatch");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.sourcing.reject" }),
    );
  });

  it("needsAmendment: audit action sales.unit.sourcing.needs_amendment", async () => {
    const before = fakeSalesUnit();
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before);
    vi.mocked(setAmendmentNote).mockResolvedValueOnce(
      fakeSalesUnit({ amendmentNotes: "please re-check" }),
    );
    await needsAmendmentSalesUnitService(baseCtx(), SALES_ID, { note: "please re-check" });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.sourcing.needs_amendment" }),
    );
  });
});

describe("setRenovationStatusService — auto-promote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 403", async () => {
    const result = await setRenovationStatusService(baseCtx("editor"), SALES_ID, {
      status: "completed",
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("404 when sales unit not found", async () => {
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(null);
    const result = await setRenovationStatusService(baseCtx(), SALES_ID, {
      status: "on_going",
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("transitioning to completed for purpose=rent triggers auto-promote (creates Property + Unit)", async () => {
    const before = fakeSalesUnit({ purpose: "rent", promotedUnitId: null });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    // Inside the tx: progress baseline + post-progress sales unit re-read.
    vi.mocked(findRenovationProgress).mockResolvedValueOnce(null);
    vi.mocked(upsertRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "completed" }),
    );
    // Two findSalesUnitByIdTx calls: pre-promote check + post-promote final read.
    vi.mocked(findSalesUnitByIdTx)
      .mockResolvedValueOnce(before) // pre-promote
      .mockResolvedValueOnce(
        fakeSalesUnit({ promotedUnitId: "unit-1", purpose: "rent" }),
      ); // post-promote final read

    const result = await setRenovationStatusService(baseCtx(), SALES_ID, {
      status: "completed",
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok) return;
    expect(result.data.promotedUnitId).toBe("unit-1");
    expect(findOrCreatePromotedProperty).toHaveBeenCalledTimes(1);
    expect(findOrCreatePromotedProperty).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        projectId: "proj-1",
        name: "Aurora",
        city: "KL",
      }),
    );
    expect(setProjectPromotedPropertyId).toHaveBeenCalledTimes(1);
    // Full Unit shape — every field auto-promote sets must be asserted so a
    // future refactor cannot silently change defaults.
    expect(createPromotedUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        propertyId: "prop-1",
        salesUnitId: SALES_ID,
        unitCode: before.unitNumber,
        bedrooms: before.bedrooms === -1 ? 0 : before.bedrooms,
        bathrooms: before.bathrooms,
        expectedRental: before.expectedRental,
        inChargePartyId: before.inChargePartyId,
        sourcingAgentId: AGENT_ID,
      }),
    );
    expect(setSalesUnitPromotedUnitId).toHaveBeenCalledWith(
      expect.anything(),
      SALES_ID,
      "unit-1",
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sales.unit.auto_promote" }),
    );
  });

  it("studio (bedrooms=-1) is mapped to bedrooms=0 on auto-promote", async () => {
    const before = fakeSalesUnit({
      purpose: "rent",
      promotedUnitId: null,
      bedrooms: -1,
    });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findRenovationProgress).mockResolvedValueOnce(null);
    vi.mocked(upsertRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "completed" }),
    );
    vi.mocked(findSalesUnitByIdTx)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(
        fakeSalesUnit({ promotedUnitId: "unit-1", purpose: "rent", bedrooms: -1 }),
      );

    await setRenovationStatusService(baseCtx(), SALES_ID, { status: "completed" });

    // Auto-promote must translate Studio (-1) into the Unit-table
    // convention (0) at the service boundary so the repo helper always
    // receives the Unit-table shape.
    expect(createPromotedUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        salesUnitId: SALES_ID,
        bedrooms: 0,
      }),
    );
  });

  it("idempotent: second completion with promotedUnitId already set does NOT re-promote", async () => {
    const before = fakeSalesUnit({
      purpose: "rent",
      promotedUnitId: "unit-1",
    });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "completed" }),
    );
    vi.mocked(upsertRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "completed" }),
    );
    vi.mocked(findSalesUnitByIdTx)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before);

    const result = await setRenovationStatusService(baseCtx(), SALES_ID, {
      status: "completed",
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(findOrCreatePromotedProperty).not.toHaveBeenCalled();
    expect(createPromotedUnit).not.toHaveBeenCalled();
    expect(setSalesUnitPromotedUnitId).not.toHaveBeenCalled();
  });

  it("skipped when purpose=own_stay (no auto-promote even on completion)", async () => {
    const before = fakeSalesUnit({ purpose: "own_stay" });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findRenovationProgress).mockResolvedValueOnce(null);
    vi.mocked(upsertRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "completed" }),
    );
    vi.mocked(findSalesUnitByIdTx)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before);

    const result = await setRenovationStatusService(baseCtx(), SALES_ID, {
      status: "completed",
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok) return;
    expect(result.data.promotedUnitId).toBe(null);
    expect(createPromotedUnit).not.toHaveBeenCalled();
  });

  it("appends a transition row only when status actually changes", async () => {
    const before = fakeSalesUnit();
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "on_going" }),
    );
    vi.mocked(upsertRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "on_going" }),
    );
    vi.mocked(findSalesUnitByIdTx).mockResolvedValueOnce(before).mockResolvedValueOnce(before);

    const { appendRenovationTransition } = await import("../sales.repository");
    await setRenovationStatusService(baseCtx(), SALES_ID, { status: "on_going" });
    expect(appendRenovationTransition).not.toHaveBeenCalled();
  });

  it("reuses Project.promotedPropertyId on second project unit promotion", async () => {
    const before = fakeSalesUnit({ purpose: "rent", promotedUnitId: null });
    vi.mocked(findSalesUnitById).mockResolvedValueOnce(before);
    vi.mocked(findRenovationProgress).mockResolvedValueOnce(null);
    vi.mocked(upsertRenovationProgress).mockResolvedValueOnce(
      fakeProgress({ status: "completed" }),
    );
    vi.mocked(findSalesUnitByIdTx)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(fakeSalesUnit({ promotedUnitId: "unit-2" }));

    // Override withTransaction so the inner tx.project.findUnique returns
    // a project that already has promotedPropertyId set.
    vi.mocked(withTransaction).mockImplementationOnce(async (cb) =>
      cb({
        project: {
          findUnique: vi.fn(async () => ({
            id: "proj-1",
            name: "Aurora",
            city: "KL",
            promotedPropertyId: "prop-existing",
            organizationId: ORG,
          })),
        },
      } as never),
    );

    await setRenovationStatusService(baseCtx(), SALES_ID, { status: "completed" });

    expect(findOrCreatePromotedProperty).not.toHaveBeenCalled();
    expect(setProjectPromotedPropertyId).not.toHaveBeenCalled();
    expect(createPromotedUnit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ propertyId: "prop-existing" }),
    );
  });
});

describe("source queue + reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listSourceQueueService: editor 403", async () => {
    const result = await listSourceQueueService(baseCtx("editor"));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("listSourceQueueService: filters by sourcingApproved=false", async () => {
    vi.mocked(listSalesUnits).mockResolvedValueOnce([fakeSalesUnit()]);
    const result = await listSourceQueueService(baseCtx());
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(listSalesUnits).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ sourcingApproved: false }),
    );
  });

  it("getSalesUnitsService: editor allowed (read-only)", async () => {
    vi.mocked(listSalesUnits).mockResolvedValueOnce([]);
    const result = await getSalesUnitsService({ orgId: ORG, role: "editor" });
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("getSalesUnitByIdService: org isolation — different org returns 404", async () => {
    vi.mocked(findSalesUnitById).mockImplementationOnce(async (orgId) => {
      if (orgId !== ORG) return null;
      return fakeSalesUnit();
    });
    const result = await getSalesUnitByIdService(
      { orgId: "other-org", role: "editor" },
      SALES_ID,
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
