import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";
import { ensureTenancy, type EnsureTenancyArgs } from "../tenancy";
import type { ImportSession, RawTenantRow } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../tenancy/tenancy-code-generator", () => ({
  generateTenancyCodeTx: vi.fn().mockResolvedValue("TEN-2026-0001"),
}));

vi.mock("../repository", () => ({
  findTenancyForRow: vi.fn(),
}));

import * as auditLib from "../../../lib/audit";
import * as repo from "../repository";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    orgId: "org-uuid-1",
    userId: "user-uuid-1",
    role: "admin",
    userType: "operator",
    ...overrides,
  };
}

function makeRow(overrides: Partial<RawTenantRow> = {}): RawTenantRow {
  return {
    sheet: "PV9 Tenant List",
    rowNumber: 3,
    propertyName: "PV9",
    unitCode: "A-01",
    roomName: "Room A",
    tenantNameRaw: "Lim Wei Ming",
    coTenantNames: [],
    rentalRoom: 1200,
    rentalCarpark: null,
    carparkCol: null,
    accessCardNo: "AC-001",
    numberOfPax: 2,
    idNumber: "900101101234",
    phoneRaw: "0123456789",
    email: "lim@example.com",
    gender: "male",
    moveIn: new Date("2024-01-01"),
    moveOut: null,
    termMonths: 12,
    agentLabel: "KENDRA(105)",
    latestReading: 1234,
    readingMonotonic: true,
    ...overrides,
  };
}

function makeArgs(overrides: Partial<EnsureTenancyArgs> = {}): EnsureTenancyArgs {
  return {
    partyId: "party-uuid-1",
    propertyId: "property-uuid-1",
    unitId: "unit-uuid-1",
    monthlyRent: 1200,
    now: new Date("2025-06-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: Existing tenancy — returns created:false, does NOT call tenancy.create
// ---------------------------------------------------------------------------

describe("ensureTenancy — existing tenancy", () => {
  beforeEach(() => {
    vi.mocked(repo.findTenancyForRow).mockResolvedValue({ id: "existing-tenancy-id" });
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("returns {created:false, tenancyId} and does not call tenancy.create", async () => {
    const tenancyCreate = vi.fn();
    const tx = {
      tenancy: { create: tenancyCreate, findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as Prisma.TransactionClient;

    const result = await ensureTenancy(tx, makeSession(), makeRow(), makeArgs());

    expect(result.created).toBe(false);
    expect(result.tenancyId).toBe("existing-tenancy-id");
    expect(tenancyCreate).not.toHaveBeenCalled();
    expect(vi.mocked(auditLib.recordAudit)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: New ROOM tenancy — all room fields set, co-tenant in notes, audit fires
// ---------------------------------------------------------------------------

describe("ensureTenancy — new room tenancy", () => {
  const newTenancyId = "new-tenancy-id";

  beforeEach(() => {
    vi.mocked(repo.findTenancyForRow).mockResolvedValue(null);
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("calls tenancy.create with numberOfPax/agentLabel/accessCardNo populated from row", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const row = makeRow({ coTenantNames: [], numberOfPax: 2, agentLabel: "KENDRA(105)", accessCardNo: "AC-001" });
    const args = makeArgs();
    await ensureTenancy(tx, makeSession(), row, args);

    expect(tenancyCreate).toHaveBeenCalledOnce();
    const data = (tenancyCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.numberOfPax).toBe(2);
    expect(data.agentLabel).toBe("KENDRA(105)");
    expect(data.accessCardNo).toBe("AC-001");
  });

  it("sets status 'active' when moveOut is null", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const row = makeRow({ moveOut: null });
    await ensureTenancy(tx, makeSession(), row, makeArgs());

    const data = (tenancyCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.status).toBe("active");
  });

  it("includes co-tenant names in moveInNotes when coTenantNames is non-empty", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const row = makeRow({ coTenantNames: ["Tan Ah Kow", "Wong Mei Ling"] });
    await ensureTenancy(tx, makeSession(), row, makeArgs());

    const data = (tenancyCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.moveInNotes).toContain("Tan Ah Kow");
    expect(data.moveInNotes).toContain("Wong Mei Ling");
    expect(data.moveInNotes).toContain("Import co-tenants");
  });

  it("sets moveInNotes to null when coTenantNames is empty", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const row = makeRow({ coTenantNames: [] });
    await ensureTenancy(tx, makeSession(), row, makeArgs());

    const data = (tenancyCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.moveInNotes).toBeNull();
  });

  it("calls recordAudit once with action data-import.tenancy.create", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    await ensureTenancy(tx, makeSession(), makeRow(), makeArgs());

    expect(vi.mocked(auditLib.recordAudit)).toHaveBeenCalledOnce();
    const auditArg = vi.mocked(auditLib.recordAudit).mock.calls[0][1];
    expect(auditArg.action).toBe("data-import.tenancy.create");
    expect(auditArg.entityType).toBe("Tenancy");
    expect(auditArg.entityId).toBe(newTenancyId);
    expect(auditArg.organizationId).toBe("org-uuid-1");
    // kind field removed — not present in audit meta
    expect((auditArg.meta as Record<string, unknown>)).not.toHaveProperty("kind");
  });

  it("returns {created:true, tenancyId}", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const result = await ensureTenancy(tx, makeSession(), makeRow(), makeArgs());

    expect(result.created).toBe(true);
    expect(result.tenancyId).toBe(newTenancyId);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Status "ended" when moveOut is in the past
// ---------------------------------------------------------------------------

describe("ensureTenancy — status ended", () => {
  const newTenancyId = "ended-tenancy-id";

  beforeEach(() => {
    vi.mocked(repo.findTenancyForRow).mockResolvedValue(null);
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("sets status 'ended' when moveOut is before now", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    // moveOut is 2024-01-01, now is 2025-06-01 — clearly in the past
    const row = makeRow({ moveOut: new Date("2024-01-01") });
    const args = makeArgs({ now: new Date("2025-06-01") });
    await ensureTenancy(tx, makeSession(), row, args);

    const data = (tenancyCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.status).toBe("ended");
  });

  it("sets status 'active' when moveOut equals now", async () => {
    const tenancyCreate = vi.fn().mockResolvedValue({ id: newTenancyId });
    const auditLogCreate = vi.fn().mockResolvedValue({});
    const tenancyFindMany = vi.fn().mockResolvedValue([]);

    const tx = {
      tenancy: { create: tenancyCreate, findMany: tenancyFindMany },
      auditLog: { create: auditLogCreate },
    } as unknown as Prisma.TransactionClient;

    const now = new Date("2025-06-01");
    const row = makeRow({ moveOut: new Date("2025-06-01") });
    const args = makeArgs({ now });
    await ensureTenancy(tx, makeSession(), row, args);

    const data = (tenancyCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data.status).toBe("active");
  });
});
