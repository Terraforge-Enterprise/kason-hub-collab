import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseTenantSheet, TENANT_SHEETS } from "../sheet";

async function makePv9Like(): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("PV9 Tenant List");
  ws.addRow([
    "", "Tenants Name", "Unit", "Rooms", "Carpark", "Gender", "Type", "Rental",
    "Access Card", "Pax", "Tenants IC", "TenantsContact", "Email",
    "Move in Date", "Move out Date", "Tenancy Period", "AGENT",
    "Jan 25", "Feb 25",
  ]);
  ws.addRow([
    "", "Test Primary\nTest Cotenant", "A-10-3A", "Master Room", "", "Male", "", "900+120",
    "12345", 2, "880312101234", "0133456789", "x@y.com",
    new Date("2025-02-01"), new Date("2027-01-31"), "1Y", "KENDRA",
    100, 250,
  ]);
  return ws;
}

describe("parseTenantSheet", () => {
  it("maps headers by name and parses a PV9 row", async () => {
    const ws = await makePv9Like();
    const rows = parseTenantSheet(ws, "PV9 Tenant List");
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.unitCode).toBe("A-10-3A");
    expect(r.roomName).toBe("Master Room");
    expect(r.tenantNameRaw).toBe("Test Primary");
    expect(r.coTenantNames).toEqual(["Test Cotenant"]);
    expect(r.rentalRoom).toBe(900);
    expect(r.rentalCarpark).toBe(120);
    expect(r.numberOfPax).toBe(2);
    expect(r.gender).toBe("male");
    expect(r.termMonths).toBe(12);
    expect(r.agentLabel).toBe("KENDRA");
    expect(r.phoneRaw).toBe("0133456789");
    expect(r.latestReading).toBe(250);
  });

  it("excludes RS Tenant List from TENANT_SHEETS", () => {
    expect(TENANT_SHEETS).not.toContain("RS Tenant List");
    expect(TENANT_SHEETS).toContain("PV9 Tenant List");
  });
});
