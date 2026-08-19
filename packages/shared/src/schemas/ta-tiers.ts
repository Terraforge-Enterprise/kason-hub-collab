import { z } from "zod";

const decimalString = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/);

export const taTierSchema = z.object({
  id: z.string().uuid(),
  tier: z.number().int().min(1),
  rentalMin: decimalString,
  // `rentalMax` is the inclusive upper bound for this tier's rental band.
  // NULL means open-ended — the top tier catches all rentals above its
  // rentalMin. UI displays this as "—".
  rentalMax: decimalString.nullable().optional(),
  companyMinimum: decimalString,
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export const createTaTierSchema = z.object({
  tier: z.number().int().min(1),
  rentalMin: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Must be a positive decimal"),
  rentalMax: decimalString.nullable().optional(),
  companyMinimum: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Must be a positive decimal"),
});

export const updateTaTierSchema = z.object({
  rentalMin: decimalString.optional(),
  rentalMax: decimalString.nullable().optional(),
  companyMinimum: decimalString.optional(),
  updatedAt: z.string().datetime(),
});

export const taTierLookupQuerySchema = z.object({
  monthlyRental: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
});

export const taTierLookupResponseSchema = z.object({
  tier: z.number().int(),
  rentalMin: z.string(),
  rentalMax: z.string().nullable().optional(),
  companyMinimum: z.string(),
});

export type TaTierLookupResponse = z.infer<typeof taTierLookupResponseSchema>;

// ── /ta-tier-options ─────────────────────────────────────────────────────────
// Returns ALL tiers configured for the calling org. Used to populate the
// "Charges by KAEN" dropdown on the agent claim form so it stays in sync
// with admin-configured TA settings (no hardcoded list).

export const taTierOptionsResponseSchema = z.object({
  tiers: z.array(
    z.object({
      tier: z.number().int(),
      companyMinimum: z.string(),
    }),
  ),
});

export type TaTierOptionsResponse = z.infer<typeof taTierOptionsResponseSchema>;
