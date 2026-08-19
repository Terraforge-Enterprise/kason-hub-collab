import { z } from "zod";

export const createListingSchema = z.object({
  propertyId: z.string().uuid(),
  // buildingId is no longer a Listing column post-refactor (buildings are
  // property-scoped). The field is accepted at the API edge for back-compat
  // but the service layer ignores it; remove from clients in Phase C.
  buildingId: z.string().uuid().optional(),
  unitCode: z.string().min(1),
  unitType: z.string().min(1),
  photoKeys: z.array(z.string()).default([]),
  videoKeys: z.array(z.string()).default([]),
  moveInDate: z.string().datetime().optional(),
  readyNow: z.boolean().default(false),
  inChargeName: z.string().optional(),
  inChargePartyId: z.string().uuid().optional(),
  // sourceFlag is no longer a stored column. Accepted at the API edge for
  // back-compat; admin creates produce COMPANY rows regardless, and
  // sourcingAgentId is the only signal the service uses.
  sourceFlag: z.enum(["COMPANY", "AGENT_SOURCED"]).default("COMPANY"),
  sourcingAgentId: z.string().uuid().optional(),
  visibilityMode: z.enum(["PUBLIC", "RESTRICTED"]).default("PUBLIC"),
  hiddenFromPartyIds: z.array(z.string().uuid()).default([]),
  rentalRate: z.number().optional(),
  bedrooms: z.number().int().optional(),
  bathrooms: z.number().optional(),
  floorArea: z.number().optional(),
});

export const updateListingSchema = createListingSchema.partial();

export const mediaUploadUrlSchema = z.object({
  kind: z.enum(["photo", "video"]),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
});

export const mediaCompleteSchema = z.object({
  storageKey: z.string().min(1).max(512),
});

export const listListingsQuery = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  visibilityMode: z.enum(["PUBLIC", "RESTRICTED"]).optional(),
});
