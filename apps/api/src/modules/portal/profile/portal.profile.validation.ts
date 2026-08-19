import { z } from "zod";
import { optionalPhoneSchema } from "@kason/shared";

/**
 * PATCH /portal-api/profile/me — agent self-update.
 *
 * `phone` wraps optionalPhoneSchema with `.optional()` so a missing key
 * stays undefined (the empty-body refine relies on that). Supplying
 * `phone: ""` or `phone: null` still normalises to null, and any
 * non-empty input is canonicalised to "60XXXXXXXXX" or rejected with
 * the standard "Enter a valid Malaysian mobile number" error.
 */
export const updatePortalProfileSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    phone: optionalPhoneSchema.optional(),
    photoKey: z.string().nullable().optional(),
  })
  .refine(
    (d) => d.fullName !== undefined || d.phone !== undefined || d.photoKey !== undefined,
    { message: "At least one field must be provided" },
  );

export type UpdatePortalProfileInput = z.infer<typeof updatePortalProfileSchema>;
