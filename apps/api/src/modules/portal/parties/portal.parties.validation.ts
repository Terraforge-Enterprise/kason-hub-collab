import { z } from "zod";
import { optionalPhoneSchema } from "@kason/shared";

export const ownerSearchQuery = z
  .object({
    q: z.string().trim().max(120).default(""),
  });

export const createOwnerSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    primaryPhone: optionalPhoneSchema,
    primaryEmail: z.string().trim().email().max(120).optional(),
  })
  .strict();

export type CreateOwnerInput = z.infer<typeof createOwnerSchema>;
