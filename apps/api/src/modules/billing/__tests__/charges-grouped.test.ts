import { describe, it, expect, vi, beforeEach } from "vitest";

const { chargeFindManyMock, docLineFindManyMock, docFindManyMock } = vi.hoisted(() => ({
  chargeFindManyMock: vi.fn(),
  docLineFindManyMock: vi.fn(),
  docFindManyMock: vi.fn(),
}));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    charge: { findMany: chargeFindManyMock },
    billingDocumentLine: { findMany: docLineFindManyMock },
    billingDocument: { findMany: docFindManyMock },
  }),
}));

import { listChargesForMonth, findIvownDocsByInvoiceIds } from "../billing.repository";
import { getChargesGroupedService } from "../billing.service";

const ORG = "org-1";
const session = { orgId: ORG, userId: "u1", role: "admin" } as never;

function row(over: Record<string, unknown>) {
  return {
    id: "c1", chargeNumber: "RENT-202607-t1", status: "posted",
    dueDate: new Date("2026-07-01"), amount: { toString: () => "1500" },
    outstandingAmount: { toString: () => "0" }, currency: "MYR", chargeType: "rent",
    unitId: "unit-1", carparkId: null, invoiceId: null, categoryId: null,
    party: { displayName: "Ahmad" }, tenancy: { tenancyCode: "T-1" },
    unit: { apartment: { id: "apt-1", unitCode: "A-19-02", property: { name: "Tower A" } } },
    carpark: null, category: null, invoice: null,
    ...over,
  };
}

beforeEach(() => {
  chargeFindManyMock.mockReset();
  docLineFindManyMock.mockReset().mockResolvedValue([]);
  docFindManyMock.mockReset().mockResolvedValue([]);
});

describe("listChargesForMonth", () => {
  it("month window: billingMonth OR (null billingMonth + dueDate fallback)", async () => {
    chargeFindManyMock.mockResolvedValue([]);
    await listChargesForMonth(ORG, new Date("2026-07-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"));
    const arg = chargeFindManyMock.mock.calls[0][0];
    expect(arg.where.organizationId).toBe(ORG);
    expect(arg.where.OR).toEqual([
      { billingMonth: { gte: new Date("2026-07-01T00:00:00Z"), lt: new Date("2026-08-01T00:00:00Z") } },
      { billingMonth: null, dueDate: { gte: new Date("2026-07-01T00:00:00Z"), lt: new Date("2026-08-01T00:00:00Z") } },
    ]);
  });
});

