import { z } from "zod";

// `status` set:
//   active     — manager-blessed default
//   unverified — created via agent portal, waiting for manager promote
//   archived   — soft-archive, hidden from active pickers
export const projectStatus = z.enum(["active", "unverified", "archived"]);

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    developer: z.string().min(1).max(200),
    city: z.string().max(120).optional(),
    expectedHandover: z.string().datetime().optional(),
    status: projectStatus.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    developer: z.string().min(1).max(200).optional(),
    city: z.string().max(120).nullable().optional(),
    expectedHandover: z.string().datetime().nullable().optional(),
    status: projectStatus.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const listProjectsQuery = z
  .object({
    status: projectStatus.optional(),
    q: z.string().max(200).optional(),
  })
  .strict();
