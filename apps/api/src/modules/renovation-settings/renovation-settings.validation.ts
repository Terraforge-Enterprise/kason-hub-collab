import { z } from "zod";

/**
 * The four label categories that drive renovation-claim UI dropdowns. The
 * underlying state-machine *codes* (claim_status / renovation_status) are
 * still hardcoded; only user-visible *labels* live in `SettingsLabel` and
 * are administered through this module.
 */
export const labelCategoryEnum = z.enum([
  "claim_status",
  "renovation_status",
  "document_kind",
  "payment_type",
]);

export type LabelCategory = z.infer<typeof labelCategoryEnum>;

export const createLabelSchema = z
  .object({
    category: labelCategoryEnum,
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/i, "key must be alphanumeric, dash or underscore"),
    label: z.string().min(1).max(120),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

/**
 * `category` and `key` are intentionally absent — both are immutable. To
 * change them, delete and re-create the label. The Zod `.strict()` modifier
 * causes any attempt to PATCH them to fail with 400.
 */
export const updateLabelSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
