// apps/api/src/modules/submissions/submission.schema.ts
import { z } from "zod";

// NOTE: photoKeys / videoKeys / coverPhotoKey are accepted here for wire
// back-compat with the agent-side submission UI, but they are physically
// stored on the per-room Listing now (spec 2026-05-24), not on the
// Apartment. submission.service routes them to the listing on apply.
export const apartmentSharedPayloadSchema = z.object({
  bedrooms: z.number().nullable().optional(),
  bathrooms: z.number().nullable().optional(),
  floorArea: z.number().nullable().optional(),
  floor: z.number().nullable().optional(),
  facing: z.string().nullable().optional(),
  furnishingLevel: z.string().nullable().optional(),
  amenities: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
  publishedDescription: z.string().nullable().optional(),
  publishedTitle: z.string().nullable().optional(),
  photoKeys: z.array(z.string()).optional(),
  coverPhotoKey: z.string().nullable().optional(),
  videoKeys: z.array(z.string()).optional(),
});

export const listingPayloadSchema = z.object({
  // Room-type rename (e.g. "Master" → "Small") rides through here as
  // `listingType` — splitToSubmissionPayload renames the input's `unitType`
  // to match the Listing column. Optional because most payloads don't touch
  // the type; without listing it explicitly, zod's default .strip() drops
  // unknown keys and the value silently disappears on resubmit, leaving the
  // amend approval to merge stale data into the approved Listing.
  listingType: z.string().optional(),
  rentalRate: z.number().nullable().optional(),
  depositMonths: z.number().nullable().optional(),
  utilitiesDepositMonths: z.number().nullable().optional(),
  accessCardDepositPerPcs: z.number().nullable().optional(),
  accessCardQuantity: z.number().nullable().optional(),
  parkingQuantity: z.number().nullable().optional(),
  parkingNumbers: z.array(z.string()).optional(),
  occupancyStatus: z.string().optional(),
  visibilityMode: z.enum(["PUBLIC", "RESTRICTED"]).optional(),
  hiddenFromPartyIds: z.array(z.string()).optional(),
  inChargePartyId: z.string().nullable().optional(),
  inChargeName: z.string().nullable().optional(),
  moveInDate: z.string().nullable().optional(),
});

export const unitSubmissionPayloadSchema = z.object({
  listing: listingPayloadSchema,
  apartmentShared: apartmentSharedPayloadSchema.optional(),
});

export type UnitSubmissionPayload = z.infer<typeof unitSubmissionPayloadSchema>;
export type ListingPayload = z.infer<typeof listingPayloadSchema>;
export type ApartmentSharedPayload = z.infer<typeof apartmentSharedPayloadSchema>;
