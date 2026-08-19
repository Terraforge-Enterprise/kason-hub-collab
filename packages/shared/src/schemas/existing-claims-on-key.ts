import { z } from "zod";

export const existingClaimsOnKeyQuerySchema = z.object({
  propertyId: z.string().uuid(),
  unitCode: z.string().min(1),
  roomType: z.string().min(1),
  moveInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const existingClaimsOnKeyResponseSchema = z.object({
  count: z.number().int().min(0),
  totalAllocatedPct: z.string(),
  remainingPct: z.string(),
  hasCobrokePartner: z.boolean(),
  totalTaAllocatedPct: z.string(),
  remainingTaPct: z.string(),
});

export type ExistingClaimsOnKeyResponse = z.infer<typeof existingClaimsOnKeyResponseSchema>;
