import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/storage", () => ({
  requireBucket: vi.fn(() => "test-bucket"),
}));

vi.mock("../renovation-claims.repository", () => ({
  listPackages: vi.fn(async () => []),
  findPackageById: vi.fn(async () => null),
  findPackageByIdTx: vi.fn(async () => null),
  findPackageByKeyConflict: vi.fn(async () => null),
  createPackageRow: vi.fn(),
  updatePackageRow: vi.fn(),

  listClaims: vi.fn(async () => []),
  findClaimById: vi.fn(async () => null),
  findClaimByIdTx: vi.fn(async () => null),
  findFullClaimByIdTx: vi.fn(async () => null),
  createClaimRow: vi.fn(),
  updateClaimRow: vi.fn(),
  appendClaimTransition: vi.fn(async () => undefined),

  findClaimDocumentById: vi.fn(async () => null),
  listClaimDocumentsTx: vi.fn(async () => []),
  createClaimDocumentRow: vi.fn(),
  deleteClaimDocumentRow: vi.fn(async () => undefined),

  findSalesUnitForClaim: vi.fn(async () => null),
  findSalesUnitForClaimTx: vi.fn(async () => null),

  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({
      // The service does not call any tx.* methods directly except via
      // the repo mocks above, so an empty stub is fine.
    }),
  ),
}));

import { recordAudit } from "../../../lib/audit";
import {
  appendClaimTransition,
  createClaimDocumentRow,
  createClaimRow,
  createPackageRow,
  deleteClaimDocumentRow,
  findClaimById,
  findClaimDocumentById,
  findFullClaimByIdTx,
  findPackageById,
  findPackageByIdTx,
  findPackageByKeyConflict,
  findSalesUnitForClaim,
  listClaims,
  listPackages,
  updateClaimRow,
  updatePackageRow,
} from "../renovation-claims.repository";
import {
  approveClaimService,
  buildClaimDocumentStorageKey,
  createClaimService,
  createPackageService,
  deleteDocumentService,
  getClaimByIdService,
  getDocumentViewUrlService,
  getPackageByIdService,
  listClaimsService,
  listPackagesService,
  markDocumentUploadedService,
  needsAmendmentClaimService,
  rejectClaimService,
  updateClaimService,
  updatePackageService,
} from "../renovation-claims.service";
import type {
  RenovationClaimRow,
  RenovationPackageRow,
} from "../renovation-claims.types";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const AGENT = "00000000-0000-0000-0000-0000000000aa";
const SALES = "00000000-0000-0000-0000-0000000000bb";
const PKG = "00000000-0000-0000-0000-0000000000cc";
const CLAIM = "00000000-0000-0000-0000-0000000000dd";
const DOC = "00000000-0000-0000-0000-0000000000ee";

function fakePackage(overrides: Partial<RenovationPackageRow> = {}): RenovationPackageRow {
  return {
    id: PKG,
    organizationId: ORG,
    key: "standard",
    label: "Standard",
    description: null,
    defaultPrice: 25000,
    archived: false,
    sortOrder: 0,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    defaultSplits: [
      {
        id: "ds-1",
        organizationId: ORG,
        packageId: PKG,
        roleLabel: "Sales Commission",
        splitType: "percent",
        splitValue: 60,
        isHouseKeep: false,
        sortOrder: 0,
      },
      {
        id: "ds-2",
        organizationId: ORG,
        packageId: PKG,
        roleLabel: "Project Leader",
        splitType: "percent",
        splitValue: 15,
        isHouseKeep: false,
        sortOrder: 1,
      },
      {
        id: "ds-3",
        organizationId: ORG,
        packageId: PKG,
        roleLabel: "House Keep",
        splitType: "percent",
        splitValue: 25,
        isHouseKeep: true,
        sortOrder: 2,
      },
    ],
    ...overrides,
  };
}

