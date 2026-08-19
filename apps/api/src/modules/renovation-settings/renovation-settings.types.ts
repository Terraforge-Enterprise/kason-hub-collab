import type { z } from "zod";
import type {
  createLabelSchema,
  labelCategoryEnum,
  updateLabelSchema,
} from "./renovation-settings.validation";

export type LabelCategory = z.infer<typeof labelCategoryEnum>;
export type CreateLabelInput = z.infer<typeof createLabelSchema>;
export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export interface SettingsLabelRow {
  id: string;
  organizationId: string;
  category: LabelCategory;
  key: string;
  label: string;
  sortOrder: number;
}

/**
 * Frontend session-cache shape — every category present, sorted by
 * `sortOrder` ASC. Empty arrays are returned for categories that happen to
 * have zero rows so the client never has to null-check the bucket.
 */
export interface GroupedLabels {
  claim_status: SettingsLabelRow[];
  renovation_status: SettingsLabelRow[];
  document_kind: SettingsLabelRow[];
  payment_type: SettingsLabelRow[];
}
