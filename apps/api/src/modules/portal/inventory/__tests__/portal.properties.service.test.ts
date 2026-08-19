// Tests for portal.properties.service covering the agent-side
// PropertySubmission lifecycle: list / get / amend / withdraw. The admin
// half is in apps/api/src/modules/submissions/property-submission.service.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const propertySubmissionStore = new Map<string, Record<string, unknown>>();
const unitSubmissionStore = new Map<string, Record<string, unknown>>();
const propertyStore = new Map<string, Record<string, unknown>>();

const dbMock = {
  property: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string; propertyCode?: string };
      return (
        [...propertyStore.values()].find(
          (row) =>
            (!w.id || row.id === w.id) &&
            (!w.organizationId || row.organizationId === w.organizationId) &&
            (!w.propertyCode || row.propertyCode === w.propertyCode),
        ) ?? null
      );
    }),
  },
  propertySubmission: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        id?: string;
        organizationId?: string;
        sourcingAgentId?: string;
      };
      return (
        [...propertySubmissionStore.values()].find(
          (row) =>
            (!w.id || row.id === w.id) &&
            (!w.organizationId || row.organizationId === w.organizationId) &&
            (!w.sourcingAgentId || row.sourcingAgentId === w.sourcingAgentId),
        ) ?? null
      );
    }),
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        organizationId?: string;
        sourcingAgentId?: string;
      };
      const rows = [...propertySubmissionStore.values()].filter(
        (row) =>
          (!w.organizationId || row.organizationId === w.organizationId) &&
          (!w.sourcingAgentId || row.sourcingAgentId === w.sourcingAgentId),
      );
      return rows.sort(
        (a, b) =>
          (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
      );
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const id = `sub-${propertySubmissionStore.size + 1}`;
      const row = { id, createdAt: new Date(), updatedAt: new Date(), ...args.data };
      propertySubmissionStore.set(id, row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = propertySubmissionStore.get(args.where.id);
      if (!row) throw new Error("not found");
      const next = { ...row, ...args.data, updatedAt: new Date() };
      propertySubmissionStore.set(args.where.id, next);
      return next;
    }),
  },
  unitSubmission: {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        propertySubmissionId?: string;
        submissionState?: { in?: string[] };
      };
      return [...unitSubmissionStore.values()].filter((row) => {
        if (w.propertySubmissionId && row.propertySubmissionId !== w.propertySubmissionId) return false;
        if (w.submissionState?.in && !w.submissionState.in.includes(row.submissionState as string))
          return false;
        return true;
      });
    }),
  },
  $transaction: vi
    .fn()
    .mockImplementation(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
  Prisma: {},
}));

vi.mock("../../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import {
  portalCancelOwnPropertyService,
  portalGetOwnPropertyService,
  portalListOwnPropertiesService,
  portalUpdateOwnPropertyService,
} from "../portal.properties.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const AGENT = "00000000-0000-0000-0000-000000000aaa";
const OTHER_AGENT = "00000000-0000-0000-0000-000000000bbb";
const AGENT_USER = "00000000-0000-0000-0000-000000000a01";

const ctx = {
  orgId: ORG,
  actorUserId: AGENT_USER,
  partyId: AGENT,
} as const;

type State = "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";

