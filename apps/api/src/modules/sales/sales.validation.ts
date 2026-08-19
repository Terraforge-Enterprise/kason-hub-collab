import { z } from "zod";

export const purposeEnum = z.enum(["rent", "own_stay"]);
// Schema-level constraints from the plan: bedrooms ∈ {-1 (Studio), 1, 2, 3, 4 (=4+)},
// bathrooms ∈ {1, 2, 3 (=3+)}.
const bedroomsSchema = z.number().int().refine((v) => v === -1 || (v >= 1 && v <= 4), {
  message: "bedrooms must be -1 (Studio) or 1..4 (4 = 4+)",
});
const bathroomsSchema = z.number().int().min(1).max(3);

export const createSalesUnitSchema = z
  .object({
    projectId: z.string().uuid(),
    unitNumber: z.string().min(1).max(50),
    ownerPartyId: z.string().uuid(),
    salesDate: z.string().datetime(),
    purpose: purposeEnum,
    bedrooms: bedroomsSchema,
    bathrooms: bathroomsSchema,
    parkingLots: z.number().int().min(0).max(20).default(0),
    expectedRental: z.number().nonnegative().optional(),
    purchasePrice: z.number().nonnegative(),
    // Admin path: agentPartyId required; portal path injects from session.
    agentPartyId: z.string().uuid().optional(),
    inChargePartyId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateSalesUnitSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    unitNumber: z.string().min(1).max(50).optional(),
    ownerPartyId: z.string().uuid().optional(),
    salesDate: z.string().datetime().optional(),
    purpose: purposeEnum.optional(),
    bedrooms: bedroomsSchema.optional(),
    bathrooms: bathroomsSchema.optional(),
    parkingLots: z.number().int().min(0).max(20).optional(),
    expectedRental: z.number().nonnegative().nullable().optional(),
    purchasePrice: z.number().nonnegative().optional(),
    inChargePartyId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const listSalesUnitsQuery = z
  .object({
    projectId: z.string().uuid().optional(),
    // Optional — query string `?sourcingApproved=true|false` mapped to boolean.
    sourcingApproved: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    salesDateFrom: z.string().datetime().optional(),
    salesDateTo: z.string().datetime().optional(),
    q: z.string().max(200).optional(),
  })
  .strict();

export const rejectSchema = z
  .object({
    note: z.string().min(1).max(2000),
  })
  .strict();

export const amendmentSchema = rejectSchema;

export const renovationStatusSchema = z
  .object({
    status: z.enum(["not_started", "on_going", "completed"]),
    startDate: z.string().datetime().nullable().optional(),
    expectedCompletion: z.string().datetime().nullable().optional(),
    actualCompletion: z.string().datetime().nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();
