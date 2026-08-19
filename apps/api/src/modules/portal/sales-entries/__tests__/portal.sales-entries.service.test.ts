import { describe, it, expect, beforeEach, vi } from "vitest";

const txMock = {
  project: { findFirst: vi.fn(), create: vi.fn() },
  projectVerificationTransition: { create: vi.fn() },
  salesUnit: { findFirst: vi.fn(), create: vi.fn() },
  salesClaimDefault: { findFirst: vi.fn() },
  salesClaim: { create: vi.fn() },
  salesClaimSplit: { createMany: vi.fn() },
  salesClaimTransition: { create: vi.fn() },
  renovationPackage: { findFirst: vi.fn() },
  renovationClaim: { create: vi.fn() },
  renovationClaimSplit: { createMany: vi.fn() },
  renovationClaimDocument: { createMany: vi.fn() },
  renovationClaimTransition: { create: vi.fn() },
  renovationProgress: { create: vi.fn() },
  renovationStage: { findMany: vi.fn() },
  renovationStageProgress: { createMany: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: (fn: (tx: any) => Promise<any>) => fn(txMock),
  }),
}));

import { createSalesEntryService } from "../portal.sales-entries.service";
import type { CreateSalesEntryInput } from "../portal.sales-entries.validation";

const baseCtx = { orgId: "org-1", agentPartyId: "agent-party-1", actorUserId: "user-1" };

const baseInput: CreateSalesEntryInput = {
  project: { mode: "existing", id: "11111111-1111-4111-8111-111111111111" },
  unitNumber: "A-12-01",
  ownerPartyId: "22222222-2222-4222-8222-222222222222",
  salesDate: "2026-04-30T00:00:00.000Z",
  purpose: "own_stay",
  purchasePrice: 500000,
  bedrooms: 3,
  bathrooms: 2,
  parkingLots: 1,
};

beforeEach(() => {
  Object.values(txMock).forEach((m: any) => Object.values(m).forEach((fn: any) => fn.mockReset()));
  // Default happy-path mocks
  txMock.project.findFirst.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", status: "active" });
  txMock.salesUnit.findFirst.mockResolvedValue(null);
  txMock.salesUnit.create.mockResolvedValue({
    id: "unit-1",
    projectId: "11111111-1111-4111-8111-111111111111",
    unitNumber: "A-12-01",
    sourcingApproved: false,
  });
  txMock.salesClaimDefault.findFirst.mockResolvedValue({
    id: "def-1",
    commissionType: "percent_of_purchase",
    commissionValue: 2,
    paymentType: "full",
    notes: null,
    defaultSplits: [
      { roleLabel: "Sales Commission", splitType: "percent", splitValue: 100, sortOrder: 0 },
    ],
  });
  txMock.salesClaim.create.mockResolvedValue({ id: "claim-1", status: "submitted" });
  txMock.salesClaimSplit.createMany.mockResolvedValue({ count: 1 });
  txMock.salesClaimTransition.create.mockResolvedValue({ id: "t1" });
});

describe("createSalesEntryService — happy path (no renovation)", () => {
  it("creates SalesUnit + SalesClaim + 1 split", async () => {
    const result = await createSalesEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(true);
    expect(txMock.salesUnit.create).toHaveBeenCalledOnce();
    expect(txMock.salesClaim.create).toHaveBeenCalledOnce();
    expect(txMock.salesClaimSplit.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ claimId: "claim-1", roleLabel: "Sales Commission", splitType: "percent", splitValue: 100 }),
      ],
    });
    expect(txMock.renovationClaim.create).not.toHaveBeenCalled();
    expect(txMock.renovationProgress.create).not.toHaveBeenCalled();
  });

  it("does NOT include project in response when mode=existing", async () => {
    const result = await createSalesEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.project).toBeNull();
  });
});

