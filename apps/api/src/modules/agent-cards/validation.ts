import { z } from "zod";
import { optionalPhoneSchema } from "@kason/shared";

/**
 * Admin-side input for creating a card version inline (e.g. during agent
 * creation when a `title` is supplied). The result is created as
 * `status='approved'` directly — no review step — because the admin is
 * doing the data entry. See spec §6.1, §8.
 *
 * Phase 4 will add additional schemas (approve/reject/regenerate/revoke).
 * This file is intentionally narrow until then.
 */
export const adminCreateCardSchema = z.object({
  partyId: z.string().uuid(),
  displayName: z.string().min(1).max(100),
  title: z.string().min(1).max(100),
  primaryEmail: z.string().email().max(254).optional().nullable(),
  primaryPhone: optionalPhoneSchema,
});

export type AdminCreateCardInput = z.infer<typeof adminCreateCardSchema>;

/**
 * Body for POST /api/agent-cards/version/:versionId/reject. Server-side
 * floor of 1 char (a free-text reason so the agent understands why) and a
 * ceiling of 500 chars to keep the audit log tidy.
 */
export const rejectVersionSchema = z.object({
  reason: z.string().min(1, "Reason required").max(500, "Reason too long"),
});

export type RejectVersionInput = z.infer<typeof rejectVersionSchema>;

/**
 * Query string for GET /api/agent-cards. Status filter is the union of
 * the three terminal/transitional states; pagination matches the rest of
 * the admin surfaces (default 50, max 100, offset >= 0).
 */
export const listVersionsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListVersionsQueryInput = z.infer<typeof listVersionsQuerySchema>;