function fakeClaim(overrides: Partial<RenovationClaimRow> = {}): RenovationClaimRow {
  return {
    id: CLAIM,
    organizationId: ORG,
    salesUnitId: SALES,
    packageId: PKG,
    packagePrice: 25000,
    paymentType: "full",
    monthlyOffsetAmount: null,
    status: "submitted",
    notes: null,
    submittedAt: new Date("2026-04-01T00:00:00.000Z"),
    submittedById: USER,
    reviewedAt: null,
    reviewedById: null,
    reviewerNote: null,
    splits: [
      {
        id: "s-1",
        organizationId: ORG,
        claimId: CLAIM,
        partyPartyId: AGENT,
        partyDisplayName: "Agent A",
        roleLabel: "Sales Commission",
        splitType: "percent",
        splitValue: 60,
        isHouseKeep: false,
        sortOrder: 0,
      },
      {
        id: "s-2",
        organizationId: ORG,
        claimId: CLAIM,
        partyPartyId: null,
        partyDisplayName: "PL",
        roleLabel: "Project Leader",
        splitType: "percent",
        splitValue: 15,
        isHouseKeep: false,
        sortOrder: 1,
      },
      {
        id: "s-3",
        organizationId: ORG,
        claimId: CLAIM,
        partyPartyId: null,
        partyDisplayName: "House",
        roleLabel: "House Keep",
        splitType: "percent",
        splitValue: 25,
        isHouseKeep: true,
        sortOrder: 2,
      },
    ],
    documents: [
      {
        id: "d-1",
        organizationId: ORG,
        claimId: CLAIM,
        kind: "quotation",
        fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
        filename: "q.pdf",
        uploadedAt: new Date("2026-04-01T00:00:00.000Z"),
        uploadedById: USER,
      },
      {
        id: "d-2",
        organizationId: ORG,
        claimId: CLAIM,
        kind: "invoice",
        fileKey: `renovation-claims/${ORG}/${CLAIM}/u-i.pdf`,
        filename: "i.pdf",
        uploadedAt: new Date("2026-04-01T00:00:00.000Z"),
        uploadedById: USER,
      },
    ],
    ...overrides,
  };
}

function ctx(role: "admin" | "manager" | "editor" = "manager") {
  return {
    orgId: ORG,
    actorUserId: USER,
    actorRole: role,
    ip: "10.0.0.1",
    userAgent: "vitest",
  } as const;
}

function baseCreateClaimInput() {
  return {
    salesUnitId: SALES,
    packageId: PKG,
    packagePrice: 25000,
    paymentType: "full" as const,
    monthlyOffsetAmount: null,
    notes: null,
    splits: [
      {
        partyPartyId: AGENT,
        partyDisplayName: "Agent A",
        roleLabel: "Sales Commission",
        splitType: "percent" as const,
        splitValue: 60,
        isHouseKeep: false,
        sortOrder: 0,
      },
      {
        partyPartyId: null,
        partyDisplayName: "PL",
        roleLabel: "Project Leader",
        splitType: "percent" as const,
        splitValue: 15,
        isHouseKeep: false,
        sortOrder: 1,
      },
      {
        partyPartyId: null,
        partyDisplayName: "House",
        roleLabel: "House Keep",
        splitType: "percent" as const,
        splitValue: 25,
        isHouseKeep: true,
        sortOrder: 2,
      },
    ],
    documents: [
      {
        fileKey: `renovation-claims/${ORG}/tmp/u-q.pdf`,
        kind: "quotation" as const,
        filename: "q.pdf",
      },
      {
        fileKey: `renovation-claims/${ORG}/tmp/u-i.pdf`,
        kind: "invoice" as const,
        filename: "i.pdf",
      },
    ],
  };
}

// ─── Packages ───────────────────────────────────────────────────────────────

describe("listPackagesService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 200 (read-only)", async () => {
    vi.mocked(listPackages).mockResolvedValueOnce([]);
    const r = await listPackagesService(ctx("editor"));
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("forwards filters", async () => {
    vi.mocked(listPackages).mockResolvedValueOnce([fakePackage()]);
    await listPackagesService(ctx("editor"), { archived: false });
    expect(listPackages).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ archived: false }),
    );
  });
});

