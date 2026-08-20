import { beforeEach, describe, expect, it, vi } from "vitest";

// Custom db mock with a ticket.findMany spy — overrides the file-alias stub so
// we can assert the exact Prisma query shape built by the repository.
const findMany = vi.fn();
const wcFindMany = vi.fn();
const dbMock = { ticket: { findMany }, workCategory: { findMany: wcFindMany } };
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import {
  fetchOrgTicketsForAnalytics,
  fetchUnitTicketsForAnalytics,
  fetchWorkCategoryNames,
} from "../analytics.repository";

const ORG = "org-00000000-0000-0000-0000-000000000001";
const PROP = "prop-0000-0000-0000-0000-000000000002";
const UNIT = "unit-0000-0000-0000-0000-000000000003";

// Minimal row shape that matches what flatten() expects from Prisma.
const fakeRow = {
  unitId: UNIT,
  category: "Plumbing",
  status: "open",
  createdAt: new Date("2026-06-01T00:00:00Z"),
  unit: {
    apartment: {
      unitCode: "A-101",
      propertyId: PROP,
      property: { name: "Tower A" },
    },
  },
};

beforeEach(() => vi.clearAllMocks());

// ── fetchOrgTicketsForAnalytics ───────────────────────────────────────────────

describe("fetchOrgTicketsForAnalytics", () => {
  it("calls ticket.findMany with organizationId and status: { not: 'void' }", async () => {
    findMany.mockResolvedValue([fakeRow]);
    await fetchOrgTicketsForAnalytics(ORG);
    expect(findMany).toHaveBeenCalledTimes(1);
    const [call] = findMany.mock.calls as [Parameters<typeof findMany>];
    expect(call[0].where).toMatchObject({
      organizationId: ORG,
      status: { not: "void" },
    });
  });

  it("does NOT include a unit filter when propertyId is omitted", async () => {
    findMany.mockResolvedValue([]);
    await fetchOrgTicketsForAnalytics(ORG);
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).not.toHaveProperty("unit");
  });

  it("adds nested unit.apartment.propertyId filter when propertyId is supplied", async () => {
    findMany.mockResolvedValue([]);
    await fetchOrgTicketsForAnalytics(ORG, PROP);
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      organizationId: ORG,
      status: { not: "void" },
      unit: { apartment: { propertyId: PROP } },
    });
  });

  it("select pulls unitId, category, status, createdAt, and the unit→apartment→property join", async () => {
    findMany.mockResolvedValue([]);
    await fetchOrgTicketsForAnalytics(ORG);
    const { select } = findMany.mock.calls[0]![0] as { select: Record<string, unknown> };
    // Core scalar fields
    expect(select.unitId).toBe(true);
    expect(select.category).toBe(true);
    expect(select.status).toBe(true);
    expect(select.createdAt).toBe(true);
    // Nested join: unit → apartment → { unitCode, propertyId, property.name }
    const unitSelect = (select.unit as { select: { apartment: { select: Record<string, unknown> } } }).select;
    expect(unitSelect.apartment.select).toMatchObject({
      unitCode: true,
      propertyId: true,
      property: { select: { name: true } },
    });
  });

  it("flattens the nested Prisma row into AnalyticsTicketRow shape", async () => {
    findMany.mockResolvedValue([fakeRow]);
    const rows = await fetchOrgTicketsForAnalytics(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      unitId: UNIT,
      category: "Plumbing",
      status: "open",
      createdAt: fakeRow.createdAt,
      unitCode: "A-101",
      propertyId: PROP,
      propertyName: "Tower A",
    });
  });
});

// ── fetchUnitTicketsForAnalytics ──────────────────────────────────────────────

describe("fetchUnitTicketsForAnalytics", () => {
  it("calls ticket.findMany with organizationId, unitId, and status: { not: 'void' }", async () => {
    findMany.mockResolvedValue([]);
    await fetchUnitTicketsForAnalytics(ORG, UNIT);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toMatchObject({
      organizationId: ORG,
      unitId: UNIT,
      status: { not: "void" },
    });
  });

  it("flattens rows correctly for the unit scope", async () => {
    findMany.mockResolvedValue([fakeRow]);
    const rows = await fetchUnitTicketsForAnalytics(ORG, UNIT);
    expect(rows[0]).toMatchObject({ unitId: UNIT, unitCode: "A-101", propertyName: "Tower A" });
  });
});

// ── fetchWorkCategoryNames ──────────────────────────────────────────────

describe("fetchWorkCategoryNames", () => {
  it("selects all names ordered by sortOrder asc and maps to string[]", async () => {
    wcFindMany.mockResolvedValue([{ name: "Plumbing" }, { name: "Electricity" }]);
    const names = await fetchWorkCategoryNames(ORG);
    expect(names).toEqual(["Plumbing", "Electricity"]);
    const arg = wcFindMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
      orderBy: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ organizationId: ORG });
    expect(arg.where).not.toHaveProperty("isActive");
    expect(arg.select).toEqual({ name: true });
    expect(arg.orderBy).toEqual({ sortOrder: "asc" });
  });
});
