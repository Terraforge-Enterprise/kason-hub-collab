import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImportSession, RawTenantRow } from "../types";
import type { PartyPlan } from "../match";

// ---------------------------------------------------------------------------
// Synthetic fixtures — three rows: plain room, room+carpark, missing unitCode.
// ---------------------------------------------------------------------------

function makeRow(over: Partial<RawTenantRow>): RawTenantRow {
  return {
    sheet: "PV9 Tenant List",
    rowNumber: 2,
    propertyName: "PV9",
    unitCode: "B-08-08",
    roomName: "Master",
    tenantNameRaw: "Alice Tan",
    coTenantNames: [],
    rentalRoom: 1200,
    rentalCarpark: null,
    carparkCol: null,
    accessCardNo: null,
    numberOfPax: 1,
    idNumber: "900101-01-1234",
    phoneRaw: "012-3456789",
    email: "alice@example.com",
    gender: "female",
    moveIn: new Date("2025-01-01T00:00:00Z"),
    moveOut: null,
    termMonths: 12,
    agentLabel: "Agent A",
    latestReading: 1000,
    readingMonotonic: true,
    ...over,
  };
}

const ROW_PLAIN = makeRow({ rowNumber: 2, unitCode: "B-08-08" });
const ROW_CARPARK = makeRow({
  rowNumber: 3,
  unitCode: "B-09-09",
  tenantNameRaw: "Bob Lee",
  rentalCarpark: 100,
  latestReading: null,
});
const ROW_MISSING = makeRow({
  rowNumber: 4,
  unitCode: null,
  tenantNameRaw: "Carol Ng",
});

const SYNTHETIC_ROWS: RawTenantRow[] = [ROW_PLAIN, ROW_CARPARK, ROW_MISSING];

// ---------------------------------------------------------------------------
// Module mocks — every sibling writer + the workbook reader are mocked so the
// unit test exercises the orchestration logic only.
// ---------------------------------------------------------------------------

vi.mock("exceljs", () => ({
  default: {
    Workbook: class {
      xlsx = { readFile: async (): Promise<void> => undefined };
    },
  },
}));

vi.mock("../parse/sheet", () => ({
  parseWorkbook: vi.fn(() => SYNTHETIC_ROWS),
}));

vi.mock("../parse/mapping", async () => {
  const actual = await vi.importActual<typeof import("../parse/mapping")>("../parse/mapping");
  return {
    ...actual,
    distinctCounts: vi.fn(() => []),
  };
});

vi.mock("../match", () => ({
  planParty: vi.fn(),
  executePartyPlan: vi.fn(),
}));

vi.mock("../inventory-resolver", () => ({
  ensureProperty: vi.fn(),
  ensureRoomListing: vi.fn(),
  ensureCarpark: vi.fn(),
}));

vi.mock("../carpark-import", () => ({
  ensureCarparkAssignment: vi.fn(),
}));

vi.mock("../tenancy", () => ({
  ensureTenancy: vi.fn(),
}));

vi.mock("../meter", () => ({
  seedMeterBaseline: vi.fn(),
}));

vi.mock("../report", () => ({
  buildReportCsv: vi.fn(() => "csv-body"),
  uploadReport: vi.fn(async () => "imports/org-1/run-1/report.csv"),
}));

vi.mock("../repository", () => ({
  createImportRun: vi.fn(async () => ({ id: "run-1" })),
  finishImportRun: vi.fn(async () => undefined),
  listImportRuns: vi.fn(),
  getImportRun: vi.fn(),
}));

vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async () => "https://signed.example/report.csv"),
}));

// getDb mock: $transaction calls the callback with a fake tx object.
const fakeTx = {};
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => ({
    $transaction: vi.fn(async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx)),
  })),
  Prisma: {},
}));

// ---------------------------------------------------------------------------
// Import after mocks.
// ---------------------------------------------------------------------------

import {
  runImport,
  listRunsService,
  getRunService,
} from "../service";
import * as match from "../match";
import * as inventory from "../inventory-resolver";
import * as carparkImport from "../carpark-import";
import * as tenancy from "../tenancy";
import * as meter from "../meter";
import * as report from "../report";
import * as repository from "../repository";
import * as storage from "../../../lib/storage";

const SESSION: ImportSession = {
  orgId: "org-1",
  userId: "user-1",
  role: "admin",
  userType: "operator",
};

const PLAN_CREATE: PartyPlan = {
  action: "create",
  data: {
    organizationId: "org-1",
    partyType: "tenant",
    displayName: "Alice Tan",
    status: "active",
    primaryPhone: "+60123456789",
    primaryEmail: "alice@example.com",
    idType: "nric",
    idNumber: "900101-01-1234",
    gender: "female",
  },
};

const NOW = new Date("2026-06-15T00:00:00Z");

// ---------------------------------------------------------------------------

