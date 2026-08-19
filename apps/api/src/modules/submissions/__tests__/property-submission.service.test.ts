// apps/api/src/modules/submissions/__tests__/property-submission.service.test.ts
//
// Covers approve / reject / needs-amendment for PropertySubmission and the
// child-UnitSubmission cascade on approve (eager-rewrite pattern).

import { beforeEach, describe, expect, it, vi } from "vitest";

const propertySubmissionStore = new Map<string, Record<string, unknown>>();
const unitSubmissionStore = new Map<string, Record<string, unknown>>();
const propertyStore = new Map<string, Record<string, unknown>>();

const dbMock = {
  propertySubmission: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string };
      return [...propertySubmissionStore.values()].find(
        (s) => (!w.id || s.id === w.id) && (!w.organizationId || s.organizationId === w.organizationId),
      ) ?? null;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = propertySubmissionStore.get(args.where.id);
      if (!row) throw new Error("not found");
      const next = { ...row, ...args.data };
      propertySubmissionStore.set(args.where.id, next);
      return next;
    }),
  },
  unitSubmission: {
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const w = args.where as { propertySubmissionId?: string };
      let count = 0;
      for (const [id, row] of unitSubmissionStore.entries()) {
        if (w.propertySubmissionId && row.propertySubmissionId === w.propertySubmissionId) {
          unitSubmissionStore.set(id, { ...row, ...args.data });
          count++;
        }
      }
      return { count };
    }),
  },
  property: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const id = `prop-${propertyStore.size + 1}`;
      const row = { id, ...args.data };
      propertyStore.set(id, row);
      return row;
    }),
  },
  $transaction: vi.fn().mockImplementation(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
  Prisma: {},
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import {
  approvePropertySubmissionService,
  rejectPropertySubmissionService,
  setPropertySubmissionNeedsAmendmentService,
} from "../property-submission.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ADMIN = "00000000-0000-0000-0000-000000000010";
const AGENT = "00000000-0000-0000-0000-000000000020";
const SUB = "00000000-0000-0000-0000-000000000aaa";
const ctx = { orgId: ORG, userId: ADMIN, actorRole: "admin" as const };

function seedPropertySubmission(state: "pending" | "needs_amendment" | "rejected" | "approved" = "pending") {
  propertySubmissionStore.set(SUB, {
    id: SUB,
    organizationId: ORG,
    propertyCode: "TEST-01",
    proposedName: "TestE 20 May",
    propertyType: "Condominium",
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "KL",
    state: null,
    postalCode: null,
    country: "MY",
    sourcingAgentId: AGENT,
    submissionState: state,
    amendmentNote: null,
    submittedPayload: {},
  });
}

function seedChildUnitSubmission(id: string) {
  unitSubmissionStore.set(id, {
    id,
    organizationId: ORG,
    propertyId: null,
    propertySubmissionId: SUB,
    sourcingAgentId: AGENT,
    submissionState: "pending",
  });
}

beforeEach(() => {
  propertySubmissionStore.clear();
  unitSubmissionStore.clear();
  propertyStore.clear();
  vi.clearAllMocks();
});

describe("approvePropertySubmissionService", () => {
  it("creates a Property + marks submission approved + cascades to child units", async () => {
    seedPropertySubmission("pending");
    seedChildUnitSubmission("u-1");
    seedChildUnitSubmission("u-2");

    const result = await approvePropertySubmissionService(ctx, SUB);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // A real Property row exists.
    expect(propertyStore.size).toBe(1);
    const property = [...propertyStore.values()][0]!;
    expect(property.name).toBe("TestE 20 May");
    expect(property.status).toBe("active");
    // Regression: Property.publishStatus is NOT NULL — the approve flow must
    // set it explicitly, otherwise the Prisma create rejects with
    // "Argument `publishStatus` is missing". Caught in UAT 2026-05-21.
    expect(property.publishStatus).toBe("draft");
    // approvedAt / approvedById live on PropertySubmission post three-table
    // refactor — NOT on Property. Asserting the Property row is clean of
    // those fields prevents the regression where they get smuggled back into
    // the create payload (which produces a Prisma "Unknown argument" error).
    expect(property.approvedById).toBeUndefined();
    expect(property.approvedAt).toBeUndefined();
    expect(property.sourceFlag).toBeUndefined();
    expect(property.sourcingAgentId).toBeUndefined();
    expect(result.data.approvedPropertyId).toBe(property.id);

    // Submission is approved + linked, and the submission row carries the
    // approval audit data.
    const sub = propertySubmissionStore.get(SUB);
    expect(sub?.submissionState).toBe("approved");
    expect(sub?.approvedPropertyId).toBe(property.id);
    expect(sub?.approvedById).toBe(ADMIN);

    // Children rewired — propertyId now set, propertySubmissionId cleared.
    expect(unitSubmissionStore.get("u-1")?.propertyId).toBe(property.id);
    expect(unitSubmissionStore.get("u-1")?.propertySubmissionId).toBeNull();
    expect(unitSubmissionStore.get("u-2")?.propertyId).toBe(property.id);
  });

  it("approves a needs_amendment submission as well", async () => {
    seedPropertySubmission("needs_amendment");
    const result = await approvePropertySubmissionService(ctx, SUB);
    expect(result.ok).toBe(true);
  });

  it("does NOT smuggle PropertySubmission-only columns (proposedName) into Property.create after agent amend", async () => {
    // Regression for Bug 1 (2026-05-24): portalUpdateOwnPropertyService writes
    // nextColumns into submittedPayload. nextColumns includes `proposedName` —
    // a PropertySubmission column that does NOT exist on Property. Pre-fix,
    // approve spread submittedPayload via `...extras` and Prisma rejected the
    // create with "Unknown argument `proposedName`". The fix dropped the
    // spread; this test pins it down so the spread can't be re-introduced.
    propertySubmissionStore.set(SUB, {
      id: SUB,
      organizationId: ORG,
      propertyCode: "TEST-AMEND",
      proposedName: "TEAST",
      propertyType: "condo",
      addressLine1: "No.01, Lorong Nona",
      addressLine2: "Taman Eng Ann",
      city: "Klang",
      state: "Selangor",
      postalCode: "41150",
      country: "Malaysia",
      sourcingAgentId: AGENT,
      submissionState: "needs_amendment",
      amendmentNote: null,
      submittedPayload: {
        propertyCode: "TEST-AMEND",
        proposedName: "TEAST",
        propertyType: "condo",
        addressLine1: "No.01, Lorong Nona",
        addressLine2: "Taman Eng Ann",
        city: "Klang",
        state: "Selangor",
        postalCode: "41150",
        country: "Malaysia",
      },
    });

    const result = await approvePropertySubmissionService(ctx, SUB);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const property = [...propertyStore.values()][0]!;
    expect(property.name).toBe("TEAST");
    // The Property row must carry `name`, not `proposedName` — and must not
    // pick up any other PropertySubmission-only column from the snapshot.
    expect(property.proposedName).toBeUndefined();
  });

  it("returns 404 when submission does not exist", async () => {
    const result = await approvePropertySubmissionService(ctx, "missing-id");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });

  it("returns 409 when submission is already approved", async () => {
    seedPropertySubmission("approved");
    const result = await approvePropertySubmissionService(ctx, SUB);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
  });

  it("returns 409 when submission is already rejected", async () => {
    seedPropertySubmission("rejected");
    const result = await approvePropertySubmissionService(ctx, SUB);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });
});

describe("setPropertySubmissionNeedsAmendmentService", () => {
  it("flips a pending submission to needs_amendment with note", async () => {
    seedPropertySubmission("pending");
    const result = await setPropertySubmissionNeedsAmendmentService(ctx, SUB, "Fix the postcode");
    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get(SUB)?.submissionState).toBe("needs_amendment");
    expect(propertySubmissionStore.get(SUB)?.amendmentNote).toBe("Fix the postcode");
  });

  it("returns 409 when submission is not pending", async () => {
    seedPropertySubmission("rejected");
    const result = await setPropertySubmissionNeedsAmendmentService(ctx, SUB, "");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("returns 404 when submission missing", async () => {
    const result = await setPropertySubmissionNeedsAmendmentService(ctx, "missing", "");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });
});

describe("rejectPropertySubmissionService", () => {
  it("rejects a pending submission terminally", async () => {
    seedPropertySubmission("pending");
    const result = await rejectPropertySubmissionService(ctx, SUB, "Property doesn't exist");
    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get(SUB)?.submissionState).toBe("rejected");
  });

  it("rejects a needs_amendment submission (admin sees the resubmission and decides terminally)", async () => {
    seedPropertySubmission("needs_amendment");
    const result = await rejectPropertySubmissionService(ctx, SUB, "Tried again, still no");
    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get(SUB)?.submissionState).toBe("rejected");
  });

  it("returns 409 when submission is already rejected", async () => {
    seedPropertySubmission("rejected");
    const result = await rejectPropertySubmissionService(ctx, SUB, "");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });
});
