import { z } from "zod";

export const updateOrgCardSettingsSchema = z.object({
  agencyName: z.string().min(1).max(100).optional().nullable(),
  agencyLicense: z.string().min(1).max(50).optional().nullable(),
  agencyPhone: z.string().max(50).optional().nullable(),
  agencyFax: z.string().max(50).optional().nullable(),
  addressLine1: z.string().min(1).max(200).optional().nullable(),
  addressLine2: z.string().max(200).optional().nullable(),
  addressLine3: z.string().max(200).optional().nullable(),
  addressLine4: z.string().max(200).optional().nullable(),
  cardExpiryMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]).optional(),
  // Printed on document headers (reservation form, invoice) when set. Falls
  // back to Organization.name. Lets the workspace display name and the
  // legal entity name diverge ("KAEN Properties" vs "KAEN PROPERTIES
  // MANAGEMENT SDN BHD").
  legalEntityName: z.string().max(200).optional().nullable(),
});

export type UpdateOrgCardSettingsInput = z.infer<typeof updateOrgCardSettingsSchema>;

// Required fields that must ALL be non-null for isConfigured to flip to true.
// brandName was REMOVED from the gate (2026-05-05) — the logo carries the brand;
// the column remains in the schema for back-compat but the form/render no
// longer surfaces it.
export const REQUIRED_FOR_CONFIGURED = [
  "agencyName",
  "agencyLicense",
  "addressLine1",
] as const;
