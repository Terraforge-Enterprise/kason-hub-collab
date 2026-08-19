import { z } from "zod";

export const CARPARK_STATUSES = ["available", "rented", "inactive"] as const;
export type CarparkStatus = (typeof CARPARK_STATUSES)[number];

export const createCarparkSchema = z.object({
  apartmentId: z.string().uuid(),
  label: z.string().min(1),
  monthlyRate: z.string().min(1), // Decimal-as-string, matches Tenancy.monthlyRentAmount edge
  notes: z.string().optional(),
});

export const updateCarparkSchema = z.object({
  carparkId: z.string().uuid(),
  label: z.string().min(1).optional(),
  monthlyRate: z.string().min(1).optional(),
  status: z.enum(CARPARK_STATUSES).optional(),
  notes: z.string().optional(),
});

/** One bay to attach to a tenancy, with an optional per-deal charge override. */
export const carparkAssignmentInputSchema = z.object({
  carparkId: z.string().uuid(),
  monthlyCharge: z.string().min(1).optional(), // defaults to the bay's monthlyRate server-side
});

export const assignCarparkSchema = z.object({
  tenancyId: z.string().uuid(),
  carparks: z.array(carparkAssignmentInputSchema).min(1),
});

export const releaseCarparkAssignmentSchema = z.object({
  assignmentId: z.string().uuid(),
});

export type CreateCarparkInput = z.infer<typeof createCarparkSchema>;
export type UpdateCarparkInput = z.infer<typeof updateCarparkSchema>;
export type AssignCarparkInput = z.infer<typeof assignCarparkSchema>;
