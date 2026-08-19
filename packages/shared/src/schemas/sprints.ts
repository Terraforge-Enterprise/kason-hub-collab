import { z } from "zod";

export const sprintStatusEnum = z.enum(["planned", "active", "completed"]);

// Create a planned sprint. seq is server-assigned; status is always "planned".
export const createSprintSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    goal: z.string().max(2000).optional(),
    startsOn: z.string().datetime().optional(),
    endsOn: z.string().datetime().optional(),
  })
  .strict();

// Edit metadata of a planned/active sprint. updatedAt = optimistic-lock token.
export const updateSprintSchema = z
  .object({
    sprintId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    name: z.string().min(1).max(100).nullable().optional(),
    goal: z.string().max(2000).nullable().optional(),
    startsOn: z.string().datetime().nullable().optional(),
    endsOn: z.string().datetime().nullable().optional(),
  })
  .strict();

// Used by BOTH start and close (they need only id + concurrency token).
export const sprintLifecycleSchema = z
  .object({ sprintId: z.string().uuid(), updatedAt: z.string().datetime() })
  .strict();

export const listSprintsQuerySchema = z
  .object({ status: sprintStatusEnum.optional() })
  .strict();

export const sprintVelocityQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).optional() })
  .strict();

// Cross-sprint trends window (Spec 3 §7). `window` = last N completed sprints
// (default 8, max 50) — supersedes Spec 1's velocity endpoint.
export const sprintTrendsQuerySchema = z
  .object({ window: z.coerce.number().int().min(1).max(50).optional() })
  .strict();

export type SprintStatus = z.infer<typeof sprintStatusEnum>;
export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
export type SprintLifecycleInput = z.infer<typeof sprintLifecycleSchema>;
export type ListSprintsQueryInput = z.infer<typeof listSprintsQuerySchema>;
export type SprintVelocityQueryInput = z.infer<typeof sprintVelocityQuerySchema>;
export type SprintTrendsQueryInput = z.infer<typeof sprintTrendsQuerySchema>;