describe("createSalesEntryService — happy path (with renovation)", () => {
  it("creates renovation chain with RenovationProgress + seeded stages", async () => {
    txMock.renovationPackage.findFirst.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
    txMock.renovationClaim.create.mockResolvedValue({ id: "rc-1", status: "submitted" });
    txMock.renovationClaimSplit.createMany.mockResolvedValue({ count: 1 });
    txMock.renovationStage.findMany.mockResolvedValue([
      { id: "s1" }, { id: "s2" },
    ]);
    txMock.renovationProgress.create.mockResolvedValue({ id: "rp-1", status: "not_started" });
    txMock.renovationStageProgress.createMany.mockResolvedValue({ count: 2 });

    const result = await createSalesEntryService(
      {
        ...baseInput,
        renovation: {
          packageId: "33333333-3333-4333-8333-333333333333",
          packagePrice: 30000,
          paymentType: "full",
          splits: [
            { partyDisplayName: "House Keep", roleLabel: "House Keep", splitType: "percent", splitValue: 100, isHouseKeep: true, sortOrder: 0 },
          ],
        },
      },
      baseCtx,
    );
    expect(result.ok).toBe(true);
    expect(txMock.renovationClaim.create).toHaveBeenCalledOnce();
    expect(txMock.renovationProgress.create).toHaveBeenCalledOnce();
    expect(txMock.renovationStageProgress.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ progressId: "rp-1", stageId: "s1", status: "pending" }),
        expect.objectContaining({ progressId: "rp-1", stageId: "s2", status: "pending" }),
      ],
    });
    if (result.ok) {
      expect(result.data.renovationClaim).toEqual({ id: "rc-1", status: "submitted" });
      expect(result.data.renovationProgress).toEqual({ id: "rp-1", status: "not_started", stagesSeeded: 2 });
    }
  });

  it("includes documents on the renovation claim when provided", async () => {
    txMock.renovationPackage.findFirst.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
    txMock.renovationClaim.create.mockResolvedValue({ id: "rc-1", status: "submitted" });
    txMock.renovationClaimSplit.createMany.mockResolvedValue({ count: 1 });
    txMock.renovationClaimDocument.createMany.mockResolvedValue({ count: 1 });
    txMock.renovationStage.findMany.mockResolvedValue([{ id: "s1" }]);
    txMock.renovationProgress.create.mockResolvedValue({ id: "rp-1", status: "not_started" });
    txMock.renovationStageProgress.createMany.mockResolvedValue({ count: 1 });

    await createSalesEntryService(
      {
        ...baseInput,
        renovation: {
          packageId: "33333333-3333-4333-8333-333333333333",
          packagePrice: 30000,
          paymentType: "full",
          splits: [
            { partyDisplayName: "X", roleLabel: "X", splitType: "percent", splitValue: 100, isHouseKeep: false, sortOrder: 0 },
          ],
          documents: [
            { kind: "quotation", fileKey: "uploads/quote.pdf", filename: "quote.pdf" },
          ],
        },
      },
      baseCtx,
    );
    expect(txMock.renovationClaimDocument.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ kind: "quotation", fileKey: "uploads/quote.pdf", filename: "quote.pdf" }),
      ],
    });
  });
});

describe("createSalesEntryService — error paths", () => {
  it("returns 400 expected_rental_required when purpose='rent' without expectedRental", async () => {
    const result = await createSalesEntryService(
      { ...baseInput, purpose: "rent", expectedRental: undefined },
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("expected_rental_required");
  });

  it("returns 400 sales_claim_defaults_invalid when org has no SalesClaimDefault", async () => {
    txMock.salesClaimDefault.findFirst.mockResolvedValue(null);
    const result = await createSalesEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sales_claim_defaults_invalid");
  });

  it("returns 409 unit_already_exists when (project, unitNumber) collides", async () => {
    txMock.salesUnit.findFirst.mockResolvedValue({ id: "existing" });
    const result = await createSalesEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unit_already_exists");
  });

  it("returns 400 no_active_stages when org has zero active stages and renovation block is present", async () => {
    txMock.renovationPackage.findFirst.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
    txMock.renovationStage.findMany.mockResolvedValue([]);
    const result = await createSalesEntryService(
      {
        ...baseInput,
        renovation: {
          packageId: "33333333-3333-4333-8333-333333333333",
          packagePrice: 1000,
          paymentType: "full",
          splits: [
            { partyDisplayName: "X", roleLabel: "X", splitType: "percent", splitValue: 100, isHouseKeep: false, sortOrder: 0 },
          ],
        },
      },
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_active_stages");
  });

  it("returns 404 package_not_found when packageId not in org", async () => {
    txMock.renovationPackage.findFirst.mockResolvedValue(null);
    const result = await createSalesEntryService(
      {
        ...baseInput,
        renovation: {
          packageId: "33333333-3333-4333-8333-333333333333",
          packagePrice: 1000,
          paymentType: "full",
          splits: [
            { partyDisplayName: "X", roleLabel: "X", splitType: "percent", splitValue: 100, isHouseKeep: false, sortOrder: 0 },
          ],
        },
      },
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("package_not_found");
  });

  it("returns 400 project_archived when existing project is archived", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", status: "archived" });
    const result = await createSalesEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("project_archived");
  });
});
