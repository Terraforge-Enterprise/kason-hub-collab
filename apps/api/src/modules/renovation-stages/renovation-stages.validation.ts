import { z } from "zod";

const slugRegex = /^[a-z0-9_-]+$/;

export const createStageSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const updateStageSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sortOrder: z.number().int().min(0).max(100).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const reorderStagesSchema = z
  .object({
    items: z
      .array(z.object({ id: z.string().uuid(), sortOrder: z.number().int().min(0).max(100) }))
      .min(1)
      .max(25),
  })
  .strict();

export const STAGE_CAP = 25;

/** Lowercase + slugify a label for the unique key. */
export function deriveStageKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export function isValidStageKey(key: string): boolean {
  return slugRegex.test(key) && key.length > 0 && key.length <= 60;
}
