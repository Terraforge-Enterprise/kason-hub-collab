import type { z } from "zod";
import type {
  createProjectSchema,
  listProjectsQuery,
  updateProjectSchema,
} from "./projects.validation";

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuery>;

/**
 * Slim Project row exposed by the Projects API. Mirrors the Prisma model
 * minus internal columns (createdById is included for audit but rarely
 * shown in UI).
 *
 * `status` semantics:
 *  - "active"     — manager-blessed, ready for SalesUnit creation against it.
 *  - "unverified" — created via the agent portal, awaits manager promotion.
 *                   Managers promote with `PATCH /api/projects/:id { status: "active" }`.
 *  - "archived"   — soft-archived; hidden from active pickers.
 */
export interface ProjectRow {
  id: string;
  organizationId: string;
  name: string;
  developer: string;
  city: string | null;
  expectedHandover: Date | null;
  status: string;
  promotedPropertyId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string | null;
}
