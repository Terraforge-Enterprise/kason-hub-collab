import { z } from "zod";

export const createWorkCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict();

export const updateWorkCategorySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
}).strict();

export type CreateWorkCategoryInput = z.infer<typeof createWorkCategorySchema>;
export type UpdateWorkCategoryInput = z.infer<typeof updateWorkCategorySchema>;
