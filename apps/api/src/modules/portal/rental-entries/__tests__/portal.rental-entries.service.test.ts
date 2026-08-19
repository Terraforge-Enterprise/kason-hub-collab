import { describe, it, expect, beforeEach, vi } from "vitest";

const txMock = {
  property: { findFirst: vi.fn() },
  unit: { findFirst: vi.fn(), create: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => ({
    $transaction: (fn: (tx: any) => Promise<any>) => fn(txMock),
  }),
}));

import { createRentalEntryService } from "../portal.rental-entries.service";
import type { CreateRentalEntryInput } from "../portal.rental-entries.validation";

const baseCtx = { orgId: "org-1", agentPartyId: "agent-1", actorUserId: "user-1" };

const baseInput: CreateRentalEntryInput = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitCode: "A-12-01",
  unitType: "apartment",
  // depositMonths + utilitiesDepositMonths are required on every rental entry
  // (B's schema change). Keep a sensible default here so the file's other
  // tests don't have to repeat them.
  depositMonths: 2,
  utilitiesDepositMonths: 0.5,
  amenities: [],
};

beforeEach(() => {
  Object.values(txMock).forEach((m: any) => Object.values(m).forEach((fn: any) => fn.mockReset()));
  txMock.property.findFirst.mockResolvedValue({ id: baseInput.propertyId, organizationId: "org-1" });
  txMock.unit.findFirst.mockResolvedValue(null);
  txMock.unit.create.mockResolvedValue({ id: "unit-new", propertyId: baseInput.propertyId, unitCode: "A-12-01", sourcingApproved: false, listingStatus: "draft" });
});

describe("createRentalEntryService — happy path", () => {
  it("creates Unit with AGENT_SOURCED + sourcingAgentId + inChargePartyId set to actor party", async () => {
    const result = await createRentalEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(true);
    expect(txMock.unit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        propertyId: baseInput.propertyId,
        unitCode: "A-12-01",
        unitType: "apartment",
        sourceFlag: "AGENT_SOURCED",
        sourcingAgentId: "agent-1",
        inChargePartyId: "agent-1",
        sourcingApproved: false,
        listingStatus: "draft",
        occupancyStatus: "vacant",
        visibilityMode: "PRIVATE",
      }),
      select: expect.any(Object),
    });
  });
});

describe("createRentalEntryService — Phase 1 amenity lockdown", () => {
  it("ignores any input.amenities and writes [] to Unit.amenities (Phase 1 lockdown)", async () => {
    const inputWithAmenities: CreateRentalEntryInput = {
      ...baseInput,
      amenities: [
        "11111111-1111-4111-8111-aaaaaaaaaaaa",
        "22222222-2222-4222-8222-bbbbbbbbbbbb",
      ],
    } as CreateRentalEntryInput;

    const result = await createRentalEntryService(inputWithAmenities, baseCtx);

    expect(result.ok).toBe(true);
    expect(txMock.unit.create).toHaveBeenCalledTimes(1);
    expect(txMock.unit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amenities: [] }),
      select: expect.any(Object),
    });
  });
});

describe("createRentalEntryService — error paths", () => {
  it("returns 404 property_not_found if Property not in org", async () => {
    txMock.property.findFirst.mockResolvedValue(null);
    const result = await createRentalEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("property_not_found");
  });

  it("returns 409 unit_code_already_exists when (propertyId, unitCode, unitType) collides", async () => {
    txMock.unit.findFirst.mockResolvedValue({ id: "existing" });
    const result = await createRentalEntryService(baseInput, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unit_code_already_exists");
  });
});