describe("runImport — dry-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(match.planParty).mockResolvedValue(PLAN_CREATE);
    vi.mocked(report.buildReportCsv).mockReturnValue("csv-body");
    vi.mocked(report.uploadReport).mockResolvedValue("imports/org-1/run-1/report.csv");
    vi.mocked(repository.createImportRun).mockResolvedValue({ id: "run-1" });
  });

  it("plans without calling any writer; uploads report; finalizes ledger", async () => {
    const res = await runImport(SESSION, { dryRun: true, filePath: "x.xlsx", now: NOW });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // createImportRun called with dryRun=true.
    expect(repository.createImportRun).toHaveBeenCalledOnce();
    const [orgId, dryRun] = vi.mocked(repository.createImportRun).mock.calls[0];
    expect(orgId).toBe("org-1");
    expect(dryRun).toBe(true);

    // planParty called for the two valid rows (not the missing-unit row).
    expect(match.planParty).toHaveBeenCalledTimes(2);

    // NO writers ran in dry-run.
    expect(match.executePartyPlan).not.toHaveBeenCalled();
    expect(inventory.ensureProperty).not.toHaveBeenCalled();
    expect(inventory.ensureRoomListing).not.toHaveBeenCalled();
    expect(inventory.ensureCarpark).not.toHaveBeenCalled();
    expect(carparkImport.ensureCarparkAssignment).not.toHaveBeenCalled();
    expect(tenancy.ensureTenancy).not.toHaveBeenCalled();
    expect(meter.seedMeterBaseline).not.toHaveBeenCalled();

    // Report built + uploaded; ledger finalized completed.
    expect(report.buildReportCsv).toHaveBeenCalledOnce();
    expect(report.uploadReport).toHaveBeenCalledOnce();
    expect(repository.finishImportRun).toHaveBeenCalledOnce();
    const finishArg = vi.mocked(repository.finishImportRun).mock.calls[0][1];
    expect(finishArg.status).toBe("completed");

    // Counts: all 3 parsed; missing-unit row skipped.
    expect(res.data.counts.rowsParsed).toBe(3);
    expect(res.data.counts.rowsSkipped).toBe(1);
    expect(res.data.reportKey).toBe("imports/org-1/run-1/report.csv");
  });

  it("counts party create and tenancy create per valid row in dry-run", async () => {
    const res = await runImport(SESSION, { dryRun: true, now: NOW });
    if (!res.ok) throw new Error("expected ok");
    // Two valid rows → two party creates.
    expect(res.data.counts.partiesCreated).toBe(2);
    // ROW_PLAIN room + ROW_CARPARK room + ROW_CARPARK carpark = 3 tenancy creates.
    expect(res.data.counts.tenanciesCreated).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("runImport — commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(match.planParty).mockResolvedValue(PLAN_CREATE);
    vi.mocked(match.executePartyPlan).mockResolvedValue("party-1");
    vi.mocked(inventory.ensureProperty).mockResolvedValue("prop-1");
    vi.mocked(inventory.ensureRoomListing).mockResolvedValue({ id: "room-1", created: true });
    vi.mocked(inventory.ensureCarpark).mockResolvedValue({ id: "cp-1", created: true });
    vi.mocked(carparkImport.ensureCarparkAssignment).mockResolvedValue({ created: true, assignmentId: "ca-1" });
    vi.mocked(tenancy.ensureTenancy).mockResolvedValue({ created: true, tenancyId: "t-1" });
    vi.mocked(meter.seedMeterBaseline).mockResolvedValue({ created: true });
    vi.mocked(report.buildReportCsv).mockReturnValue("csv-body");
    vi.mocked(report.uploadReport).mockResolvedValue("imports/org-1/run-1/report.csv");
    vi.mocked(repository.createImportRun).mockResolvedValue({ id: "run-1" });
  });

  it("wires inventory + party + tenancy + meter for valid rows", async () => {
    const res = await runImport(SESSION, { dryRun: false, filePath: "x.xlsx", now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // createImportRun called with dryRun=false.
    const [, dryRun] = vi.mocked(repository.createImportRun).mock.calls[0];
    expect(dryRun).toBe(false);

    // ensureProperty + ensureRoomListing called for the two valid rows.
    expect(inventory.ensureProperty).toHaveBeenCalledTimes(2);
    expect(inventory.ensureRoomListing).toHaveBeenCalledTimes(2);

    // Writers ran inside the tx.
    expect(match.executePartyPlan).toHaveBeenCalledTimes(2);
    expect(meter.seedMeterBaseline).toHaveBeenCalled();

    // Carpark row triggered ensureCarpark (bay) + ensureCarparkAssignment (link to room tenancy).
    expect(inventory.ensureCarpark).toHaveBeenCalledOnce();
    expect(carparkImport.ensureCarparkAssignment).toHaveBeenCalledOnce();

    // All ensureTenancy calls are room-only (no more carpark tenancy).
    expect(tenancy.ensureTenancy).toHaveBeenCalledTimes(2); // 2 valid rows → 2 room tenancies

    // ensureCarparkAssignment is called with the room tenancy id returned by ensureTenancy.
    const assignCall = vi.mocked(carparkImport.ensureCarparkAssignment).mock.calls[0];
    expect(assignCall[2]).toBe("cp-1");   // carparkId
    expect(assignCall[3]).toBe("t-1");    // tenancyId (from ensureTenancy return)
    expect(assignCall[4]).toBe(100);      // monthlyCharge = ROW_CARPARK.rentalCarpark

    // Counts reflect creates: 2 parties, 3 tenancy-equivalent creates (2 room + 1 carpark-assign).
    expect(res.data.counts.partiesCreated).toBe(2);
    expect(res.data.counts.tenanciesCreated).toBe(3);
    expect(res.data.counts.rowsSkipped).toBe(1);

    // Ledger finalized.
    expect(repository.finishImportRun).toHaveBeenCalledOnce();
    expect(vi.mocked(repository.finishImportRun).mock.calls[0][1].status).toBe("completed");
  });

  it("seedMeterBaseline is invoked once per valid committed row (writer self-gates on latestReading)", async () => {
    await runImport(SESSION, { dryRun: false, now: NOW });
    // Orchestrator calls seedMeterBaseline for both valid rows inside the tx;
    // the writer itself returns {created:false} when latestReading is null.
    expect(meter.seedMeterBaseline).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------

describe("runImport — error isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(match.planParty).mockResolvedValue(PLAN_CREATE);
    vi.mocked(match.executePartyPlan).mockResolvedValue("party-1");
    vi.mocked(inventory.ensureRoomListing).mockResolvedValue({ id: "room-1", created: true });
    vi.mocked(inventory.ensureCarpark).mockResolvedValue({ id: "cp-1", created: true });
    vi.mocked(carparkImport.ensureCarparkAssignment).mockResolvedValue({ created: true, assignmentId: "ca-1" });
    vi.mocked(tenancy.ensureTenancy).mockResolvedValue({ created: true, tenancyId: "t-1" });
    vi.mocked(meter.seedMeterBaseline).mockResolvedValue({ created: true });
    vi.mocked(report.buildReportCsv).mockReturnValue("csv-body");
    vi.mocked(report.uploadReport).mockResolvedValue("imports/org-1/run-1/report.csv");
    vi.mocked(repository.createImportRun).mockResolvedValue({ id: "run-1" });
  });

  it("a throwing row is counted as a conflict and the loop continues", async () => {
    // ensureProperty throws for the first valid row, succeeds for the second.
    vi.mocked(inventory.ensureProperty)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("prop-1");

    const res = await runImport(SESSION, { dryRun: false, now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // One row threw → one conflict; loop still processed the second valid row.
    expect(res.data.counts.conflicts).toBe(1);
    expect(inventory.ensureProperty).toHaveBeenCalledTimes(2);
    // The surviving valid row still created a party.
    expect(match.executePartyPlan).toHaveBeenCalledTimes(1);

    // Ledger still finalized.
    expect(repository.finishImportRun).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------

describe("runImport — workbook read failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when parseWorkbook throws", async () => {
    const sheet = await import("../parse/sheet");
    vi.mocked(sheet.parseWorkbook).mockImplementationOnce(() => {
      throw new Error("bad sheet");
    });

    const res = await runImport(SESSION, { dryRun: true, now: NOW });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.status).toBe(400);
    expect(res.error).toContain("failed to read workbook");
    // No ledger created on a read failure.
    expect(repository.createImportRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("listRunsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns org-scoped runs", async () => {
    vi.mocked(repository.listImportRuns).mockResolvedValue([{ id: "run-1" }] as never);
    const res = await listRunsService(SESSION, 10);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(repository.listImportRuns).toHaveBeenCalledWith("org-1", 10);
    expect(res.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("getRunService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when run not found", async () => {
    vi.mocked(repository.getImportRun).mockResolvedValue(null);
    const res = await getRunService(SESSION, "missing");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.status).toBe(404);
  });

  it("attaches a signed reportUrl when reportKey is present", async () => {
    vi.mocked(repository.getImportRun).mockResolvedValue({
      id: "run-1",
      reportKey: "imports/org-1/run-1/report.csv",
    } as never);
    vi.mocked(storage.createSignedDownloadUrl).mockResolvedValue("https://signed/report.csv");

    const res = await getRunService(SESSION, "run-1");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect((res.data as { reportUrl: string | null }).reportUrl).toBe("https://signed/report.csv");
  });

  it("reportUrl is null when reportKey absent", async () => {
    vi.mocked(repository.getImportRun).mockResolvedValue({ id: "run-1", reportKey: null } as never);
    const res = await getRunService(SESSION, "run-1");
    if (!res.ok) throw new Error("expected ok");
    expect((res.data as { reportUrl: string | null }).reportUrl).toBeNull();
    expect(storage.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("reportUrl is null (best-effort) when signing throws", async () => {
    vi.mocked(repository.getImportRun).mockResolvedValue({
      id: "run-1",
      reportKey: "imports/org-1/run-1/report.csv",
    } as never);
    vi.mocked(storage.createSignedDownloadUrl).mockRejectedValue(new Error("sign fail"));

    const res = await getRunService(SESSION, "run-1");
    if (!res.ok) throw new Error("expected ok");
    expect((res.data as { reportUrl: string | null }).reportUrl).toBeNull();
  });
});
