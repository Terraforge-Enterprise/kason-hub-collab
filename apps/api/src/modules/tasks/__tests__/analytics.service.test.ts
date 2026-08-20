import { describe, it, expect, vi, beforeEach } from "vitest";
import * as repo from "../analytics.repository";
import { getUnitsAnalytics, getCategoryLens, getTrend, windowStartFrom, getUnitMiniStat } from "../analytics.service";

vi.mock("../analytics.repository");
const ORG = "org-1";
const mk = (
  o: Partial<repo.AnalyticsTicketRow> & { unitId: string; createdAt: Date },
): repo.AnalyticsTicketRow => ({
  id: "ticket-default",
  title: "Default ticket title",
  unitCode: "A-1",
  propertyId: "p1",
  propertyName: "Tower A",
  category: null,
  status: "open",
  resolvedAt: null,
  ...o,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue([
    "Plumbing", "Lighting", "Electrical", "Aircond/HVAC", "Appliance",
    "Furniture/Fittings", "Wifi/Internet", "Pest", "Cleaning",
    "Locks/Access", "Structural", "Painting",
  ]);
});

describe("getUnitsAnalytics", () => {
  it("excludes void implicitly (repo filters), splits open vs total, flags recurrence >=3 in window", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    const inWin = new Date("2026-06-01T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", category: "Plumbing", status: "open", createdAt: inWin }),
      mk({ unitId: "u1", category: "plumbing", status: "resolved", createdAt: inWin }),
      mk({ unitId: "u1", category: " Plumbing ", status: "in_progress", createdAt: inWin }),
      mk({ unitId: "u1", category: "Lighting", status: "resolved", createdAt: inWin }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const u1 = res.data.rows.find((r) => r.unitId === "u1")!;
    expect(u1.total).toBe(4);
    expect(u1.open).toBe(2); // open + in_progress
    const plumbing = u1.byCategory.find((c) => c.canonical === "Plumbing")!;
    expect(plumbing.count).toBe(3);
    expect(plumbing.recurring).toBe(true);
    expect(u1.recurringCategories).toContain("Plumbing");
    expect(u1.topRecurringCategory).toBe("Plumbing");
  });

  it("excludes out-of-window tickets from windowTotal/byCategory but keeps them in lifetime total", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    const old = new Date("2024-01-01T00:00:00Z"); // outside 12mo
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", category: "Pest", status: "resolved", createdAt: old }),
      mk({ unitId: "u1", category: "Pest", status: "open", createdAt: new Date("2026-06-10T00:00:00Z") }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    const u1 = res.data.rows[0];
    expect(u1.total).toBe(2); // lifetime
    expect(u1.windowTotal).toBe(1); // within 12mo
    expect(u1.open).toBe(1);
  });

  it("counts non-canonical categories into the unmapped nudge (window-scoped)", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({
        unitId: "u1",
        category: "aircond leaking",
        status: "open",
        createdAt: new Date("2026-06-10T00:00:00Z"),
      }),
      mk({
        unitId: "u1",
        category: "Other",
        status: "open",
        createdAt: new Date("2026-06-10T00:00:00Z"),
      }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.unmapped.count).toBe(1); // "aircond leaking" only; explicit "Other" is mapped
  });

  it("ranks worst-first: open desc then total desc", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    const d = new Date("2026-06-10T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "low", unitCode: "L", status: "resolved", createdAt: d }),
      mk({ unitId: "high", unitCode: "H", status: "open", createdAt: d }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.rows[0].unitId).toBe("high");
  });

  it("maps org-managed custom names (not the hardcoded list) to themselves", async () => {
    const now = new Date("2026-06-29T00:00:00Z");
    const d = new Date("2026-06-20T00:00:00Z");
    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Electricity", "TEST"]);
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", category: "Electricity", status: "open", createdAt: d }),
      mk({ unitId: "u1", category: "TEST", status: "resolved", createdAt: d }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    const u1 = res.data.rows.find((r) => r.unitId === "u1")!;
    expect(u1.byCategory.map((c) => c.canonical).sort()).toEqual(["Electricity", "TEST"]);
    expect(res.data.unmapped.count).toBe(0);
  });
});

