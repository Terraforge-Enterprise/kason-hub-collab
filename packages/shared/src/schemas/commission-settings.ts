import { z } from "zod";
import { taTierSchema } from "./ta-tiers";
import { roomTypeKindSchema } from "./commissions";

export const agentTierMappingSchema = z.object({
  id: z.string().uuid(),
  claimType: z.enum(["tenant_portion", "listing_portion"]),
  agentLevel: z.enum(["new_agent", "pre_leader", "leader"]),
  percentage: z.string(),
  isActive: z.boolean(),
  // Included so the consolidated Settings page can PUT with optimistic locking
  // without a round-trip to /commissions/tier-mappings.
  updatedAt: z.string().datetime().optional(),
});

export const roomTypeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: roomTypeKindSchema,
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  updatedAt: z.string().datetime().optional(),
});

export const levelThresholdSchema = z.object({
  id: z.string().uuid(),
  agentLevel: z.enum(["new_agent", "pre_leader", "leader"]),
  minCumulativeCommission: z.string(),
  // Required by PUT /commissions/level-thresholds/:level for optimistic locking.
  updatedAt: z.string().datetime().optional(),
});

export const commissionSettingsResponseSchema = z.object({
  tierMappings: z.array(agentTierMappingSchema),
  taTiers: z.array(taTierSchema),
  roomTypes: z.array(roomTypeSchema),
  levelThresholds: z.array(levelThresholdSchema),
});

export type CommissionSettingsResponse = z.infer<typeof commissionSettingsResponseSchema>;
