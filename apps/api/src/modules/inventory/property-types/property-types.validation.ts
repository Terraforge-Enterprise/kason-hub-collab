import { z } from "zod";

export const createPropertyTypeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict();

export const updatePropertyTypeSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
}).strict();

export type CreatePropertyTypeInput = z.infer<typeof createPropertyTypeSchema>;
export type UpdatePropertyTypeInput = z.infer<typeof updatePropertyTypeSchema>;
