import { z } from "zod";

const money = z.string().min(1).regex(/^\d+(\.\d{1,2})?$/, "Must be a number with up to 2 decimals");

export const utilityBillingConfigSchema = z.object({
  subsidyPerPax: money,
});
export type UtilityBillingConfigInput = z.infer<typeof utilityBillingConfigSchema>;

export const partitionBillingModeSchema = z.enum(["SUBSIDY", "NO_SUBSIDY"]);
export type PartitionBillingMode = z.infer<typeof partitionBillingModeSchema>;
