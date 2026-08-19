import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@kason/db";
import { seedMeterBaseline, type SeedMeterArgs } from "../meter";
import type { ImportSession, RawTenantRow } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import * as auditLib from "../../../lib/audit";

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

function makeArgs(overrides: Partial<SeedMeterArgs> = {}): SeedMeterArgs {
  return {
    unitId: "unit-uuid-1",
    periodMonth: new Date("2026-05-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: latestReading === null → {created:false}, no creates, no audit
// ---------------------------------------------------------------------------

describe("seedMeterBaseline — null latestReading", () => {
  beforeEach(() => {
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("returns {created:false} and calls no tx methods when latestReading is null", async () => {
    const meterFindFirst = vi.fn();
    const meterCreate = vi.fn();
    const readingFindFirst = vi.fn();
    const readingCreate = vi.fn();

    const tx = {
      aircondMeter: { findFirst: meterFindFirst, create: meterCreate },
      meterReading: { findFirst: readingFindFirst, create: readingCreate },
    } as unknown as Prisma.TransactionClient;

    const result = await seedMeterBaseline(tx, makeSession(), makeRow({ latestReading: null }), makeArgs());

    expect(result).toEqual({ created: false });
    expect(meterFindFirst).not.toHaveBeenCalled();
    expect(meterCreate).not.toHaveBeenCalled();
    expect(readingFindFirst).not.toHaveBeenCalled();
    expect(readingCreate).not.toHaveBeenCalled();
    expect(vi.mocked(auditLib.recordAudit)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: New meter + new reading — all fields correct, audit fires once
// ---------------------------------------------------------------------------

describe("seedMeterBaseline — new meter + new reading", () => {
  const meterId = "meter-uuid-new";
  const readingId = "reading-uuid-new";

  beforeEach(() => {
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("creates meter, creates reading with previous===current===value, consumption 0, status submitted, submittedBy userId, and calls recordAudit once", async () => {
    const meterFindFirst = vi.fn().mockResolvedValue(null);
    const meterCreate = vi.fn().mockResolvedValue({ id: meterId });
    const readingFindFirst = vi.fn().mockResolvedValue(null);
    const readingCreate = vi.fn().mockResolvedValue({ id: readingId });

    const tx = {
      aircondMeter: { findFirst: meterFindFirst, create: meterCreate },
      meterReading: { findFirst: readingFindFirst, create: readingCreate },
    } as unknown as Prisma.TransactionClient;

    const session = makeSession();
    const row = makeRow({ latestReading: 5678 });
    const args = makeArgs();

    const result = await seedMeterBaseline(tx, session, row, args);

    expect(result).toEqual({ created: true });

    // meter.create was called
    expect(meterCreate).toHaveBeenCalledOnce();
    const meterData = (meterCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(meterData.organizationId).toBe("org-uuid-1");
    expect(meterData.unitId).toBe("unit-uuid-1");

    // reading.create was called with correct shape
    expect(readingCreate).toHaveBeenCalledOnce();
    const readingData = (readingCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(readingData.previousReading).toBe(5678);
    expect(readingData.currentReading).toBe(5678);
    expect(readingData.consumption).toBe(0);
    expect(readingData.computedAmount).toBe(0);
    expect(readingData.status).toBe("submitted");
    expect(readingData.submittedBy).toBe("user-uuid-1");
    expect(readingData.meterId).toBe(meterId);
    expect(readingData.organizationId).toBe("org-uuid-1");
    expect(readingData.unitId).toBe("unit-uuid-1");

    // recordAudit called once
    expect(vi.mocked(auditLib.recordAudit)).toHaveBeenCalledOnce();
    const auditArg = vi.mocked(auditLib.recordAudit).mock.calls[0][1];
    expect(auditArg.action).toBe("data-import.meter.seed");
    expect(auditArg.entityType).toBe("MeterReading");
    expect(auditArg.entityId).toBe(readingId);
    expect(auditArg.organizationId).toBe("org-uuid-1");
    expect(auditArg.actorUserId).toBe("user-uuid-1");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Existing meter → meter.create NOT called, reading still created
// ---------------------------------------------------------------------------

describe("seedMeterBaseline — existing meter, new reading", () => {
  const existingMeterId = "meter-uuid-existing";
  const readingId = "reading-uuid-3";

  beforeEach(() => {
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("does not call meter.create when meter already exists, but still creates the reading", async () => {
    const meterFindFirst = vi.fn().mockResolvedValue({ id: existingMeterId });
    const meterCreate = vi.fn();
    const readingFindFirst = vi.fn().mockResolvedValue(null);
    const readingCreate = vi.fn().mockResolvedValue({ id: readingId });

    const tx = {
      aircondMeter: { findFirst: meterFindFirst, create: meterCreate },
      meterReading: { findFirst: readingFindFirst, create: readingCreate },
    } as unknown as Prisma.TransactionClient;

    const result = await seedMeterBaseline(tx, makeSession(), makeRow({ latestReading: 999 }), makeArgs());

    expect(result).toEqual({ created: true });
    expect(meterCreate).not.toHaveBeenCalled();
    expect(readingCreate).toHaveBeenCalledOnce();

    // reading uses the existing meter's id
    const readingData = (readingCreate.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(readingData.meterId).toBe(existingMeterId);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Existing reading for the period → {created:false}, reading.create NOT called
// ---------------------------------------------------------------------------

describe("seedMeterBaseline — existing reading for period", () => {
  beforeEach(() => {
    vi.mocked(auditLib.recordAudit).mockClear();
  });

  it("returns {created:false} and does not call reading.create when reading already exists for the period", async () => {
    const meterFindFirst = vi.fn().mockResolvedValue({ id: "meter-uuid-existing" });
    const meterCreate = vi.fn();
    const readingFindFirst = vi.fn().mockResolvedValue({ id: "reading-uuid-existing" });
    const readingCreate = vi.fn();

    const tx = {
      aircondMeter: { findFirst: meterFindFirst, create: meterCreate },
      meterReading: { findFirst: readingFindFirst, create: readingCreate },
    } as unknown as Prisma.TransactionClient;

    const result = await seedMeterBaseline(tx, makeSession(), makeRow({ latestReading: 1234 }), makeArgs());

    expect(result).toEqual({ created: false });
    expect(readingCreate).not.toHaveBeenCalled();
    expect(vi.mocked(auditLib.recordAudit)).not.toHaveBeenCalled();
  });
});