function seedSubmission(
  id: string,
  state: State,
  overrides: Partial<Record<string, unknown>> = {},
) {
  propertySubmissionStore.set(id, {
    id,
    organizationId: ORG,
    propertyCode: `TC-${id.slice(-3)}`,
    proposedName: `Submission ${id}`,
    propertyType: "Condominium",
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "KL",
    state: null,
    postalCode: null,
    country: "MY",
    sourcingAgentId: AGENT,
    submissionState: state,
    amendmentNote: state === "needs_amendment" || state === "rejected" ? "Fix the postcode" : null,
    submittedPayload: {},
    approvedPropertyId: state === "approved" ? "approved-prop-id" : null,
    createdAt: new Date(Date.now() - Math.random() * 1_000_000),
    updatedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  propertySubmissionStore.clear();
  unitSubmissionStore.clear();
  propertyStore.clear();
  vi.clearAllMocks();
});

describe("portalListOwnPropertiesService", () => {
  it("returns submissions in every state for the agent (no filter)", async () => {
    seedSubmission("p-1", "pending");
    seedSubmission("p-2", "needs_amendment");
    seedSubmission("p-3", "approved");
    seedSubmission("p-4", "rejected");
    seedSubmission("p-5", "withdrawn");

    const rows = await portalListOwnPropertiesService(ctx);

    expect(rows.map((r) => r.submissionState).sort()).toEqual(
      ["approved", "needs_amendment", "pending", "rejected", "withdrawn"],
    );
  });

  it("does not include another agent's submissions", async () => {
    seedSubmission("own-1", "pending");
    seedSubmission("other-1", "pending", { sourcingAgentId: OTHER_AGENT });

    const rows = await portalListOwnPropertiesService(ctx);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("own-1");
  });

  it("surfaces amendmentNote on needs_amendment rows", async () => {
    seedSubmission("p-1", "needs_amendment");

    const rows = await portalListOwnPropertiesService(ctx);

    expect(rows[0]!.amendmentNote).toBe("Fix the postcode");
  });
});

describe("portalGetOwnPropertyService", () => {
  it("returns the agent's own submission with full detail", async () => {
    seedSubmission("p-1", "needs_amendment");

    const result = await portalGetOwnPropertyService(ctx, "p-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.id).toBe("p-1");
    expect(result.data.proposedName).toBe("Submission p-1");
    expect(result.data.propertyType).toBe("Condominium");
    expect(result.data.amendmentNote).toBe("Fix the postcode");
    expect(result.data.submissionState).toBe("needs_amendment");
  });

  it("404s when the submission belongs to another agent", async () => {
    seedSubmission("other-1", "pending", { sourcingAgentId: OTHER_AGENT });

    const result = await portalGetOwnPropertyService(ctx, "other-1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });

  it("404s when the submission does not exist", async () => {
    const result = await portalGetOwnPropertyService(ctx, "missing-id");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });
});

describe("portalUpdateOwnPropertyService", () => {
  const validInput = {
    propertyCode: "TC-EDITED",
    proposedName: "The Capers — edited",
    propertyType: "Condominium",
    addressLine1: "99 Edited Rd",
    addressLine2: "Block A",
    city: "KL",
    state: "Selangor",
    postalCode: "53000",
    country: "MY",
  };

  it("flips needs_amendment → pending, updates columns, clears amendmentNote", async () => {
    seedSubmission("p-1", "needs_amendment");

    const result = await portalUpdateOwnPropertyService(ctx, "p-1", validInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const stored = propertySubmissionStore.get("p-1")!;
    expect(stored.submissionState).toBe("pending");
    expect(stored.amendmentNote).toBeNull();
    expect(stored.propertyCode).toBe("TC-EDITED");
    expect(stored.proposedName).toBe("The Capers — edited");
    expect(stored.postalCode).toBe("53000");
    expect(stored.state).toBe("Selangor");
  });

  it("regenerates submittedPayload to match the new column values", async () => {
    seedSubmission("p-1", "needs_amendment");

    await portalUpdateOwnPropertyService(ctx, "p-1", validInput);

    const stored = propertySubmissionStore.get("p-1")!;
    const payload = stored.submittedPayload as Record<string, unknown>;
    expect(payload.propertyCode).toBe("TC-EDITED");
    expect(payload.proposedName).toBe("The Capers — edited");
  });

  it("on a pending submission, columns update but state stays pending", async () => {
    seedSubmission("p-1", "pending");

    const result = await portalUpdateOwnPropertyService(ctx, "p-1", validInput);

    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get("p-1")!.submissionState).toBe("pending");
    expect(propertySubmissionStore.get("p-1")!.propertyCode).toBe("TC-EDITED");
  });

  it("409 SUBMISSION_NOT_AMENDABLE on approved", async () => {
    seedSubmission("p-1", "approved");

    const result = await portalUpdateOwnPropertyService(ctx, "p-1", validInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
    expect(result.error).toBe("SUBMISSION_NOT_AMENDABLE");
  });

  it("409 on rejected", async () => {
    seedSubmission("p-1", "rejected");

    const result = await portalUpdateOwnPropertyService(ctx, "p-1", validInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
  });

  it("409 on withdrawn", async () => {
    seedSubmission("p-1", "withdrawn");

    const result = await portalUpdateOwnPropertyService(ctx, "p-1", validInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
  });

  it("404 on another agent's submission", async () => {
    seedSubmission("other-1", "needs_amendment", { sourcingAgentId: OTHER_AGENT });

    const result = await portalUpdateOwnPropertyService(ctx, "other-1", validInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });
});

describe("portalCancelOwnPropertyService", () => {
  function seedChild(id: string, state: State) {
    unitSubmissionStore.set(id, {
      id,
      organizationId: ORG,
      propertySubmissionId: "p-1",
      sourcingAgentId: AGENT,
      submissionState: state,
    });
  }

  it("flips pending → withdrawn when there are no children", async () => {
    seedSubmission("p-1", "pending");

    const result = await portalCancelOwnPropertyService(ctx, "p-1");

    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get("p-1")!.submissionState).toBe("withdrawn");
  });

  it("flips needs_amendment → withdrawn", async () => {
    seedSubmission("p-1", "needs_amendment");

    const result = await portalCancelOwnPropertyService(ctx, "p-1");

    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get("p-1")!.submissionState).toBe("withdrawn");
  });

  it("409 PROPERTY_HAS_PENDING_UNITS when a child unit is pending", async () => {
    seedSubmission("p-1", "pending");
    seedChild("u-1", "pending");
    seedChild("u-2", "needs_amendment");
    seedChild("u-3", "approved");

    const result = await portalCancelOwnPropertyService(ctx, "p-1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
    expect(result.error).toBe("PROPERTY_HAS_PENDING_UNITS");
    expect(result.blockingUnitIds).toEqual(expect.arrayContaining(["u-1", "u-2"]));
    expect(result.blockingUnitIds).not.toContain("u-3");
  });

  it("succeeds when all children are terminal", async () => {
    seedSubmission("p-1", "pending");
    seedChild("u-1", "approved");
    seedChild("u-2", "rejected");
    seedChild("u-3", "withdrawn");

    const result = await portalCancelOwnPropertyService(ctx, "p-1");

    expect(result.ok).toBe(true);
    expect(propertySubmissionStore.get("p-1")!.submissionState).toBe("withdrawn");
  });

  it("409 on approved", async () => {
    seedSubmission("p-1", "approved");

    const result = await portalCancelOwnPropertyService(ctx, "p-1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(409);
  });

  it("404 on another agent's submission", async () => {
    seedSubmission("other-1", "pending", { sourcingAgentId: OTHER_AGENT });

    const result = await portalCancelOwnPropertyService(ctx, "other-1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.status).toBe(404);
  });
});
