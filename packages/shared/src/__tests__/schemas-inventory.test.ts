import { describe, expect, it } from "vitest";
import {
  createUnitSchema,
  createPortalUnitSchema,
  updateUnitSchema,
} from "../schemas/inventory";

describe("createUnitSchema — deposit fields", () => {
  it("accepts all new optional deposit fields", () => {
    const parsed = createUnitSchema.safeParse({
      propertyId: "11111111-1111-4111-8111-111111111111",
      unitCode: "A-1",
      unitType: "studio",
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      accessCardDepositPerPcs: 100,
      accessCardQuantity: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative deposit values", () => {
    const parsed = createUnitSchema.safeParse({
      propertyId: "11111111-1111-4111-8111-111111111111",
      unitCode: "A-1",
      unitType: "studio",
      utilitiesDepositMonths: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it("caps utilitiesDepositMonths at 12", () => {
    const parsed = createUnitSchema.safeParse({
      propertyId: "11111111-1111-4111-8111-111111111111",
      unitCode: "A-1",
      unitType: "studio",
      utilitiesDepositMonths: 13,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("createUnitSchema — parking fields", () => {
  // depositMonths + utilitiesDepositMonths are now required on create. Bake
  // them into the base so each parking test exercises only the parking refiner.
  const baseValid = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    unitCode: "A-1",
    unitType: "studio",
    depositMonths: 2,
    utilitiesDepositMonths: 0.5,
  };

  it("accepts parkingQuantity + parkingNumbers when length matches", () => {
    const parsed = createUnitSchema.safeParse({
      ...baseValid,
      parkingQuantity: 2,
      parkingNumbers: ["B2-145", "B3-088"],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts empty parkingNumbers (uploader skipped numbering)", () => {
    const parsed = createUnitSchema.safeParse({
      ...baseValid,
      parkingQuantity: 2,
      parkingNumbers: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects parkingNumbers length mismatch when both set", () => {
    const parsed = createUnitSchema.safeParse({
      ...baseValid,
      parkingQuantity: 2,
      parkingNumbers: ["B2-145"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("createUnitSchema — mandatory deposit fields", () => {
  const baseMissingDeposits = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    unitCode: "A-1",
    unitType: "studio",
  };

  it("rejects payload missing depositMonths", () => {
    const parsed = createUnitSchema.safeParse({
      ...baseMissingDeposits,
      utilitiesDepositMonths: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects payload missing utilitiesDepositMonths", () => {
    const parsed = createUnitSchema.safeParse({
      ...baseMissingDeposits,
      depositMonths: 2,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("createPortalUnitSchema", () => {
  it("inherits new fields from createUnitSchema", () => {
    const parsed = createPortalUnitSchema.safeParse({
      propertyId: "11111111-1111-4111-8111-111111111111",
      unitCode: "A-1",
      unitType: "studio",
      depositMonths: 2,
      utilitiesDepositMonths: 0.5,
      parkingQuantity: 1,
      parkingNumbers: ["B2-145"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects portal create missing both deposit fields", () => {
    const parsed = createPortalUnitSchema.safeParse({
      propertyId: "11111111-1111-4111-8111-111111111111",
      unitCode: "A-1",
      unitType: "studio",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("updateUnitSchema — occupancy tenancy fields", () => {
  // Zod v4 enforces strict UUID version bits — use a valid v4 UUID
  const validUuid = "11111111-1111-4111-8111-111111111111";

  it("ACCEPTS occupancyStatus='occupied' alone (no trio fields = pass-through; transition gate is in updateUnitService)", () => {
    const result = updateUnitSchema.safeParse({
      unitId: validUuid,
      occupancyStatus: "occupied",
    });
    expect(result.success).toBe(true);
  });

  it("pass-through: occupied + tenantName alone (no trio dates/id) — tenantName no longer triggers refiner", () => {
    // After Task 4, tenantName is NOT in the trio trigger set. Providing only
    // tenantName (no tenantPartyId/moveInDate/moveOutDate) = pass-through.
    const result = updateUnitSchema.safeParse({
      unitId: validUuid,
      occupancyStatus: "occupied",
      tenantName: "NURUL IZZAH",
      // moveInDate + moveOutDate intentionally absent — no trio fields trigger
    });
    expect(result.success).toBe(true);
  });

  it("rejects occupied with dates + tenantName but NO tenantPartyId (trio is dates-triggered, tenantPartyId now required)", () => {
    // Trio is triggered by moveInDate/moveOutDate, but tenantPartyId is missing
    const result = updateUnitSchema.safeParse({
      unitId: validUuid,
      occupancyStatus: "occupied",
      tenantName: "NURUL IZZAH",
      moveInDate: "2026-04-25",
      moveOutDate: "2026-05-20",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("tenantPartyId"); // tenantPartyId now required
    }
  });

  it("rejects moveOutDate <= moveInDate", () => {
    const result = updateUnitSchema.safeParse({
      unitId: validUuid,
      occupancyStatus: "occupied",
      tenantPartyId: "22222222-2222-4222-8222-222222222222",
      moveInDate: "2026-05-20",
      moveOutDate: "2026-04-25",
    });
    expect(result.success).toBe(false);
  });

  it("ignores tenancy fields when occupancyStatus is not 'occupied'", () => {
    const result = updateUnitSchema.safeParse({
      unitId: validUuid,
      occupancyStatus: "vacant",
      // even if these are absent, schema must accept
    });
    expect(result.success).toBe(true);
  });
});

const VALID_UNIT = "11111111-1111-4111-8111-111111111111";
const VALID_TENANT = "22222222-2222-4222-8222-222222222222";

describe("updateUnitSchema — occupancy tenant link", () => {
  it("accepts occupied + tenantPartyId + dates", () => {
    const r = updateUnitSchema.safeParse({
      unitId: VALID_UNIT, occupancyStatus: "occupied",
      tenantPartyId: VALID_TENANT, moveInDate: "2026-04-25", moveOutDate: "2026-05-20",
    });
    expect(r.success).toBe(true);
  });

  it("rejects occupied with dates but NO tenantPartyId", () => {
    const r = updateUnitSchema.safeParse({
      unitId: VALID_UNIT, occupancyStatus: "occupied",
      moveInDate: "2026-04-25", moveOutDate: "2026-05-20",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("tenantPartyId"))).toBe(true);
    }
  });

  it("rejects a non-uuid tenantPartyId", () => {
    const r = updateUnitSchema.safeParse({
      unitId: VALID_UNIT, occupancyStatus: "occupied",
      tenantPartyId: "nope", moveInDate: "2026-04-25", moveOutDate: "2026-05-20",
    });
    expect(r.success).toBe(false);
  });

  it("rejects moveOut <= moveIn", () => {
    const r = updateUnitSchema.safeParse({
      unitId: VALID_UNIT, occupancyStatus: "occupied",
      tenantPartyId: VALID_TENANT, moveInDate: "2026-05-20", moveOutDate: "2026-05-20",
    });
    expect(r.success).toBe(false);
  });

  it("pass-through: occupied with NO trio field stays valid (import/no-op path)", () => {
    const r = updateUnitSchema.safeParse({ unitId: VALID_UNIT, occupancyStatus: "occupied" });
    expect(r.success).toBe(true);
  });

  it("does not require tenantPartyId when status is not occupied", () => {
    const r = updateUnitSchema.safeParse({
      unitId: VALID_UNIT, occupancyStatus: "vacant", tenantPartyId: VALID_TENANT,
    });
    expect(r.success).toBe(true);
  });
});
