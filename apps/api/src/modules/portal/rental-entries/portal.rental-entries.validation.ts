import { z } from "zod";

export const createRentalEntrySchema = z
  .object({
    propertyId: z.string().uuid(),
    unitCode: z.string().trim().min(1).max(40),
    unitType: z.string().trim().min(1).max(40),
    bedrooms: z.number().int().min(0).max(20).optional(),
    bathrooms: z.number().min(0).max(20).optional(),
    floorArea: z.number().min(0).optional(),
    sizeSqft: z.number().min(0).optional(),
    floor: z.number().int().min(-5).max(200).optional(),
    facing: z.string().trim().max(40).optional(),
    furnishingLevel: z.string().trim().max(40).optional(),
    parkingLots: z.number().int().min(0).max(20).optional(),
    baseRentAmount: z.number().min(0).optional(),
    rentalRate: z.number().min(0).optional(),
    // depositMonths and utilitiesDepositMonths are required for every new
    // rental entry — the source-queue UI now collects both up front (no
    // silent default of 2 months). Decimal half-month values (0.5, 1.5)
    // are allowed to match the rest of the inventory pipeline.
    depositMonths: z.number().nonnegative().max(24),
    utilitiesDepositMonths: z.number().nonnegative().max(24),
    // Phase 1 lockdown: amenities must be catalog UUIDs only. The source-queue
    // UI does not yet ship a Combobox for amenity selection, so the service
    // forces an empty array regardless. This validator rejects free-text
    // amenities to prevent stale string-based clients from sneaking values
    // through. Lift this when source-queue UI ships an amenity picker.
    amenities: z.array(z.string().uuid()).max(50).default([]),
    publishedTitle: z.string().trim().max(200).optional(),
    publishedDescription: z.string().trim().max(2000).optional(),
    photoKeys: z.array(z.string().trim().max(500)).max(30).optional(),
    videoKeys: z.array(z.string().trim().max(500)).max(10).optional(),
  })
  .strict();

export type CreateRentalEntryInput = z.infer<typeof createRentalEntrySchema>;
