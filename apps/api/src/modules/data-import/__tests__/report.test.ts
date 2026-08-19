import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildReportCsv, uploadReport } from "../report";
import type { ReportRow } from "../types";
import type { Count } from "../parse/mapping";

// ---------------------------------------------------------------------------
// Mock storage so uploadReport never hits Supabase
// ---------------------------------------------------------------------------

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
}));

import * as storage from "../../../lib/storage";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    sheet: "Sheet1",
    row: 2,
    unitCode: "A-01",
    room: "Master",
    tenantMasked: "name#2",
    partyAction: "create",
    tenancyAction: "create",
    carparkAction: null,
    meterAction: null,
    conflict: null,
    notes: null,
    ...overrides,
  };
}

const AGENTS: Count[] = [
  { value: "Agen Lim", count: 3 },
  { value: "Broker Tan", count: 1 },
];

const ROOMS: Count[] = [
  { value: "Master Bilik", count: 5 },
  { value: "Small Room", count: 2 },
];

// ---------------------------------------------------------------------------
// buildReportCsv — header + body
// ---------------------------------------------------------------------------

describe("buildReportCsv — header", () => {
  it("output starts with the expected header line", () => {
    const csv = buildReportCsv([makeRow()], [], []);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toBe(
      "sheet,row,unitCode,room,tenant,partyAction,tenancyAction,carpark,meter,conflict,notes",
    );
  });
});

