import { z } from "zod";
import { optionalPhoneSchema } from "./phone";

const moneyString = z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a money amount");
const positiveMoneyString = moneyString.refine((v) => Number(v) > 0, "Must be > 0");

export const claimTypeEnum = z.enum([
  "tenant_portion",
  "listing_portion",
  "tenant_listing_portion",
]);

// ── Agent Tier Mapping CRUD ──────────────────────────────────────────────────

export const createTierMappingSchema = z.object({
  claimType: claimTypeEnum,
  agentLevel: z.enum(["new_agent", "pre_leader", "leader"]),
  percentage: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid percentage").refine(
    (v) => { const n = parseFloat(v); return n > 0 && n <= 100; },
    "Percentage must be between 0 and 100",
  ),
});

export const updateTierMappingSchema = z.object({
  updatedAt: z.string().datetime(),
  percentage: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid percentage").refine(
    (v) => { const n = parseFloat(v); return n > 0 && n <= 100; },
    "Percentage must be between 0 and 100",
  ).optional(),
  isActive: z.boolean().optional(),
});

// ── Claim creation (portal agent) ────────────────────────────────────────────

export const commissionClaimItemSubmitSchema = z.object({
    propertyId: z.string().uuid(),
    condoName: z.string().trim().min(1),
    unitCode: z.string().trim().min(1),
    roomType: z.string().trim().min(1),
    tenantName: z.string().trim().min(1),
    tenantEmail: z
      .string()
      .trim()
      .max(254)
      .email("Invalid email format")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    tenantPhone: optionalPhoneSchema,
    tenantLinkedinUrl: z
      .string()
      .trim()
      .max(500)
      .url()
      .refine(
        (url) => /https?:\/\/(www\.)?linkedin\.com\//i.test(url),
        { message: "Must be a LinkedIn URL" },
      )
      .optional()
      .or(z.literal("").transform(() => undefined)),
    tenantInstagramHandle: z
      .string()
      .trim()
      .max(31)
      .transform((s) => s.replace(/^@/, ""))
      .refine((s) => s === "" || /^[a-zA-Z0-9._]+$/.test(s), {
        message: "Instagram handle may only contain letters, digits, _ and .",
      })
      .optional()
      .or(z.literal("").transform(() => undefined)),
    tenantJobPosition: z
      .string()
      .trim()
      .max(200)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    tenantIcFrontKey: z.string().max(500).optional(),
    tenantIcBackKey: z.string().max(500).optional(),
    salesDate: z.string().trim().min(1).regex(/^\d{4}-\d{2}-\d{2}/, "Invalid sales date"),
    moveInDate: z.string().trim().min(1).regex(/^\d{4}-\d{2}-\d{2}/, "Invalid move-in date"),
    moveOutDate: z.string().trim().min(1).regex(/^\d{4}-\d{2}-\d{2}/, "Invalid move-out date"),
    monthlyRental: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount").refine(
      (v) => parseFloat(v) > 0,
      "Monthly rental must be greater than 0",
    ),
    commissionPercentage: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid percentage").refine(
      (v) => { const n = parseFloat(v); return n >= 0 && n <= 100; },
      "Commission must be between 0% and 100%",
    ),
    hasCobrokeIntent: z.boolean().optional().default(false),
    taSharePercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a money amount").optional(),
    // NOTE: display label on the agent form is "Tenancy Agreement Charged to Tenant".
    // DB column name intentionally unchanged to avoid a rename migration.
    tenancyChargesByAgent: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount").refine(
      (v) => parseFloat(v) >= 0,
      "Tenancy charges must be 0 or greater",
    ),
    // Allowed to be 0 for listing_portion claims (passive income — TA flows
    // through the tenant-side claim). For tenant_portion + tenant_listing_
    // portion the > 0 guard is enforced in the schema-level superRefine
    // below so it can read claimType from the parent object.
    tenancyChargesByKaen: moneyString,
    numberOfPax: z.number().int().positive().optional(),
    remark: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => v.length <= 1000, "Remark must be 1000 characters or fewer")
      .transform((v) => (v.length === 0 ? undefined : v))
      .optional(),
});