describe("getPackageByIdService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when not found", async () => {
    vi.mocked(findPackageById).mockResolvedValueOnce(null);
    const r = await getPackageByIdService(ctx("editor"), PKG);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe("createPackageService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor + manager rejected (admin only)", async () => {
    expect(
      await createPackageService(ctx("editor"), {
        key: "x",
        label: "X",
        description: null,
        defaultPrice: 100,
        archived: false,
        sortOrder: 0,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await createPackageService(ctx("manager"), {
        key: "x",
        label: "X",
        description: null,
        defaultPrice: 100,
        archived: false,
        sortOrder: 0,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(createPackageRow).not.toHaveBeenCalled();
  });

  it("409 on duplicate key", async () => {
    vi.mocked(findPackageByKeyConflict).mockResolvedValueOnce({ id: "x" });
    const r = await createPackageService(ctx("admin"), {
      key: "standard",
      label: "Standard",
      description: null,
      defaultPrice: 25000,
      archived: false,
      sortOrder: 0,
    });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("400 when initial splits violate 100%", async () => {
    const r = await createPackageService(ctx("admin"), {
      key: "bad",
      label: "Bad",
      description: null,
      defaultPrice: 25000,
      archived: false,
      sortOrder: 0,
      defaultSplits: [
        {
          roleLabel: "X",
          splitType: "percent",
          splitValue: 60,
          isHouseKeep: false,
          sortOrder: 0,
        },
      ],
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(createPackageRow).not.toHaveBeenCalled();
  });

  it("happy: creates package + audits", async () => {
    vi.mocked(createPackageRow).mockResolvedValueOnce(fakePackage());
    const r = await createPackageService(ctx("admin"), {
      key: "standard",
      label: "Standard",
      description: null,
      defaultPrice: 25000,
      archived: false,
      sortOrder: 0,
      defaultSplits: [
        {
          roleLabel: "Sales Commission",
          splitType: "percent",
          splitValue: 60,
          isHouseKeep: false,
          sortOrder: 0,
        },
        {
          roleLabel: "Project Leader",
          splitType: "percent",
          splitValue: 15,
          isHouseKeep: false,
          sortOrder: 1,
        },
        {
          roleLabel: "House Keep",
          splitType: "percent",
          splitValue: 25,
          isHouseKeep: true,
          sortOrder: 2,
        },
      ],
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(createPackageRow).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.package.create" }),
    );
  });
});

describe("updatePackageService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor + manager rejected", async () => {
    expect(
      await updatePackageService(ctx("editor"), PKG, { label: "x" }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await updatePackageService(ctx("manager"), PKG, { label: "x" }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("404 when not found", async () => {
    vi.mocked(findPackageById).mockResolvedValueOnce(null);
    const r = await updatePackageService(ctx("admin"), PKG, { label: "x" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("400 when new splits violate 100%", async () => {
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage());
    const r = await updatePackageService(ctx("admin"), PKG, {
      defaultSplits: [
        {
          roleLabel: "X",
          splitType: "percent",
          splitValue: 90,
          isHouseKeep: false,
          sortOrder: 0,
        },
      ],
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(updatePackageRow).not.toHaveBeenCalled();
  });

  it("happy: updates label only", async () => {
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage());
    vi.mocked(findPackageByIdTx).mockResolvedValueOnce(fakePackage());
    vi.mocked(updatePackageRow).mockResolvedValueOnce(fakePackage({ label: "Updated" }));
    const r = await updatePackageService(ctx("admin"), PKG, { label: "Updated" });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.package.update" }),
    );
  });
});

// ─── Claims (read) ──────────────────────────────────────────────────────────

describe("listClaimsService — role-aware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 200; calls listClaims with role=editor (so repo strips $)", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([]);
    const r = await listClaimsService(ctx("editor"), {});
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "editor",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("manager passes role=manager", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([fakeClaim()]);
    await listClaimsService(ctx("manager"), {});
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "manager",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("forwards portal-side own-only filter via submittedByEq", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([]);
    await listClaimsService(ctx("editor"), { submittedByEq: USER });
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "editor",
      expect.objectContaining({ submittedByEq: USER }),
      expect.any(Object),
    );
  });

  it("forwards forceFullSelect: true to repository (portal own-only)", async () => {
    vi.mocked(listClaims).mockResolvedValueOnce([]);
    await listClaimsService(
      ctx("editor"),
      { submittedByEq: USER },
      { forceFullSelect: true },
    );
    expect(listClaims).toHaveBeenCalledWith(
      ORG,
      "editor",
      expect.any(Object),
      expect.objectContaining({ forceFullSelect: true }),
    );
  });
});

describe("getClaimByIdService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await getClaimByIdService(ctx("manager"), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("portal own-only: 404 when claim belongs to another agent", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim({ submittedById: "other" }));
    const r = await getClaimByIdService(ctx("editor"), CLAIM, {
      requireSubmittedById: USER,
    });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("happy: returns claim", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await getClaimByIdService(ctx("manager"), CLAIM);
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("forwards forceFullSelect: true to repository (portal own-only)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await getClaimByIdService(ctx("editor"), CLAIM, {
      requireSubmittedById: USER,
      forceFullSelect: true,
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(findClaimById).toHaveBeenCalledWith(
      ORG,
      "editor",
      CLAIM,
      expect.objectContaining({ forceFullSelect: true }),
    );
  });
});

// ─── Claims (submit) ────────────────────────────────────────────────────────

describe("createClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when sales unit missing", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce(null);
    const r = await createClaimService(ctx(), baseCreateClaimInput());
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("portal own-only: 404 when sales unit belongs to another agent", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: "someone-else",
    });
    const r = await createClaimService(
      ctx("editor"),
      baseCreateClaimInput(),
      { requireSalesUnitOwnerPartyId: AGENT },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("404 when package missing", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
    });
    vi.mocked(findPackageById).mockResolvedValueOnce(null);
    const r = await createClaimService(ctx(), baseCreateClaimInput());
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("400 when package archived", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
    });
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage({ archived: true }));
    const r = await createClaimService(ctx(), baseCreateClaimInput());
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("400 when splits don't sum to package price", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
    });
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage());
    const input = baseCreateClaimInput();
    input.splits[0].splitValue = 50; // total 90% → 22500, off by 2500
    const r = await createClaimService(ctx(), input);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(createClaimRow).not.toHaveBeenCalled();
  });

  it("400 when documents missing quotation", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
    });
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage());
    const input = baseCreateClaimInput();
    input.documents = input.documents.filter((d) => d.kind !== "quotation");
    const r = await createClaimService(ctx(), input);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/quotation/i);
  });

  it("400 when documents missing invoice", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
    });
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage());
    const input = baseCreateClaimInput();
    input.documents = input.documents.filter((d) => d.kind !== "invoice");
    const r = await createClaimService(ctx(), input);
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (r.ok) return;
    expect(r.error).toMatch(/invoice/i);
  });

  it("happy: creates claim + documents + transition + audit", async () => {
    vi.mocked(findSalesUnitForClaim).mockResolvedValueOnce({
      id: SALES,
      agentPartyId: AGENT,
    });
    vi.mocked(findPackageById).mockResolvedValueOnce(fakePackage());
    const created = fakeClaim();
    vi.mocked(createClaimRow).mockResolvedValueOnce(created);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(created);
    vi.mocked(createClaimDocumentRow).mockResolvedValue({
      id: "doc-x",
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: "k",
      filename: "f",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const r = await createClaimService(ctx(), baseCreateClaimInput(), {
      auditAction: "renovation.claim.create.portal",
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(createClaimDocumentRow).toHaveBeenCalledTimes(2);
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStatus: null, toStatus: "submitted" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.claim.create.portal" }),
    );
  });
});

// ─── Claims (edit) ──────────────────────────────────────────────────────────

describe("updateClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await updateClaimService(ctx(), CLAIM, { notes: "x" });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("portal own-only: 404 for non-owner", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ submittedById: "other" }),
    );
    const r = await updateClaimService(
      ctx("editor"),
      CLAIM,
      { notes: "x" },
      { requireSubmittedById: USER },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("admin path: editor 403", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await updateClaimService(ctx("editor"), CLAIM, { notes: "x" });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("400 when split rule violated on edit", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await updateClaimService(
      ctx(),
      CLAIM,
      {
        splits: [
          {
            partyPartyId: null,
            partyDisplayName: "X",
            roleLabel: "X",
            splitType: "percent",
            splitValue: 50, // only 50% of 25k = 12500, doesn't sum
            isHouseKeep: false,
            sortOrder: 0,
          },
        ],
      },
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("edit-after-approval rebound: PATCH on approved → needs_amendment + transition", async () => {
    const before = fakeClaim({ status: "approved" });
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    const after = fakeClaim({
      status: "needs_amendment",
      reviewerNote: "Edited by agent post-approval",
    });
    vi.mocked(updateClaimRow).mockResolvedValueOnce(after);

    const r = await updateClaimService(
      ctx("editor"),
      CLAIM,
      { notes: "edit" },
      {
        requireSubmittedById: USER,
        rebindOnApproval: true,
        auditAction: "renovation.claim.update.portal",
      },
    );
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({
        status: "needs_amendment",
        reviewerNote: "Edited by agent post-approval",
      }),
    );
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStatus: "approved", toStatus: "needs_amendment" }),
    );
  });
});