describe("getCategoryLens", () => {
  it("returns units per canonical category ranked by count desc, recurring flagged", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    const d = new Date("2026-06-10T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "B", unitCode: "B", category: "Lighting", createdAt: d }),
      mk({ unitId: "B", unitCode: "B", category: "Lighting", createdAt: d }),
      mk({ unitId: "B", unitCode: "B", category: "Lighting", createdAt: d }),
      mk({ unitId: "D", unitCode: "D", category: "lighting", createdAt: d }),
      mk({ unitId: "D", unitCode: "D", category: "Lighting", createdAt: d }),
    ]);
    const res = await getCategoryLens(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    const lighting = res.data.find((c) => c.canonical === "Lighting")!;
    expect(lighting.total).toBe(5);
    expect(lighting.units[0]).toMatchObject({ unitCode: "B", count: 3, recurring: true });
    expect(lighting.units[1]).toMatchObject({ unitCode: "D", count: 2, recurring: false });
  });

  it("maps a custom org category name in the lens (not the hardcoded list)", async () => {
    const now = new Date("2026-06-29T00:00:00Z");
    const d = new Date("2026-06-20T00:00:00Z");
    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Electricity"]);
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", unitCode: "A-1", category: "Electricity", createdAt: d }),
    ]);
    const res = await getCategoryLens(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.map((c) => c.canonical)).toContain("Electricity");
  });
});

describe("getUnitsAnalytics — summary aggregates", () => {
  it("computes mttrDays as mean of resolved ticket durations (1 decimal)", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    // ticket 1: resolved in 2 days exactly
    const t1Created = new Date("2026-06-01T00:00:00Z");
    const t1Resolved = new Date("2026-06-03T00:00:00Z"); // 2 days
    // ticket 2: resolved in 4 days exactly
    const t2Created = new Date("2026-06-05T00:00:00Z");
    const t2Resolved = new Date("2026-06-09T00:00:00Z"); // 4 days
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "resolved", createdAt: t1Created, resolvedAt: t1Resolved }),
      mk({ unitId: "u1", status: "resolved", createdAt: t2Created, resolvedAt: t2Resolved }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.mttrDays).toBe(3.0); // (2+4)/2 = 3 days
  });

  it("returns mttrDays=null when no resolved tickets", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-06-01T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.mttrDays).toBeNull();
  });

  it("returns mttrDays=null when resolved tickets have no resolvedAt", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "resolved", createdAt: new Date("2026-06-01T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.mttrDays).toBeNull();
  });

  it("computes oldestOpenDays as max age of open/in_progress tickets", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    // open ticket created 10 days ago
    const t1 = new Date("2026-06-09T00:00:00Z"); // 10 days before now
    // in_progress ticket created 5 days ago
    const t2 = new Date("2026-06-14T00:00:00Z"); // 5 days before now
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: t1, resolvedAt: null }),
      mk({ unitId: "u1", status: "in_progress", createdAt: t2, resolvedAt: null }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.oldestOpenDays).toBe(10.0); // max is 10
  });

  it("returns oldestOpenDays=null when no open/in_progress tickets", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "resolved", createdAt: new Date("2026-06-01T00:00:00Z"), resolvedAt: new Date("2026-06-03T00:00:00Z") }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.oldestOpenDays).toBeNull();
  });

  it("counts openOver30 correctly (30-day boundary: >30 days only)", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    // exactly 30 days old — NOT included
    const t30 = new Date("2026-05-20T00:00:00Z"); // 30 days before now
    // 31 days old — included
    const t31 = new Date("2026-05-19T00:00:00Z"); // 31 days before now
    // 5 days old — NOT included
    const t5 = new Date("2026-06-14T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: t30, resolvedAt: null }),
      mk({ unitId: "u1", status: "in_progress", createdAt: t31, resolvedAt: null }),
      mk({ unitId: "u1", status: "open", createdAt: t5, resolvedAt: null }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.openOver30).toBe(1); // only t31
  });

  it("openOver30=0 when all open tickets are within 30 days", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-06-14T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getUnitsAnalytics(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.summary.openOver30).toBe(0);
  });
});