export const createClaimSchema = z.object({
  claimType: claimTypeEnum,
  items: z.array(commissionClaimItemSubmitSchema).min(1).max(50),
}).superRefine((data, ctx) => {
  if (!Array.isArray(data.items)) return;
  data.items.forEach((item, idx) => {
    // Cobroke intent requires taSharePercent (applies to all claim types).
    if (item.hasCobrokeIntent === true) {
      if (item.taSharePercent == null || Number(item.taSharePercent) <= 0 || Number(item.taSharePercent) > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", idx, "taSharePercent"],
          message: "Cobroke items require a TA share between 0 and 100.",
        });
      }
    }
    // Tenant-side claims must declare positive TA charges (matches the
    // assertTaTierMatch + UI required marker). Listing-portion is passive
    // income — both TA fields may legitimately be 0.
    if (data.claimType !== "listing_portion") {
      if (item.tenancyChargesByKaen != null && Number(item.tenancyChargesByKaen) <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", idx, "tenancyChargesByKaen"],
          message: "Must be > 0",
        });
      }
    }
    // Sales must close on or before the tenant moves in. Compare on the
    // YYYY-MM-DD prefix: ISO date strings are lexicographically ordered, so
    // string compare is safe and timezone-free. Both fields are guaranteed
    // to start with `\d{4}-\d{2}-\d{2}` by the field-level regex above.
    if (item.salesDate && item.moveInDate) {
      const sale = item.salesDate.slice(0, 10);
      const move = item.moveInDate.slice(0, 10);
      if (sale > move) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", idx, "salesDate"],
          message: "Sales date cannot be after the move-in date.",
        });
      }
    }
    // Move-out must be strictly after move-in. End-of-tenancy date is
    // captured at submit time (typically lease-expiry); zero-day tenancies
    // are not a real-world case for this form.
    if (item.moveInDate && item.moveOutDate) {
      const moveIn = item.moveInDate.slice(0, 10);
      const moveOut = item.moveOutDate.slice(0, 10);
      if (moveOut <= moveIn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", idx, "moveOutDate"],
          message: "Move-out date must be after the move-in date.",
        });
      }
    }
  });
});

// ── Room Type CRUD (global — no propertyId) ──────────────────────────────────

export const roomTypeKindSchema = z.enum(["WHOLE", "PARTITION"]);
export type RoomTypeKind = z.infer<typeof roomTypeKindSchema>;

export const createRoomTypeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: roomTypeKindSchema.optional(), // server defaults to "PARTITION"
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateRoomTypeSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  kind: roomTypeKindSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
}).strict();

// ── Claim workflow (unchanged) ───────────────────────────────────────────────

export const approveClaimSchema = z.object({
  dueDate: z.string().optional(),
});

export const rejectClaimSchema = z.object({
  reason: z.string().min(3),
});

export const payClaimSchema = z.object({
  movementDate: z.string().min(1),
  paymentTender: z.string().min(1),
  notes: z.string().optional(),
});

export const bulkApproveClaimsSchema = z.object({
  claimIds: z.array(z.string().uuid()).min(1).max(500),
});

// ── Save-as-Draft (permissive) ──────────────────────────────────────────────
// A permissive variant of createClaimSchema for partial-fill drafts:
//   - Only propertyId is required per item (FK is NOT NULL in the DB).
//   - All other fields are optional. Missing/empty values get safe server-side
//     defaults: "" for free text, "0" for decimals, 1970-01-01 for dates.
//   - Rule B / Rule C do NOT run on save; the sum cap applies at submit time.
//   - Rule A (intra-payload dedupe) still runs — catches obvious duplicates.
export const saveDraftSchema = z.object({
  claimType: claimTypeEnum,
  items: z.array(z.object({
    propertyId: z.string().uuid(),
    condoName: z.string().trim().optional(),
    unitCode: z.string().trim().optional(),
    roomType: z.string().trim().optional(),
    tenantName: z.string().trim().optional(),
    tenantEmail: z.string().trim().max(254).email("Invalid email format").optional().or(z.literal("").transform(() => undefined)),
    tenantPhone: optionalPhoneSchema,
    tenantLinkedinUrl: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
    tenantInstagramHandle: z.string().trim().max(31).optional().or(z.literal("").transform(() => undefined)),
    tenantJobPosition: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
    tenantIcFrontKey: z.string().max(500).optional(),
    tenantIcBackKey: z.string().max(500).optional(),
    salesDate: z.string().trim().optional(),
    moveInDate: z.string().trim().optional(),
    moveOutDate: z.string().trim().optional(),
    monthlyRental: z.string().optional(),
    commissionPercentage: z.string().optional(),
    hasCobrokeIntent: z.boolean().optional().default(false),
    taSharePercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a money amount").optional(),
    tenancyChargesByAgent: z.string().optional(),
    tenancyChargesByKaen: z.string().optional(),
    numberOfPax: z.number().int().positive().optional(),
    remark: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => v.length <= 1000, "Remark must be 1000 characters or fewer")
      .transform((v) => (v.length === 0 ? undefined : v))
      .optional(),
  })).min(1).max(50),
}).superRefine((data, ctx) => {
  if (!Array.isArray(data.items)) return;
  data.items.forEach((item, idx) => {
    if (item.hasCobrokeIntent === true) {
      if (item.taSharePercent == null || Number(item.taSharePercent) <= 0 || Number(item.taSharePercent) > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", idx, "taSharePercent"],
          message: "Cobroke items require a TA share between 0 and 100.",
        });
      }
    }
  });
});

// PATCH /claims/:id uses the same permissive shape — users editing an
// existing draft should not be forced to fill every field before saving.
export const updateDraftSchema = saveDraftSchema;

// Error-code union — re-exported for the web client to switch on rather
// than string-match messages. Kept in sync with the API-side
// ClaimErrorCode at apps/api/src/modules/portal/commissions/claim-errors.ts.
export type ClaimErrorCode =
  | "rule_a_duplicate"
  | "rule_b_same_agent_active"
  | "rule_c_sum_exceeded"
  | "validation"
  | "forbidden_transition"
  | "not_found"
  | "conflict"
  | "internal";