// ─── Approve / reject / needs-amendment ─────────────────────────────────────

describe("approveClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor 403", async () => {
    const r = await approveClaimService(ctx("editor"), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("404 when missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("409 when already approved (terminal)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ status: "approved" }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(updateClaimRow).not.toHaveBeenCalled();
  });

  it("409 when already rejected (terminal)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ status: "rejected" }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("400 when splits invalid at approve time (re-validates)", async () => {
    // Splits sum to 90% → invalid
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({
        splits: [
          {
            id: "s",
            organizationId: ORG,
            claimId: CLAIM,
            partyPartyId: null,
            partyDisplayName: "X",
            roleLabel: "X",
            splitType: "percent",
            splitValue: 90,
            isHouseKeep: false,
            sortOrder: 0,
          },
        ],
      }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("400 when document gate broken at approve time (quotation deleted)", async () => {
    // Submit-time docs had quotation+invoice; agent then DELETEs the
    // quotation. Approve must re-run the gate and refuse.
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({
        documents: [
          {
            id: "d-2",
            organizationId: ORG,
            claimId: CLAIM,
            kind: "invoice",
            fileKey: `renovation-claims/${ORG}/${CLAIM}/u-i.pdf`,
            filename: "i.pdf",
            uploadedAt: new Date(),
            uploadedById: USER,
          },
        ],
      }),
    );
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (r.ok) return;
    expect(r.error).toMatch(/quotation/i);
    expect(updateClaimRow).not.toHaveBeenCalled();
  });

  it("approves from submitted: writes transition + audit", async () => {
    const before = fakeClaim({ status: "submitted" });
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(fakeClaim({ status: "approved" }));

    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ status: "approved" }),
    );
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fromStatus: "submitted", toStatus: "approved" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.claim.approve" }),
    );
  });

  it("approves from needs_amendment", async () => {
    const before = fakeClaim({ status: "needs_amendment" });
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(fakeClaim({ status: "approved" }));
    const r = await approveClaimService(ctx(), CLAIM);
    expect(r).toMatchObject({ ok: true, status: 200 });
  });
});

