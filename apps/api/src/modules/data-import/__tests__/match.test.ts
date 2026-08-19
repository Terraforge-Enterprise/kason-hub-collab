import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";
import { planParty, executePartyPlan, type PartyPlan } from "../match";
import * as auditLib from "../../../lib/audit";
import type { RawTenantRow } from "../types";

// Mock the audit module so recordAudit never hits the DB
vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

// Mock repository so findPartyByNaturalKey never hits the DB
vi.mock("../repository", () => ({
  findPartyByNaturalKey: vi.fn(),
}));

import * as repo from "../repository";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<RawTenantRow> = {}): RawTenantRow {
  return {
    sheet: "Sheet1",
    rowNumber: 2,
    propertyName: "Sunrise Residency",
    unitCode: "A-01",
    roomName: null,
    tenantNameRaw: "Ahmad bin Ali",
    coTenantNames: [],
    rentalRoom: 1200,
    rentalCarpark: null,
    carparkCol: null,
    accessCardNo: null,
    numberOfPax: 1,
    idNumber: "880312101234",
    phoneRaw: "0133456789",
    email: "ahmad@example.com",
    gender: "male",
    moveIn: new Date("2024-01-01"),
    moveOut: new Date("2025-01-01"),
    termMonths: 12,
    agentLabel: null,
    latestReading: null,
    readingMonotonic: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// planParty — no existing match → create plan
// ---------------------------------------------------------------------------

describe("planParty — no existing match", () => {
  beforeEach(() => {
    vi.mocked(repo.findPartyByNaturalKey).mockResolvedValue(null);
  });

  it("returns action:create with normalized phone and partyType tenant", async () => {
    const tx = {} as unknown as Prisma.TransactionClient;
    const result = await planParty(tx, "org1", makeRow());

    expect(result.action).toBe("create");
    if (result.action !== "create") return; // narrow type

    expect(result.data.primaryPhone).toBe("60133456789");
    expect(result.data.partyType).toBe("tenant");
    expect(result.data.organizationId).toBe("org1");
    expect(result.data.status).toBe("active");
    expect(result.data.displayName).toBe("Ahmad bin Ali");
  });

  it("returns idType NRIC for a 12-digit IC number", async () => {
    const tx = {} as unknown as Prisma.TransactionClient;
    const result = await planParty(tx, "org1", makeRow({ idNumber: "880312101234" }));

    expect(result.action).toBe("create");
    if (result.action !== "create") return;

    expect(result.data.idType).toBe("NRIC");
    expect(result.data.idNumber).toBe("880312101234");
  });
});

// ---------------------------------------------------------------------------
// planParty — existing party found → match plan with diff
// ---------------------------------------------------------------------------

describe("planParty — existing party match", () => {
  const existingPartyId = "party-uuid-existing";
  const oldPhone = "60123456789";

  beforeEach(() => {
    vi.mocked(repo.findPartyByNaturalKey).mockResolvedValue({
      id: existingPartyId,
      displayName: "Ahmad bin Ali",
      primaryPhone: oldPhone,
      idNumber: "880312101234",
    });
  });

  it("returns action:match with the existing partyId", async () => {
    // Row has a DIFFERENT phone than what's stored → diff should surface it
    const tx = {} as unknown as Prisma.TransactionClient;
    const result = await planParty(tx, "org1", makeRow({ phoneRaw: "0133456789" }));

    expect(result.action).toBe("match");
    if (result.action !== "match") return;

    expect(result.partyId).toBe(existingPartyId);
  });

  it("reports diff.primaryPhone as [oldPhone, newNormalizedPhone] — never overwrites", async () => {
    const tx = {} as unknown as Prisma.TransactionClient;
    // "0133456789" normalizes to "60133456789" which differs from stored "60123456789"
    const result = await planParty(tx, "org1", makeRow({ phoneRaw: "0133456789" }));

    expect(result.action).toBe("match");
    if (result.action !== "match") return;

    expect(result.diff.primaryPhone).toEqual([oldPhone, "60133456789"]);
  });

  it("returns empty diff when incoming phone matches stored phone", async () => {
    // Existing phone is "60123456789"; pass "0123456789" which normalizes identically
    vi.mocked(repo.findPartyByNaturalKey).mockResolvedValue({
      id: existingPartyId,
      displayName: "Ahmad bin Ali",
      primaryPhone: "60133456789",
      idNumber: "880312101234",
    });
    const tx = {} as unknown as Prisma.TransactionClient;
    const result = await planParty(tx, "org1", makeRow({ phoneRaw: "0133456789" }));

    expect(result.action).toBe("match");
    if (result.action !== "match") return;

    expect(result.diff).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// planParty — skip when tenantNameRaw is null
// ---------------------------------------------------------------------------

describe("planParty — skip on missing name", () => {
  it("returns action:skip when tenantNameRaw is null", async () => {
    const tx = {} as unknown as Prisma.TransactionClient;
    const result = await planParty(tx, "org1", makeRow({ tenantNameRaw: null }));

    expect(result.action).toBe("skip");
    if (result.action !== "skip") return;

    expect(result.reason).toMatch(/no tenant name/i);
  });
});

// ---------------------------------------------------------------------------
// executePartyPlan — create plan
// ---------------------------------------------------------------------------

describe("executePartyPlan — create", () => {
  beforeEach(() => {
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("calls tx.party.create once and recordAudit once, returns new id", async () => {
    const newId = "new-party-id";
    const partyCreate = vi.fn().mockResolvedValue({ id: newId });
    const auditLogCreate = vi.fn().mockResolvedValue({});

    const tx = {
      party: { create: partyCreate },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const plan: PartyPlan = {
      action: "create",
      data: {
        organizationId: "org1",
        partyType: "tenant",
        displayName: "Ahmad bin Ali",
        status: "active",
        primaryPhone: "60133456789",
        primaryEmail: "ahmad@example.com",
        idType: "NRIC",
        idNumber: "880312101234",
        gender: "male",
      },
    };

    const actor = { orgId: "org1", userId: "user1", role: "admin" };
    const result = await executePartyPlan(tx, actor, plan);

    expect(result).toBe(newId);
    expect(partyCreate).toHaveBeenCalledOnce();
    expect(vi.mocked(auditLib.recordAudit)).toHaveBeenCalledOnce();

    const auditCall = vi.mocked(auditLib.recordAudit).mock.calls[0];
    expect(auditCall[1].action).toBe("data-import.party.create");
    expect(auditCall[1].entityType).toBe("Party");
    expect(auditCall[1].entityId).toBe(newId);
    expect(auditCall[1].organizationId).toBe("org1");
  });
});

// ---------------------------------------------------------------------------
// executePartyPlan — match plan
// ---------------------------------------------------------------------------

describe("executePartyPlan — match", () => {
  beforeEach(() => {
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("returns partyId and does NOT call tx.party.create or recordAudit", async () => {
    const partyCreate = vi.fn();
    const tx = {
      party: { create: partyCreate },
    } as unknown as Prisma.TransactionClient;

    const plan: PartyPlan = {
      action: "match",
      partyId: "existing-party-id",
      diff: {},
    };

    const actor = { orgId: "org1", userId: "user1", role: "admin" };
    const result = await executePartyPlan(tx, actor, plan);

    expect(result).toBe("existing-party-id");
    expect(partyCreate).not.toHaveBeenCalled();
    expect(vi.mocked(auditLib.recordAudit)).not.toHaveBeenCalled();
  });
});
