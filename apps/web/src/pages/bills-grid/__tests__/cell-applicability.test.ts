// Regression cover for the 2026-08-14 fix: the Unit setting drawer's TNB/AIR
// "Owner | Tenant" toggle was INERT in the grid.
//
// `bd80276a` (2026-07-27) narrowed the drawer's TNB/AIR choices to
// Owner → "absorbed" / Tenant → "recharged" and called itself "presentation only".
// It never touched `isApplicable`, which still split AIR's Owner/Tenant columns on
// `airPattern === "tenant_direct"` — a value the drawer can no longer produce. So
// BOTH new choices landed on the Owner side and the Tenant column was permanently
// blank: "I make it tenant, but it still displays owner."
import { describe, expect, it } from "vitest";
import type { GridRow, GridEntryDto, GridBearerConfigDto } from "@/api/bills-grid";
import { isApplicable, isUtilityTenantBorne } from "../cell-applicability";

function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return {
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "100.00",
    isLocked: false,
    ...partial,
  };
}

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null,
    tnbTotal: null,
    airSelangor: null,
    wifi: null,
    maintenanceFee: null,
    readingDate: null,
    paymentStatus: "unpaid",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    updatedAt: "2026-08-14T00:00:00.000Z",
    lockState: "draft",
    ...partial,
  };
}

function makeRow(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1",
    unitCode: "PV9 A-13-13",
    propertyId: "PROP1",
    propertyName: "Sunway Vista",
    entryId: null,
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: null,
    bearerConfig: makeBearerConfig(),
    expenses: {
      tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
      owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
    },
    attachments: [],
    isWholeUnit: false,
    ...partial,
  };
}

describe("isUtilityTenantBorne — the ONE reading of a utilityPattern", () => {
  // Every consumer (column applicability, the TNB marker, the xlsx export) asks this
  // one function. Four literals agreeing by hand is exactly how the AIR columns drifted
  // away from the drawer in the first place.
  it('"absorbed" (drawer: Owner) is owner-borne', () => {
    expect(isUtilityTenantBorne("absorbed")).toBe(false);
  });

  it('"recharged" (drawer: Tenant) is tenant-borne', () => {
    expect(isUtilityTenantBorne("recharged")).toBe(true);
  });

  it('legacy "manager_advanced" is tenant-borne — KAEN fronted it and recovers it from the tenant pool', () => {
    expect(isUtilityTenantBorne("manager_advanced")).toBe(true);
  });

  it('legacy "tenant_direct" is tenant-side — the tenant settles with the provider themselves', () => {
    expect(isUtilityTenantBorne("tenant_direct")).toBe(true);
  });

  it("an unrecognised value falls to OWNER — the recoverable direction", () => {
    // An unexpected tenant charge gets spotted and flipped; a silently-absent one is
    // noticed months later. Same reasoning as bearerDefaultsFor's WHOLE fallback.
    expect(isUtilityTenantBorne("something_new")).toBe(false);
  });
});

describe("Cleaning / WiFi — the toggle that already worked (control group)", () => {
  it("owner-borne cleaning lights the Owner column only", () => {
    const row = makeRow({ bearerConfig: makeBearerConfig({ cleaningBearer: "owner" }) });
    expect(isApplicable(row, "cleaningOwner")).toBe(true);
    expect(isApplicable(row, "cleaningTenant")).toBe(false);
  });

  it("tenant-borne cleaning MOVES to the Tenant column", () => {
    const row = makeRow({ bearerConfig: makeBearerConfig({ cleaningBearer: "tenant" }) });
    expect(isApplicable(row, "cleaningOwner")).toBe(false);
    expect(isApplicable(row, "cleaningTenant")).toBe(true);
  });

  it("tenant-borne WiFi MOVES to the Tenant column", () => {
    const row = makeRow({ bearerConfig: makeBearerConfig({ wifiBearer: "tenant" }) });
    expect(isApplicable(row, "wifiOwner")).toBe(false);
    expect(isApplicable(row, "wifiTenant")).toBe(true);
  });
});