describe("rejectClaimService + needsAmendmentClaimService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejectClaim: editor 403", async () => {
    const r = await rejectClaimService(ctx("editor"), CLAIM, "x");
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("rejectClaim: 409 when already rejected", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ status: "rejected" }),
    );
    const r = await rejectClaimService(ctx(), CLAIM, "no good");
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("rejectClaim: writes status + reviewerNote + transition + audit", async () => {
    const before = fakeClaim();
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(
      fakeClaim({ status: "rejected", reviewerNote: "no good" }),
    );
    await rejectClaimService(ctx(), CLAIM, "no good");
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ status: "rejected", reviewerNote: "no good" }),
    );
    expect(appendClaimTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: "rejected", note: "no good" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.claim.reject" }),
    );
  });

  it("needsAmendmentClaim: writes status=needs_amendment + audit", async () => {
    const before = fakeClaim();
    vi.mocked(findClaimById).mockResolvedValueOnce(before);
    vi.mocked(findFullClaimByIdTx).mockResolvedValueOnce(before);
    vi.mocked(updateClaimRow).mockResolvedValueOnce(
      fakeClaim({ status: "needs_amendment", reviewerNote: "fix splits" }),
    );
    await needsAmendmentClaimService(ctx(), CLAIM, "fix splits");
    expect(updateClaimRow).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      ORG,
      expect.objectContaining({ status: "needs_amendment", reviewerNote: "fix splits" }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.claim.needs_amendment" }),
    );
  });
});

// ─── Org isolation ──────────────────────────────────────────────────────────