describe("getTrend", () => {
  it("buckets tickets by YYYY-MM with two series (created/resolved), zero-fills full span", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-04-04T00:00:00Z"), resolvedAt: null }),
      mk({ unitId: "u1", status: "resolved", createdAt: new Date("2026-05-20T00:00:00Z"), resolvedAt: new Date("2026-05-25T00:00:00Z") }),
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-06-02T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getTrend(ORG, { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    const data = res.data;
    // Should span from 2026-04 (earliest ticket) to 2026-06 (now)
    expect(data.map((d) => d.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
    // created series
    expect(data.find((d) => d.month === "2026-04")?.created).toBe(1);
    expect(data.find((d) => d.month === "2026-05")?.created).toBe(1);
    expect(data.find((d) => d.month === "2026-06")?.created).toBe(1);
    // resolved series — buckets by resolvedAt
    expect(data.find((d) => d.month === "2026-04")?.resolved).toBe(0);
    expect(data.find((d) => d.month === "2026-05")?.resolved).toBe(1); // resolvedAt=2026-05-25
    expect(data.find((d) => d.month === "2026-06")?.resolved).toBe(0);
  });

  it("ignores the window filter — always full history", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    // ticket created 2 years ago — outside any reasonable window
    const oldCreated = new Date("2024-03-01T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "resolved", createdAt: oldCreated, resolvedAt: new Date("2024-03-10T00:00:00Z") }),
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-06-01T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getTrend(ORG, { window: "30d" }, now); // 30d window but trend ignores it
    if (!res.ok) throw new Error("expected ok");
    const months = res.data.map((d) => d.month);
    expect(months[0]).toBe("2024-03"); // starts at oldest ticket, not window start
    expect(months[months.length - 1]).toBe("2026-06");
  });

  it("zero-fills months with no tickets", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-04-01T00:00:00Z"), resolvedAt: null }),
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-06-01T00:00:00Z"), resolvedAt: null }),
      // Note: 2026-05 has no tickets
    ]);
    const res = await getTrend(ORG, { window: "all" }, now);
    if (!res.ok) throw new Error("expected ok");
    const may = res.data.find((d) => d.month === "2026-05");
    expect(may).toBeDefined();
    expect(may?.created).toBe(0);
    expect(may?.resolved).toBe(0);
  });

  it("resolved series buckets by resolvedAt, skips nulls", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      // created in May, resolved in June
      mk({ unitId: "u1", status: "resolved", createdAt: new Date("2026-05-01T00:00:00Z"), resolvedAt: new Date("2026-06-10T00:00:00Z") }),
      // open, no resolvedAt
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-05-15T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getTrend(ORG, { window: "all" }, now);
    if (!res.ok) throw new Error("expected ok");
    // created: May=2, June=0; resolved: May=0, June=1
    expect(res.data.find((d) => d.month === "2026-05")?.resolved).toBe(0);
    expect(res.data.find((d) => d.month === "2026-06")?.resolved).toBe(1);
  });

  it("returns data sorted ascending by month", async () => {
    const now = new Date("2026-06-19T00:00:00Z");
    vi.mocked(repo.fetchOrgTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-06-01T00:00:00Z"), resolvedAt: null }),
      mk({ unitId: "u1", status: "open", createdAt: new Date("2026-04-01T00:00:00Z"), resolvedAt: null }),
    ]);
    const res = await getTrend(ORG, { window: "all" }, now);
    if (!res.ok) throw new Error("expected ok");
    const months = res.data.map((d) => d.month);
    expect(months).toEqual([...months].sort());
  });
});