describe("getChargesGroupedService groupBy=unit", () => {
  it("unit anchors: unit group, carpark group, unassigned; each charge carries a track + string categoryLabel", async () => {
    chargeFindManyMock.mockResolvedValue([
      row({ id: "c1" }),
      row({ id: "c2", chargeNumber: "AC-202607-u1", chargeType: "aircond", status: "draft",
            outstandingAmount: { toString: () => "90" }, amount: { toString: () => "90" } }),
      row({ id: "c3", chargeNumber: "CARPARK-202607-cp1", unitId: null, carparkId: "cp-1",
            unit: null, carpark: { label: "P-12" } }),
      row({ id: "c4", chargeNumber: "CLN-202607-x", unitId: null, carparkId: null, unit: null }),
    ]);
    const res = await getChargesGroupedService(session, { month: "2026-07", groupBy: "unit" });
    const kinds = res.groups.map((g) => g.kind);
    expect(kinds).toEqual(expect.arrayContaining(["unit", "carpark", "unassigned"]));
    const unitGroup = res.groups.find((g) => g.kind === "unit")!;
    expect(unitGroup.label).toBe("A-19-02");
    expect(unitGroup.propertyName).toBe("Tower A");
    expect(unitGroup.totals.chargeCount).toBe(2);
    expect(unitGroup.totals).not.toHaveProperty("postedCount");
    expect(unitGroup.charges[0].track).toBeDefined();
    expect(unitGroup.charges.every((c) => typeof c.categoryLabel === "string")).toBe(true);
    const carparkGroup = res.groups.find((g) => g.kind === "carpark")!;
    expect(carparkGroup.label).toBe("P-12");
  });

  it("doc enrich: first non-CN/RN document wins, CN/RN skipped, categoryLabel from category.name", async () => {
    chargeFindManyMock.mockResolvedValue([
      row({ id: "c1", category: { name: "Monthly rental", family: "pay_back_landlord" } }),
    ]);
    docLineFindManyMock.mockResolvedValue([
      { chargeId: "c1", document: { id: "d-cn", documentNumber: "CN-0002", docType: "credit_note" } },
      { chargeId: "c1", document: { id: "d-dep", documentNumber: "DEP-0009", docType: "debit_note" } },
      { chargeId: "c1", document: { id: "d-late", documentNumber: "DEP-0010", docType: "debit_note" } },
    ]);
    const res = await getChargesGroupedService(session, { month: "2026-07", groupBy: "unit" });
    const charge = res.groups.find((g) => g.kind === "unit")!.charges[0];
    expect(charge.documentId).toBe("d-dep");        // CN skipped, first non-CN/RN wins
    expect(charge.documentNumber).toBe("DEP-0009"); // not the later DEP-0010
    expect(charge.categoryLabel).toBe("Monthly rental");
  });
});

describe("getChargesGroupedService groupBy=statement", () => {
  it("statement grouping excludes tenant_rental and buckets unattached owner charges", async () => {
    chargeFindManyMock.mockResolvedValue([
      row({ id: "s1", chargeNumber: "OSC-202607-ow-0001", chargeType: "management_fee", status: "draft",
            invoiceId: "inv-1", partyId: "owner-1", party: { displayName: "Razak" },
            invoice: { id: "inv-1", invoiceNumber: "OS-202607-x", status: "approved", invoiceType: "owner_statement" } }),
      row({ id: "s2", chargeNumber: "CLN-202607-ow-0001", chargeType: "cleaning", status: "draft",
            invoiceId: null, party: { displayName: "Razak" } }),
      row({ id: "s3", chargeNumber: "RENT-202607-t9", chargeType: "rent", status: "draft",
            invoiceId: "inv-2",
            invoice: { id: "inv-2", invoiceNumber: "TR-202607-x", status: "draft", invoiceType: "tenant_rental" } }),
    ]);
    docFindManyMock.mockResolvedValue([
      { statementInvoiceId: "inv-1", id: "doc-9", documentNumber: "IVOWN-0007", docType: "invoice" },
    ]);
    const res = await getChargesGroupedService(session, { month: "2026-07", groupBy: "statement" });
    const stmt = res.groups.find((g) => g.kind === "statement")!;
    expect(stmt.label).toBe("OS-202607-x");
    expect(stmt.statementStatus).toBe("approved");
    expect(stmt.ivownDocumentNumber).toBe("IVOWN-0007");
    expect(stmt.charges[0].displayStatus).toBe("on_statement");
    const unattached = res.groups.find((g) => g.kind === "unattached")!;
    expect(unattached.charges.map((c) => c.id)).toEqual(["s2"]);
    // tenant_rental child appears in NO group
    const allIds = res.groups.flatMap((g) => g.charges.map((c) => c.id));
    expect(allIds).not.toContain("s3");
  });
});

import { Hono } from "hono";
import { billingRoutes } from "../billing.routes";

describe("GET /charges/grouped route", () => {
  it("400 on bad month", async () => {
    const app = new Hono<{ Variables: { session: unknown } }>();
    app.use("*", async (c, next) => { c.set("session", session); await next(); });
    app.route("/billing", billingRoutes);
    const res = await app.request("/billing/charges/grouped?month=2026-7&groupBy=unit");
    expect(res.status).toBe(400);
  });
});