describe("org isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getClaimByIdService: cross-org returns 404", async () => {
    vi.mocked(findClaimById).mockImplementationOnce(async (orgId) => {
      if (orgId !== ORG) return null;
      return fakeClaim();
    });
    const r = await getClaimByIdService(
      { orgId: "other-org", actorUserId: USER, actorRole: "manager" },
      CLAIM,
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

// ─── Document upload flow ──────────────────────────────────────────────────

describe("buildClaimDocumentStorageKey", () => {
  it("uses claimId when provided", () => {
    const key = buildClaimDocumentStorageKey({
      organizationId: ORG,
      claimId: CLAIM,
      uuid: "u1",
      filename: "doc.pdf",
    });
    expect(key).toBe(`renovation-claims/${ORG}/${CLAIM}/u1-doc.pdf`);
  });

  it("uses tmp slot when claimId is null", () => {
    const key = buildClaimDocumentStorageKey({
      organizationId: ORG,
      claimId: null,
      uuid: "u1",
      filename: "doc.pdf",
    });
    expect(key).toBe(`renovation-claims/${ORG}/tmp/u1-doc.pdf`);
  });

  it("strips path separators from filename", () => {
    const key = buildClaimDocumentStorageKey({
      organizationId: ORG,
      claimId: CLAIM,
      uuid: "u1",
      filename: "../etc/passwd",
    });
    expect(key).not.toContain("../");
    expect(key).toContain("u1-.._etc_passwd");
  });
});

describe("markDocumentUploadedService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when claim missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await markDocumentUploadedService(ctx(), CLAIM, {
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      kind: "quotation",
      filename: "q.pdf",
    });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("404 portal own-only", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(
      fakeClaim({ submittedById: "other" }),
    );
    const r = await markDocumentUploadedService(
      ctx("editor"),
      CLAIM,
      {
        fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
        kind: "quotation",
        filename: "q.pdf",
      },
      { requireSubmittedById: USER },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("400 when fileKey doesn't start with org prefix", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    const r = await markDocumentUploadedService(ctx(), CLAIM, {
      fileKey: `renovation-claims/other-org/x.pdf`,
      kind: "quotation",
      filename: "q.pdf",
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(createClaimDocumentRow).not.toHaveBeenCalled();
  });

  it("happy: persists document row + audits", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(createClaimDocumentRow).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const r = await markDocumentUploadedService(ctx(), CLAIM, {
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      kind: "quotation",
      filename: "q.pdf",
    });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.claim.document.upload" }),
    );
  });

  it("portal auditAction override stamps .create.portal", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(createClaimDocumentRow).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    await markDocumentUploadedService(
      ctx(),
      CLAIM,
      {
        fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
        kind: "quotation",
        filename: "q.pdf",
      },
      { auditAction: "renovation.claim.document.create.portal" },
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "renovation.claim.document.create.portal",
      }),
    );
  });
});

describe("deleteDocumentService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when claim missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await deleteDocumentService(
      ctx(),
      CLAIM,
      DOC,
      { deleteObject: vi.fn() },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("404 when document missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(findClaimDocumentById).mockResolvedValueOnce(null);
    const r = await deleteDocumentService(
      ctx(),
      CLAIM,
      DOC,
      { deleteObject: vi.fn() },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("happy: deletes DB row + storage object + audits", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(findClaimDocumentById).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const deleteObject = vi.fn(async () => undefined);
    const r = await deleteDocumentService(ctx(), CLAIM, DOC, { deleteObject });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(deleteClaimDocumentRow).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      CLAIM,
      DOC,
    );
    expect(deleteObject).toHaveBeenCalledWith(
      "test-bucket",
      `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "renovation.claim.document.delete" }),
    );
  });

  it("portal auditAction override stamps .delete.portal", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(findClaimDocumentById).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const deleteObject = vi.fn(async () => undefined);
    await deleteDocumentService(
      ctx(),
      CLAIM,
      DOC,
      { deleteObject },
      { auditAction: "renovation.claim.document.delete.portal" },
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "renovation.claim.document.delete.portal",
      }),
    );
  });

  it("swallows storage delete errors (best-effort)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(findClaimDocumentById).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const deleteObject = vi.fn(async () => {
      throw new Error("flake");
    });
    const r = await deleteDocumentService(ctx(), CLAIM, DOC, { deleteObject });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });
});

describe("getDocumentViewUrlService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404 when claim missing", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(null);
    const r = await getDocumentViewUrlService(
      ctx(),
      CLAIM,
      DOC,
      {
        signSupabaseView: async () => ({
          viewUrl: "x",
          expiresAt: new Date(),
        }),
      },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("404 when fileKey doesn't match org prefix (defence-in-depth)", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(findClaimDocumentById).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/some-other-org/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const r = await getDocumentViewUrlService(
      ctx(),
      CLAIM,
      DOC,
      {
        signSupabaseView: async () => ({
          viewUrl: "x",
          expiresAt: new Date(),
        }),
      },
    );
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it("happy: returns signed url", async () => {
    vi.mocked(findClaimById).mockResolvedValueOnce(fakeClaim());
    vi.mocked(findClaimDocumentById).mockResolvedValueOnce({
      id: DOC,
      organizationId: ORG,
      claimId: CLAIM,
      kind: "quotation",
      fileKey: `renovation-claims/${ORG}/${CLAIM}/u-q.pdf`,
      filename: "q.pdf",
      uploadedAt: new Date(),
      uploadedById: USER,
    });
    const expiresAt = new Date(Date.now() + 60_000);
    const r = await getDocumentViewUrlService(
      ctx(),
      CLAIM,
      DOC,
      {
        signSupabaseView: async () => ({ viewUrl: "https://signed", expiresAt }),
      },
    );
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      data: { viewUrl: "https://signed", expiresAt },
    });
  });
});