describe("windowStartFrom", () => {
  it("returns null for all-time and a date for bounded windows", () => {
    const now = new Date("2026-06-19T00:00:00Z");
    expect(windowStartFrom("all", now)).toBeNull();
    expect(windowStartFrom("30d", now)!.getTime()).toBe(
      new Date("2026-05-20T00:00:00Z").getTime(),
    );
  });

  it("12mo window uses UTC month arithmetic (consistent with bucketMonth UTC output)", () => {
    // UTC+8 midnight: 2026-06-19T16:00:00Z — local day is 2026-06-19 but UTC date is still June 19.
    // getUTCMonth()-12 must yield 2025-06-19T16:00:00Z, not drift due to local-time setMonth.
    const now = new Date("2026-06-19T16:00:00Z");
    const start = windowStartFrom("12mo", now)!;
    expect(start.getUTCFullYear()).toBe(2025);
    expect(start.getUTCMonth()).toBe(5); // June = month index 5
    expect(start.getUTCDate()).toBe(19);
  });
});

describe("getUnitMiniStat", () => {
  it("maps a custom org category name for a single unit", async () => {
    const now = new Date("2026-06-29T00:00:00Z");
    const d = new Date("2026-06-20T00:00:00Z");
    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Electricity"]);
    vi.mocked(repo.fetchUnitTicketsForAnalytics).mockResolvedValue([
      mk({ unitId: "u1", category: "Electricity", status: "open", createdAt: d }),
    ]);
    const res = await getUnitMiniStat(ORG, "u1", { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.byCategory.map((c) => c.canonical)).toContain("Electricity");
  });

  it("tickets: lists non-void tickets most-recent-first with all required fields", async () => {
    // Fixed "now" for deterministic ageDays
    const now = new Date("2026-06-30T00:00:00Z");
    // older ticket: created 10 days ago, open
    const older = new Date("2026-06-20T00:00:00Z");
    // newer ticket: created 3 days ago, resolved 1 day ago
    const newer = new Date("2026-06-27T00:00:00Z");
    const resolvedAt = new Date("2026-06-29T00:00:00Z");

    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Plumbing", "Lighting"]);
    vi.mocked(repo.fetchUnitTicketsForAnalytics).mockResolvedValue([
      // repo returns asc by createdAt
      mk({
        id: "t-old",
        title: "Old plumbing leak",
        unitId: "u1",
        category: "Plumbing",
        status: "open",
        createdAt: older,
        resolvedAt: null,
      }),
      mk({
        id: "t-new",
        title: "Lighting fixed",
        unitId: "u1",
        category: "Lighting",
        status: "resolved",
        createdAt: newer,
        resolvedAt,
      }),
    ]);

    const res = await getUnitMiniStat(ORG, "u1", { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");

    const { tickets } = res.data;
    expect(tickets).toHaveLength(2);

    // Most-recent-first: newer ticket first
    expect(tickets[0].id).toBe("t-new");
    expect(tickets[1].id).toBe("t-old");

    // Verify all fields on the newer (resolved) ticket
    expect(tickets[0]).toMatchObject({
      id: "t-new",
      title: "Lighting fixed",
      categoryCanonical: "Lighting",
      status: "resolved",
      createdAt: newer.toISOString(),
      resolvedAt: resolvedAt.toISOString(),
      ageDays: 2, // resolvedAt(Jun29) - createdAt(Jun27) = 2 days (whole days)
    });

    // Verify the open ticket (ageDays uses now, not resolvedAt)
    expect(tickets[1]).toMatchObject({
      id: "t-old",
      title: "Old plumbing leak",
      categoryCanonical: "Plumbing",
      status: "open",
      createdAt: older.toISOString(),
      resolvedAt: null,
      ageDays: 10, // now(Jun30) - createdAt(Jun20) = 10 days
    });
  });

  it("tickets: excludes void tickets — void ticket id must NOT appear in tickets", async () => {
    // Repo filters void at DB level; service also filters as safety net.
    // We include a void row in the mock to confirm it is absent from the result.
    const now = new Date("2026-06-30T00:00:00Z");
    const d = new Date("2026-06-25T00:00:00Z");

    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Plumbing"]);
    vi.mocked(repo.fetchUnitTicketsForAnalytics).mockResolvedValue([
      mk({ id: "t-ok", title: "Good ticket", unitId: "u1", category: "Plumbing", status: "open", createdAt: d }),
      mk({ id: "t-void", title: "Voided ticket", unitId: "u1", category: "Plumbing", status: "void", createdAt: d }),
    ]);

    const res = await getUnitMiniStat(ORG, "u1", { window: "all" }, now);
    if (!res.ok) throw new Error("expected ok");
    // Non-void ticket must be present
    expect(res.data.tickets.some((t) => t.id === "t-ok")).toBe(true);
    // Void ticket must NOT appear
    expect(res.data.tickets.some((t) => t.id === "t-void")).toBe(false);
    // tickets length must reflect only non-void
    expect(res.data.tickets).toHaveLength(1);
  });

  it("tickets: uses the same category canonicalisation as byCategory", async () => {
    const now = new Date("2026-06-30T00:00:00Z");
    const d = new Date("2026-06-25T00:00:00Z");

    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Plumbing"]);
    vi.mocked(repo.fetchUnitTicketsForAnalytics).mockResolvedValue([
      // "plumbing" (lowercase) should canonicalise to "Plumbing"
      mk({ id: "t1", title: "Leak", unitId: "u1", category: "plumbing", status: "open", createdAt: d }),
    ]);

    const res = await getUnitMiniStat(ORG, "u1", { window: "12mo" }, now);
    if (!res.ok) throw new Error("expected ok");

    expect(res.data.tickets[0].categoryCanonical).toBe("Plumbing");
    // byCategory and tickets must agree
    expect(res.data.byCategory[0].canonical).toBe("Plumbing");
  });

  it("tickets: ageDays is whole days (floor) from createdAt to resolvedAt ?? now", async () => {
    const now = new Date("2026-06-30T12:00:00Z"); // noon
    // created at midnight, so only 12 hours ago → ageDays should be 0 (floor)
    const d = new Date("2026-06-30T00:00:00Z");

    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Plumbing"]);
    vi.mocked(repo.fetchUnitTicketsForAnalytics).mockResolvedValue([
      mk({ id: "t1", title: "Same day", unitId: "u1", category: "Plumbing", status: "open", createdAt: d }),
    ]);

    const res = await getUnitMiniStat(ORG, "u1", { window: "all" }, now);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.tickets[0].ageDays).toBe(0); // 12h < 1 day → floor = 0
  });

  it("tickets: window-boundary — only in-window tickets appear; tickets.length equals sum of byCategory counts", async () => {
    // Fix now and use a short 90d window so a 2-year-old ticket falls outside.
    const now = new Date("2026-06-30T00:00:00Z");
    // In-window: 30 days ago (well inside 90d)
    const inWindow = new Date("2026-06-01T00:00:00Z");
    // Out-of-window: ~2 years ago (clearly outside 90d)
    const outOfWindow = new Date("2024-01-01T00:00:00Z");

    vi.mocked(repo.fetchWorkCategoryNames).mockResolvedValue(["Plumbing", "Lighting"]);
    vi.mocked(repo.fetchUnitTicketsForAnalytics).mockResolvedValue([
      mk({ id: "in-1", title: "Recent plumbing", unitId: "u1", category: "Plumbing", status: "open", createdAt: inWindow }),
      mk({ id: "out-1", title: "Old lighting", unitId: "u1", category: "Lighting", status: "resolved", createdAt: outOfWindow }),
    ]);

    const res = await getUnitMiniStat(ORG, "u1", { window: "90d" }, now);
    if (!res.ok) throw new Error("expected ok");
    const { tickets, byCategory } = res.data;

    // Only the in-window ticket must appear
    expect(tickets.map((t) => t.id)).toEqual(["in-1"]);
    expect(tickets.some((t) => t.id === "out-1")).toBe(false);

    // tickets.length must equal the sum of byCategory counts (the two sets agree)
    const categorySum = byCategory.reduce((acc, c) => acc + c.count, 0);
    expect(tickets.length).toBe(categorySum);
  });

});
