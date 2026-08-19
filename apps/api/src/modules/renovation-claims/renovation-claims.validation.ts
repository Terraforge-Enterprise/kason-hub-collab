import { z } from "zod";

export const splitTypeEnum = z.enum(["percent", "fixed"]);
export const paymentTypeEnum = z.enum(["full", "partial", "offset_from_rental"]);
export const documentKindEnum = z.enum([
  "quotation",
  "invoice",
  "agreement",
  // Visual evidence — agents attach photos so reviewers can verify the
  // work matches the claimed package. Optional today; the document gate
  // (≥1 quotation, ≥1 invoice) only checks the financial paperwork.
  "progress_photo",
  "before_photo",
  "after_photo",
  // Signed contract attachment, distinct from the proposal-level
  // "agreement" so an admin can tell signed paperwork apart at a glance.
  "contract",
]);
export const claimStatusEnum = z.enum([
  "submitted",
  "pending_approval",
  "approved",
  "rejected",
  "needs_amendment",
  // Terminal: agent withdrew before review, or admin cancelled.
  "cancelled",
]);

// ─── RenovationPackage validation ────────────────────────────────────────────

export const packageSplitSchema = z
  .object({
    roleLabel: z.string().min(1).max(100),
    splitType: splitTypeEnum,
    splitValue: z.number().nonnegative(),
    isHouseKeep: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export const createPackageSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/i, "key must be alphanumeric, dash or underscore"),
    label: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    defaultPrice: z.number().nonnegative(),
    archived: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
    defaultSplits: z.array(packageSplitSchema).optional(),
  })
  .strict();

export const updatePackageSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    defaultPrice: z.number().nonnegative().optional(),
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    defaultSplits: z.array(packageSplitSchema).optional(),
  })
  .strict();

export const listPackagesQuery = z
  .object({
    archived: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  })
  .strict();

// ─── RenovationClaim validation ──────────────────────────────────────────────

export const claimSplitSchema = z
  .object({
    partyPartyId: z.string().uuid().nullable().optional(),
    partyDisplayName: z.string().min(1).max(120),
    roleLabel: z.string().min(1).max(100),
    splitType: splitTypeEnum,
    splitValue: z.number().nonnegative(),
    isHouseKeep: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export const claimDocumentInputSchema = z
  .object({
    fileKey: z.string().min(1).max(500),
    kind: documentKindEnum,
    filename: z.string().min(1).max(255),
  })
  .strict();

export const createClaimSchema = z
  .object({
    salesUnitId: z.string().uuid(),
    packageId: z.string().uuid(),
    packagePrice: z.number().nonnegative(),
    paymentType: paymentTypeEnum,
    monthlyOffsetAmount: z.number().nonnegative().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    splits: z.array(claimSplitSchema).min(1),
    documents: z.array(claimDocumentInputSchema).min(1),
  })
  .strict();

export const updateClaimSchema = z
  .object({
    packageId: z.string().uuid().optional(),
    packagePrice: z.number().nonnegative().optional(),
    paymentType: paymentTypeEnum.optional(),
    monthlyOffsetAmount: z.number().nonnegative().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    splits: z.array(claimSplitSchema).min(1).optional(),
    // Document changes go through the dedicated upload/delete endpoints; this
    // schema does NOT accept a documents array. Client must call
    // mark-uploaded / delete to mutate the document set.
  })
  .strict();

export const listClaimsQuery = z
  .object({
    status: claimStatusEnum.optional(),
    salesUnitId: z.string().uuid().optional(),
    submittedById: z.string().uuid().optional(),
    submittedFrom: z.string().datetime().optional(),
    submittedTo: z.string().datetime().optional(),
  })
  .strict();

export const rejectSchema = z
  .object({
    note: z.string().min(1).max(2000),
  })
  .strict();

export const needsAmendmentSchema = rejectSchema;

// approve has no body fields — we keep the schema for symmetry & future-proof.
export const approveSchema = z.object({}).strict();

// ─── Document upload validation ──────────────────────────────────────────────

const ALLOWED_UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
] as const;

export const uploadUrlSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.enum(ALLOWED_UPLOAD_CONTENT_TYPES),
    claimId: z.string().uuid().optional(),
  })
  .strict();

export const documentMarkUploadedSchema = claimDocumentInputSchema;