describe("AIR — the drawer's Owner/Tenant toggle drives its two existing columns", () => {
  it('Owner ("absorbed") lights the Owner column only', () => {
    const row = makeRow({ bearerConfig: makeBearerConfig({ airPattern: "absorbed" }) });
    expect(isApplicable(row, "airOwner")).toBe(true);
    expect(isApplicable(row, "airTenant")).toBe(false);
  });

  it('Tenant ("recharged") MOVES to the Tenant column — the 2026-08-14 regression', () => {
    const row = makeRow({ bearerConfig: makeBearerConfig({ airPattern: "recharged" }) });
    expect(isApplicable(row, "airOwner")).toBe(false);
    expect(isApplicable(row, "airTenant")).toBe(true);
  });

  it("the entry snapshot drives it once a month has been opened", () => {
    const row = makeRow({
      entry: makeEntry({ airPattern: "recharged" }),
      bearerConfig: makeBearerConfig({ airPattern: "absorbed" }),
    });
    // The OPENED month keeps what it was opened under — the config is only the seed.
    expect(isApplicable(row, "airOwner")).toBe(false);
    expect(isApplicable(row, "airTenant")).toBe(true);
  });

  it('legacy "tenant_direct" still records on the Tenant side (money guard)', () => {
    // unbillable-amounts.ts depends on this cell staying reachable so a
    // tenant-pays-directly amount can be RECORDED and then warned about at Bill time.
    const row = makeRow({ bearerConfig: makeBearerConfig({ airPattern: "tenant_direct" }) });
    expect(isApplicable(row, "airOwner")).toBe(false);
    expect(isApplicable(row, "airTenant")).toBe(true);
  });

  it("exactly ONE side is ever applicable, for every pattern value", () => {
    // The invariant that makes the pair a switch rather than two independent cells.
    for (const airPattern of ["absorbed", "recharged", "tenant_direct", "manager_advanced", "junk"]) {
      const row = makeRow({ bearerConfig: makeBearerConfig({ airPattern }) });
      expect(
        [isApplicable(row, "airOwner"), isApplicable(row, "airTenant")].filter(Boolean),
        `airPattern=${airPattern}`,
      ).toHaveLength(1);
    }
  });
});

describe("TNB — bearer selects exactly one Owner/Tenant column", () => {
  it("shows Owner for absorbed and Tenant for recharged/manager advanced", () => {
    for (const [tnbPattern, expected] of [
      ["absorbed", [true, false]],
      ["recharged", [false, true]],
      ["manager_advanced", [false, true]],
    ] as const) {
      const row = makeRow({ bearerConfig: makeBearerConfig({ tnbPattern }) });
      expect([isApplicable(row, "tnbOwner"), isApplicable(row, "tnbTenant")], `tnbPattern=${tnbPattern}`).toEqual(expected);
    }
  });

  it('"tenant_direct" still greys the cell — the Bill discards anything typed there', () => {
    const row = makeRow({ bearerConfig: makeBearerConfig({ tnbPattern: "tenant_direct" }) });
    expect(isApplicable(row, "tnbOwner")).toBe(false);
    expect(isApplicable(row, "tnbTenant")).toBe(false);
  });
});

describe("a stale entry snapshot outranks a freshly saved config", () => {
  it("cleaning: config says tenant, the already-opened month's snapshot still says owner", () => {
    const row = makeRow({
      entry: makeEntry({ cleaningBearer: "owner" }),
      bearerConfig: makeBearerConfig({ cleaningBearer: "tenant" }),
    });
    // Documents the precedence, it does not endorse it: `entry ?? config` is correct
    // (a billed month must keep the settings it was billed under). It matters because
    // setBearerConfigService only pushes onto periods >= the CURRENT billing month, so
    // a PAST month keeps its snapshot while the toast still says a plain "Setting saved."
    expect(isApplicable(row, "cleaningOwner")).toBe(true);
    expect(isApplicable(row, "cleaningTenant")).toBe(false);
  });
});