describe("buildReportCsv — data rows", () => {
  it("contains a data line for each row", () => {
    const rows = [makeRow({ row: 2, tenantMasked: "name#2" }), makeRow({ row: 3, tenantMasked: "name#3" })];
    const csv = buildReportCsv(rows, [], []);
    const lines = csv.split("\n");
    // line[0] is header; line[1] and line[2] are data rows
    expect(lines[1]).toContain("name#2");
    expect(lines[2]).toContain("name#3");
  });

  it("includes all fields in the correct order", () => {
    const row = makeRow({
      sheet: "Sheet2",
      row: 5,
      unitCode: "B-02",
      room: "Single",
      tenantMasked: "name#5",
      partyAction: "match",
      tenancyAction: "exists",
      carparkAction: "create",
      meterAction: "skip",
      conflict: "date-overlap",
      notes: "manual check",
    });
    const csv = buildReportCsv([row], [], []);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toBe(
      "Sheet2,5,B-02,Single,name#5,match,exists,create,skip,date-overlap,manual check",
    );
  });

  it("handles null optional fields as empty strings", () => {
    const row = makeRow({
      unitCode: null,
      room: null,
      carparkAction: null,
      meterAction: null,
      conflict: null,
      notes: null,
    });
    const csv = buildReportCsv([row], [], []);
    const dataLine = csv.split("\n")[1];
    // unitCode and room become empty; carpark, meter, conflict, notes also empty
    expect(dataLine).toMatch(/^Sheet1,2,,,name#2,create,create,,,,$/)
  });

  it("preserves tenantMasked as-is (masked reference, no raw PII)", () => {
    const row = makeRow({ row: 7, tenantMasked: "name#7" });
    const csv = buildReportCsv([row], [], []);
    expect(csv).toContain("name#7");
    // Verify no raw PII patterns appear (this is enforced by the fixture itself
    // using masked references — tests never pass raw IC/phone/full-name)
    expect(csv).not.toContain("880312101234"); // no IC
    expect(csv).not.toContain("0133456789");   // no phone
  });
});

// ---------------------------------------------------------------------------
// buildReportCsv — CSV injection / sanitization
// ---------------------------------------------------------------------------

describe("buildReportCsv — notes sanitization", () => {
  it("replaces commas in notes with spaces (no extra CSV columns)", () => {
    const row = makeRow({ notes: "check A, check B" });
    const csv = buildReportCsv([row], [], []);
    const dataLine = csv.split("\n")[1];
    const cols = dataLine.split(",");
    // Header has 11 columns; data row must also have 11 columns
    expect(cols).toHaveLength(11);
    expect(dataLine).toContain("check A  check B");
  });

  it("replaces newlines in notes with spaces", () => {
    const row = makeRow({ notes: "line one\nline two" });
    const csv = buildReportCsv([row], [], []);
    const dataLine = csv.split("\n")[1];
    const cols = dataLine.split(",");
    expect(cols).toHaveLength(11);
    // The \n in notes became a space, so the note field is "line one line two"
    expect(dataLine).toContain("line one line two");
  });
});

// ---------------------------------------------------------------------------
// buildReportCsv — review sections
// ---------------------------------------------------------------------------

describe("buildReportCsv — agent labels section", () => {
  it("contains the # AGENT LABELS section marker", () => {
    const csv = buildReportCsv([], AGENTS, []);
    expect(csv).toContain("# AGENT LABELS (raw,count) — review then map to canonical");
  });

  it("contains raw,count header under agent section", () => {
    const csv = buildReportCsv([], AGENTS, []);
    const lines = csv.split("\n");
    const markerIdx = lines.findIndex((l) => l.includes("# AGENT LABELS"));
    expect(markerIdx).toBeGreaterThan(-1);
    expect(lines[markerIdx + 1]).toBe("raw,count");
  });

  it("lists each agent count row", () => {
    const csv = buildReportCsv([], AGENTS, []);
    expect(csv).toContain("Agen Lim,3");
    expect(csv).toContain("Broker Tan,1");
  });
});

describe("buildReportCsv — room names section", () => {
  it("contains the # ROOM NAMES section marker", () => {
    const csv = buildReportCsv([], [], ROOMS);
    expect(csv).toContain("# ROOM NAMES (raw,count) — review then map to canonical");
  });

  it("contains raw,count header under room section", () => {
    const csv = buildReportCsv([], [], ROOMS);
    const lines = csv.split("\n");
    const markerIdx = lines.findIndex((l) => l.includes("# ROOM NAMES"));
    expect(markerIdx).toBeGreaterThan(-1);
    expect(lines[markerIdx + 1]).toBe("raw,count");
  });

  it("lists each room count row", () => {
    const csv = buildReportCsv([], [], ROOMS);
    expect(csv).toContain("Master Bilik,5");
    expect(csv).toContain("Small Room,2");
  });
});

describe("buildReportCsv — combined output", () => {
  it("agent section appears after data rows", () => {
    const csv = buildReportCsv([makeRow()], AGENTS, ROOMS);
    const lines = csv.split("\n");
    const dataLineIdx = lines.findIndex((l) => l.includes("name#2"));
    const agentIdx = lines.findIndex((l) => l.includes("# AGENT LABELS"));
    expect(agentIdx).toBeGreaterThan(dataLineIdx);
  });

  it("room section appears after agent section", () => {
    const csv = buildReportCsv([makeRow()], AGENTS, ROOMS);
    const lines = csv.split("\n");
    const agentIdx = lines.findIndex((l) => l.includes("# AGENT LABELS"));
    const roomIdx = lines.findIndex((l) => l.includes("# ROOM NAMES"));
    expect(roomIdx).toBeGreaterThan(agentIdx);
  });
});

// ---------------------------------------------------------------------------
// uploadReport
// ---------------------------------------------------------------------------

describe("uploadReport", () => {
  beforeEach(() => {
    vi.mocked(storage.putObject).mockClear();
  });

  it("returns the correct storage key", async () => {
    const key = await uploadReport("org-abc", "run-xyz", "csv content", "2026-06-15T10:00:00Z");
    expect(key).toBe("imports/org-abc/run-xyz/report-2026-06-15T10:00:00Z.csv");
  });

  it("calls putObject exactly once", async () => {
    await uploadReport("org-abc", "run-xyz", "csv content", "2026-06-15T10:00:00Z");
    expect(storage.putObject).toHaveBeenCalledOnce();
  });

  it("calls putObject with a Buffer and text/csv content-type", async () => {
    const csv = "sheet,row\nSheet1,2";
    await uploadReport("org-abc", "run-xyz", csv, "2026-06-15T10:00:00Z");
    const [, bodyArg, ctArg] = vi.mocked(storage.putObject).mock.calls[0];
    expect(Buffer.isBuffer(bodyArg)).toBe(true);
    expect(ctArg).toBe("text/csv");
  });

  it("Buffer contains the CSV content", async () => {
    const csv = "sheet,row\nSheet1,2";
    await uploadReport("org-abc", "run-xyz", csv, "2026-06-15T10:00:00Z");
    const [, bodyArg] = vi.mocked(storage.putObject).mock.calls[0];
    expect((bodyArg as Buffer).toString("utf-8")).toBe(csv);
  });

  it("storage key encodes orgId and importRunId correctly", async () => {
    const key = await uploadReport("myOrg", "run-001", "", "2026-01-01T00:00:00Z");
    expect(key).toMatch(/^imports\/myOrg\/run-001\/report-/);
  });
});
