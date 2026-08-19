// apps/api/src/modules/submissions/__tests__/submission.service.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const submissionStore = new Map<string, Record<string, unknown>>();
const listingStore = new Map<string, Record<string, unknown>>();
const apartmentStore = new Map<string, Record<string, unknown>>();
const propertyStore = new Map<string, Record<string, unknown>>();

const dbMock = {
  unitSubmission: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const id = `sub-${submissionStore.size + 1}`;
      const row = { id, createdAt: new Date(), updatedAt: new Date(), ...args.data };
      submissionStore.set(id, row);
      return row;
    }),
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string };
      return [...submissionStore.values()].find(
        (s) => (!w.id || s.id === w.id) && (!w.organizationId || s.organizationId === w.organizationId),
      ) ?? null;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = submissionStore.get(args.where.id);
      if (!row) throw new Error("not found");
      const next = { ...row, ...args.data };
      submissionStore.set(args.where.id, next);
      return next;
    }),
  },
  listing: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string; sourcingAgentId?: string };
      const matches = [...listingStore.values()].filter(
        (l) =>
          (!w.id || l.id === w.id) &&
          (!w.organizationId || l.organizationId === w.organizationId) &&
          (!w.sourcingAgentId || l.sourcingAgentId === w.sourcingAgentId),
      );
      const match = matches[0];
      if (!match) return null;
      // Simulate the apartment relation include
      const apt = apartmentStore.get(match.apartmentId as string);
      return { ...match, apartment: apt };
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => {
      return listingStore.get(args.where.id) ?? null;
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      const id = `l-${listingStore.size + 1}`;
      const row = { id, ...args.data };
      listingStore.set(id, row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = listingStore.get(args.where.id);
      if (!row) throw new Error("not found");
      const next = { ...row, ...args.data };
      listingStore.set(args.where.id, next);
      return next;
    }),
  },
  property: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string };
      return (
        [...propertyStore.values()].find(
          (p) =>
            (!w.id || p.id === w.id) &&
            (!w.organizationId || p.organizationId === w.organizationId),
        ) ?? null
      );
    }),
  },
  apartment: {
    upsert: vi.fn(async (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const w = args.where as { organizationId_propertyId_unitCode?: { organizationId: string; propertyId: string; unitCode: string } };
      const key = w.organizationId_propertyId_unitCode;
      if (key) {
        const existing = [...apartmentStore.values()].find(
          (a) => a.organizationId === key.organizationId && a.propertyId === key.propertyId && a.unitCode === key.unitCode,
        );
        if (existing) return existing;
      }
      const id = `apt-${apartmentStore.size + 1}`;
      const row = { id, ...args.create };
      apartmentStore.set(id, row);
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
  createUnitSubmissionService,
  createAmendmentService,
  withdrawSubmissionService,
  approveSubmissionService,
  setSubmissionNeedsAmendmentService,
  rejectSubmissionService,
  resubmitSubmissionService,
} from "../submission.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const PROP = "00000000-0000-0000-0000-000000000002";
const AGENT = "00000000-0000-0000-0000-000000000a01";
const OTHER_AGENT = "00000000-0000-0000-0000-000000000a02";
const ADMIN_USER = "00000000-0000-0000-0000-000000000010";
const AGENT_USER = "00000000-0000-0000-0000-000000000011";

const agentSession = { orgId: ORG, userId: AGENT_USER, partyId: AGENT };
const adminSession = { orgId: ORG, userId: ADMIN_USER };

const validPayload = {
  listing: {
    rentalRate: 1500,
    depositMonths: 2,
    occupancyStatus: "vacant",
    visibilityMode: "PUBLIC" as const,
  },
  apartmentShared: {
    bedrooms: 2,
    bathrooms: 1,
    amenities: ["am-pool"],
  },
};

beforeEach(() => {
  submissionStore.clear();
  listingStore.clear();
  apartmentStore.clear();
  propertyStore.clear();
  propertyStore.set(PROP, { id: PROP, organizationId: ORG, status: "active" });
  vi.clearAllMocks();
  dbMock.$transaction.mockImplementation(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock));
});

// -----------------------------------------------------------------------------

describe("createUnitSubmissionService", () => {
  it("creates a pending submission with parentListingId=null for a new listing", async () => {
    const r = await createUnitSubmissionService(agentSession, {
      propertyId: PROP,
      unitCode: "A-08-08",
      listingType: "Master",
      listingMode: "PARTITIONED",
      payload: validPayload,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const sub = submissionStore.get(r.data.id)!;
    expect(sub.submissionState).toBe("pending");
    expect(sub.parentListingId).toBeNull();
    expect(sub.sourcingAgentId).toBe(AGENT);
  });

  it("returns 400 on invalid payload", async () => {
    const r = await createUnitSubmissionService(agentSession, {
      propertyId: PROP,
      unitCode: "A-08-08",
      listingType: "Master",
      listingMode: "PARTITIONED",
      payload: { listing: { rentalRate: "not-a-number" } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });

  it("returns 403 if caller has no partyId", async () => {
    const r = await createUnitSubmissionService({ orgId: ORG, userId: AGENT_USER }, {
      propertyId: PROP,
      unitCode: "A-08-08",
      listingType: "Master",
      listingMode: "PARTITIONED",
      payload: validPayload,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
  });
});

// -----------------------------------------------------------------------------

describe("createAmendmentService", () => {
  it("creates a submission with parentListingId for an own agent-sourced listing", async () => {
    apartmentStore.set("apt-1", {
      id: "apt-1", organizationId: ORG, propertyId: PROP, unitCode: "A-08-08", listingMode: "PARTITIONED",
    });
    listingStore.set("l-master", {
      id: "l-master", organizationId: ORG, apartmentId: "apt-1", listingType: "Master", sourcingAgentId: AGENT,
    });

    const r = await createAmendmentService(agentSession, "l-master", validPayload);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const sub = submissionStore.get(r.data.submissionId)!;
    expect(sub.parentListingId).toBe("l-master");
    expect(sub.listingType).toBe("Master");
    expect(sub.listingMode).toBe("PARTITIONED");
  });

  it("returns 403 when amending another agent's listing", async () => {
    apartmentStore.set("apt-1", {
      id: "apt-1", organizationId: ORG, propertyId: PROP, unitCode: "A-08-08", listingMode: "PARTITIONED",
    });
    listingStore.set("l-master", {
      id: "l-master", organizationId: ORG, apartmentId: "apt-1", listingType: "Master", sourcingAgentId: OTHER_AGENT,
    });

    const r = await createAmendmentService(agentSession, "l-master", validPayload);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
  });
});

// -----------------------------------------------------------------------------

describe("withdrawSubmissionService", () => {
  it("withdraws a pending submission", async () => {
    submissionStore.set("s1", { id: "s1", organizationId: ORG, sourcingAgentId: AGENT, submissionState: "pending" });
    const r = await withdrawSubmissionService(agentSession, "s1");
    expect(r.ok).toBe(true);
    expect(submissionStore.get("s1")!.submissionState).toBe("withdrawn");
  });

  it("returns 403 when withdrawing another agent's submission", async () => {
    submissionStore.set("s1", { id: "s1", organizationId: ORG, sourcingAgentId: OTHER_AGENT, submissionState: "pending" });
    const r = await withdrawSubmissionService(agentSession, "s1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
  });

  it("returns 409 when withdrawing an already-approved submission", async () => {
    submissionStore.set("s1", { id: "s1", organizationId: ORG, sourcingAgentId: AGENT, submissionState: "approved" });
    const r = await withdrawSubmissionService(agentSession, "s1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
  });
});

// -----------------------------------------------------------------------------

describe("approveSubmissionService", () => {
  it("creates an Apartment + Listing from a new submission, marks submission approved", async () => {
    submissionStore.set("s-new", {
      id: "s-new",
      organizationId: ORG,
      propertyId: PROP,
      propertySubmissionId: null,
      unitCode: "A-08-08",
      listingType: "Master",
      listingMode: "PARTITIONED",
      parentListingId: null,
      sourcingAgentId: AGENT,
      submissionState: "pending",
      submittedPayload: validPayload,
    });

    const r = await approveSubmissionService(adminSession, "s-new");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Listing was created
    const listing = listingStore.get(r.data.approvedListingId)!;
    expect(listing).toBeDefined();
    expect(listing.listingStatus).toBe("active");
    expect(listing.listingType).toBe("Master");
    expect(listing.sourcingAgentId).toBe(AGENT);

    // Apartment was created via upsert
    expect(apartmentStore.size).toBe(1);

    // Submission marked approved with back-pointer
    const sub = submissionStore.get("s-new")!;
    expect(sub.submissionState).toBe("approved");
    expect(sub.approvedListingId).toBe(r.data.approvedListingId);
    expect(sub.approvedById).toBe(ADMIN_USER);
  });

  it("updates an existing Listing on amendment approval", async () => {
    apartmentStore.set("apt-1", {
      id: "apt-1", organizationId: ORG, propertyId: PROP, unitCode: "A-08-08", listingMode: "PARTITIONED",
    });
    listingStore.set("l-master", {
      id: "l-master", organizationId: ORG, apartmentId: "apt-1", listingType: "Master",
      listingStatus: "active", visibilityMode: "PUBLIC", occupancyStatus: "vacant",
      rentalRate: 1000, sourcingAgentId: AGENT,
    });
    submissionStore.set("s-amend", {
      id: "s-amend",
      organizationId: ORG,
      propertyId: PROP,
      unitCode: "A-08-08",
      listingType: "Master",
      listingMode: "PARTITIONED",
      parentListingId: "l-master",
      sourcingAgentId: AGENT,
      submissionState: "pending",
      submittedPayload: { listing: { rentalRate: 1500 } },
    });

    const r = await approveSubmissionService(adminSession, "s-amend");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.approvedListingId).toBe("l-master");
    expect(listingStore.get("l-master")!.rentalRate).toBe(1500);
    // No NEW apartment created
    expect(apartmentStore.size).toBe(1);
    // No NEW listing created
    expect(listingStore.size).toBe(1);

    const sub = submissionStore.get("s-amend")!;
    expect(sub.submissionState).toBe("approved");
    expect(sub.approvedListingId).toBe("l-master");
  });

  it("derives readyNow=true on approval so the listing is reservable immediately", async () => {
    // Regression: pre-fix the new Listing was created without readyNow, so
    // it landed at the DB default (false) and silently dropped out of the
    // agent reservation picker — see WhatsApp report 2026-05-20.
    submissionStore.set("s-rn", {
      id: "s-rn", organizationId: ORG, propertyId: PROP, parentListingId: null,
      unitCode: "B-12-3A", listingType: "Whole Unit", listingMode: "WHOLE",
      sourcingAgentId: AGENT, submissionState: "pending",
      submittedPayload: validPayload,
    });
    const r = await approveSubmissionService(adminSession, "s-rn");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const listing = listingStore.get(r.data.approvedListingId)!;
    expect(listing.readyNow).toBe(true);
  });

  it("derives readyNow=false when parent property is archived", async () => {
    propertyStore.set(PROP, { id: PROP, organizationId: ORG, status: "archived" });
    submissionStore.set("s-rn2", {
      id: "s-rn2", organizationId: ORG, propertyId: PROP, parentListingId: null,
      unitCode: "B-12-3A", listingType: "Whole Unit", listingMode: "WHOLE",
      sourcingAgentId: AGENT, submissionState: "pending",
      submittedPayload: validPayload,
    });
    const r = await approveSubmissionService(adminSession, "s-rn2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(listingStore.get(r.data.approvedListingId)!.readyNow).toBe(false);
  });

  it("returns 409 when approving a non-pending submission", async () => {
    submissionStore.set("s1", {
      id: "s1", organizationId: ORG, submissionState: "rejected", parentListingId: null,
      propertyId: PROP, unitCode: "A-08-08", listingType: "Master", listingMode: "PARTITIONED",
      sourcingAgentId: AGENT, submittedPayload: validPayload,
    });
    const r = await approveSubmissionService(adminSession, "s1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
  });
});

// -----------------------------------------------------------------------------

describe("setSubmissionNeedsAmendmentService + rejectSubmissionService + resubmit", () => {
  it("sends back a pending submission with a note", async () => {
    submissionStore.set("s1", {
      id: "s1", organizationId: ORG, sourcingAgentId: AGENT, submissionState: "pending",
    });
    const r = await setSubmissionNeedsAmendmentService(adminSession, "s1", "Please fix photos.");
    expect(r.ok).toBe(true);
    expect(submissionStore.get("s1")!.submissionState).toBe("needs_amendment");
    expect(submissionStore.get("s1")!.amendmentNote).toBe("Please fix photos.");
  });

  it("rejects a pending submission (terminal)", async () => {
    submissionStore.set("s1", {
      id: "s1", organizationId: ORG, sourcingAgentId: AGENT, submissionState: "pending",
    });
    const r = await rejectSubmissionService(adminSession, "s1", "Duplicate listing.");
    expect(r.ok).toBe(true);
    expect(submissionStore.get("s1")!.submissionState).toBe("rejected");
    expect(submissionStore.get("s1")!.amendmentNote).toBe("Duplicate listing.");
  });

  it("resubmits a needs_amendment submission with new payload, clearing the note", async () => {
    submissionStore.set("s1", {
      id: "s1",
      organizationId: ORG,
      sourcingAgentId: AGENT,
      submissionState: "needs_amendment",
      amendmentNote: "Photos blurry",
      submittedPayload: { listing: { rentalRate: 1000 } },
    });
    const r = await resubmitSubmissionService(agentSession, "s1", validPayload);
    expect(r.ok).toBe(true);
    const updated = submissionStore.get("s1")!;
    expect(updated.submissionState).toBe("pending");
    expect(updated.amendmentNote).toBeNull();
  });

  it("allows resubmitting a pending submission (agent fixing own typo before admin acts)", async () => {
    submissionStore.set("s1", {
      id: "s1", organizationId: ORG, sourcingAgentId: AGENT, submissionState: "pending",
      submittedPayload: { listing: {} },
    });
    const r = await resubmitSubmissionService(agentSession, "s1", validPayload);
    expect(r.ok).toBe(true);
    const updated = submissionStore.get("s1")!;
    expect(updated.submissionState).toBe("pending");
  });

  it("returns 409 when resubmitting a terminal submission (approved/rejected/withdrawn)", async () => {
    submissionStore.set("s1", {
      id: "s1", organizationId: ORG, sourcingAgentId: AGENT, submissionState: "approved",
      submittedPayload: { listing: {} },
    });
    const r = await resubmitSubmissionService(agentSession, "s1", validPayload);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
  });

  it("threads listingType + listingMode onto the submission row when the agent changes room type", async () => {
    submissionStore.set("s1", {
      id: "s1",
      organizationId: ORG,
      sourcingAgentId: AGENT,
      submissionState: "needs_amendment",
      amendmentNote: "Change Master to Small",
      listingType: "Master",
      listingMode: "PARTITIONED",
      submittedPayload: { listing: { rentalRate: 1000 } },
    });
    const r = await resubmitSubmissionService(agentSession, "s1", validPayload, {
      listingType: "Small",
      listingMode: "PARTITIONED",
    });
    expect(r.ok).toBe(true);
    const updated = submissionStore.get("s1")!;
    expect(updated.listingType).toBe("Small");
    expect(updated.listingMode).toBe("PARTITIONED");
  });
});
