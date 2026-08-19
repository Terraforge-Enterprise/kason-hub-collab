import { getDb } from "@kason/db";
import type { CreateRentalEntryInput } from "./portal.rental-entries.validation";

export type RentalEntryCtx = { orgId: string; agentPartyId: string; actorUserId: string };

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

export async function createRentalEntryService(
  input: CreateRentalEntryInput,
  ctx: RentalEntryCtx,
): Promise<Result<{
  unit: { id: string; propertyId: string; unitCode: string; sourcingApproved: boolean; listingStatus: string };
}>> {
  const db = getDb();
  return db.$transaction(async (tx: any) => {
    // 1. Verify Property exists and is in this org.
    const property = await tx.property.findFirst({
      where: { id: input.propertyId, organizationId: ctx.orgId },
      select: { id: true },
    });
    if (!property) {
      return {
        ok: false as const,
        status: 404 as const,
        error: { code: "property_not_found", message: "Property not found in this organization. Ask an admin to create it first." },
      };
    }

    // 2. Uniqueness check: (organizationId, propertyId, unitCode, unitType) per schema @@unique.
    const collision = await tx.unit.findFirst({
      where: {
        organizationId: ctx.orgId,
        propertyId: input.propertyId,
        unitCode: input.unitCode,
        unitType: input.unitType,
      },
      select: { id: true },
    });
    if (collision) {
      return {
        ok: false as const,
        status: 409 as const,
        error: { code: "unit_code_already_exists", message: "A unit with this code already exists for this property and type." },
      };
    }

    // 3. Create Unit (server-forced agent-sourcing flags).
    const unit = await tx.unit.create({
      data: {
        organizationId: ctx.orgId,
        propertyId: input.propertyId,
        unitCode: input.unitCode,
        unitType: input.unitType,
        bedrooms: input.bedrooms ?? null,
        bathrooms: input.bathrooms ?? null,
        floorArea: input.floorArea ?? null,
        sizeSqft: input.sizeSqft ?? null,
        floor: input.floor ?? null,
        facing: input.facing ?? null,
        furnishingLevel: input.furnishingLevel ?? null,
        baseRentAmount: input.baseRentAmount ?? null,
        rentalRate: input.rentalRate ?? null,
        depositMonths: input.depositMonths,
        utilitiesDepositMonths: input.utilitiesDepositMonths,
        // Phase 1 lockdown: source-queue UI has no amenity Combobox yet, so we
        // hardcode []. Validator already restricts input to catalog UUIDs;
        // ignoring it here is belt-and-braces. Lift when picker ships.
        amenities: [],
        publishedTitle: input.publishedTitle ?? null,
        publishedDescription: input.publishedDescription ?? null,
        photoKeys: input.photoKeys ?? [],
        videoKeys: input.videoKeys ?? [],
        currency: "MYR",
        // Server-forced agent-sourcing policies:
        sourceFlag: "AGENT_SOURCED",
        sourcingAgentId: ctx.agentPartyId,
        inChargePartyId: ctx.agentPartyId,
        sourcingApproved: false,
        listingStatus: "draft",
        occupancyStatus: "vacant",
        visibilityMode: "PRIVATE",
      },
      select: {
        id: true,
        propertyId: true,
        unitCode: true,
        sourcingApproved: true,
        listingStatus: true,
      },
    });

    return { ok: true as const, data: { unit } };
  });
}
