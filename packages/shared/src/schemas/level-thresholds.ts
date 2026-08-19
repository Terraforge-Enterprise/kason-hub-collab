import { z } from "zod";

export const agentLevelEnum = z.enum(["new_agent", "pre_leader", "leader"]);

const decimalAmountRegex = /^\d{1,10}(\.\d{1,2})?$/;

export const updateLevelThresholdSchema = z.object({
  agentLevel: agentLevelEnum,
  minCumulativeCommission: z
    .string()
    .regex(decimalAmountRegex, "Must be a non-negative decimal with up to 2 decimal places"),
  updatedAt: z.string().datetime(),
});

export const levelThresholdPreviewSchema = z.object({
  agentLevel: agentLevelEnum,
  minCumulativeCommission: z.string().regex(decimalAmountRegex),
});

export type AgentLevel = z.infer<typeof agentLevelEnum>;
export type UpdateLevelThresholdInput = z.infer<typeof updateLevelThresholdSchema>;
export type LevelThresholdPreviewInput = z.infer<typeof levelThresholdPreviewSchema>;
