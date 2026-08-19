import { z } from "zod";

export const createAmenitySchema = z.object({
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict();

export const updateAmenitySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
}).strict();

export type CreateAmenityInput = z.infer<typeof createAmenitySchema>;
export type UpdateAmenityInput = z.infer<typeof updateAmenitySchema>;
