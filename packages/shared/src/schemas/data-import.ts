import { z } from "zod";

export const runImportRequestSchema = z.object({
  dryRun: z.boolean().default(true),
});
export type RunImportRequest = z.infer<typeof runImportRequestSchema>;
