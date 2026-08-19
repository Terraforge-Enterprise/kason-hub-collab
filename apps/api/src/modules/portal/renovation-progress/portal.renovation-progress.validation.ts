import { z } from "zod";

export const flipStageSchema = z
  .object({
    status: z.enum(["pending", "in_progress", "completed"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type FlipStageInput = z.infer<typeof flipStageSchema>;
