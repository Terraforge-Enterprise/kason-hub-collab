// apps/api/src/modules/reservations/validation.ts

import { z } from "zod";

const decimalString = z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a non-negative decimal");

export const RESERVATION_DOC_KINDS = [
  "passport_front",
  "passport_back",
  "ic_front",
  "ic_back",
] as const;
export const docKindSchema = z.enum(RESERVATION_DOC_KINDS);

const uploadMimeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/pdf",
]);

export const uploadUrlSchema = z.object({
  kind: docKindSchema,
  contentType: uploadMimeSchema,
  filename: z.string().trim().min(1).max(200),
});

export const markUploadedSchema = z.object({
  kind: docKindSchema,
  filename: z.string().trim().min(1).max(200),
});

export const createReservationSchema = z.object({
  propertyId: z.string().uuid(),
  unitId: z.string().uuid(),
  carPark: z.string().trim().max(40).nullish(),
  proposedMoveIn: z.string().datetime(),
  proposedMoveOut: z.string().datetime().nullish(),
  specialRemarks: z.string().trim().max(2000).nullish(),
  reservationDeposit: decimalString,
  documentationFee: decimalString,
  rentalDeposit: decimalString,
  utilityDeposit: decimalString,
  accessCardDeposit: decimalString,
  customerEmail: z.string().trim().email(),
  agreedMonthlyRent: decimalString,
  // Per-reservation T&C list. Empty array = use the bundled defaults
  // unchanged (no approval needed). Any non-empty list = manager approval
  // required, list rendered verbatim in the order given.
  customTerms: z
    .array(z.string().trim().min(1).max(2000))
    .max(50)
    .default([]),
});

export const cancelReservationSchema = z.object({
  cancelReason: z.string().trim().min(1).max(500),
});

export const fillReservationSchema = z.object({
  applicantFullName: z.string().trim().min(1).max(120),
  applicantNric: z.string().trim().min(1).max(40),
  applicantContact: z.string().trim().min(1).max(40),
  applicantEmail: z.string().trim().email(),
  // Tenant's own home / correspondence address (NOT the KAEN unit being
  // rented — that is unitId). Line2 optional; the rest required. Country
  // defaults to Malaysia. Bounds guard the unauthenticated public payload.
  applicantAddressLine1: z.string().trim().min(1).max(120),
  applicantAddressLine2: z.string().trim().max(120).optional(),
  applicantCity: z.string().trim().min(1).max(60),
  applicantPostcode: z.string().trim().min(1).max(10),
  applicantState: z.string().trim().min(1).max(60),
  applicantCountry: z.string().trim().min(1).max(60).default("Malaysia"),
  // New Section-B profile fields. nationality + emergency name/phone required;
  // relation/occupation/income optional. monthlyIncome reuses decimalString.
  nationality: z.string().trim().min(1).max(60),
  emergencyContactName: z.string().trim().min(1).max(120),
  emergencyContactPhone: z.string().trim().min(1).max(40),
  emergencyContactRelation: z.string().trim().max(40).optional(),
  occupation: z.string().trim().max(120).optional(),
  monthlyIncome: decimalString.optional(),
});

export const signReservationSchema = z.object({
  typedName: z.string().trim().min(1).max(120),
  agreementTicked: z.literal(true),
  // Bound the data-URL length before it is buffered + sharp-decoded on the
  // UNAUTHENTICATED public sign endpoint — an unbounded value lets a token
  // holder POST a huge body to pressure memory. ~2 MB of base64 (~1.5 MB PNG)
  // is far above any real hand-drawn signature; .max() is listed before the
  // regex so an oversized payload is rejected on length first.
  signaturePngBase64: z
    .string()
    .max(2_000_000, "Signature image is too large")
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
});

export const tokenParamSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});

export const approveReservationSchema = z.object({});

export const rejectReservationSchema = z.object({
  note: z.string().min(1).max(2000),
});

export const resubmitReservationSchema = z.object({
  customTerms: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  // Optional fix-ups while resubmitting. Per client feedback batch 1 (D5):
  // the dialog now exposes every editable field so the agent doesn't have to
  // re-create the row to fix one typo. Applicant fields are typically filled
  // by the tenant during Section B, but the agent may pre-fill on their behalf.
  // signed-edit reset flow (D2) needs `reason` ≥10 chars; pre-sign edits don't.
  carPark: z.string().nullable().optional(),
  proposedMoveIn: z.string().datetime().optional(),
  proposedMoveOut: z.string().datetime().nullable().optional(),
  specialRemarks: z.string().nullable().optional(),
  reservationDeposit: decimalString.optional(),
  documentationFee: decimalString.optional(),
  rentalDeposit: decimalString.optional(),
  utilityDeposit: decimalString.optional(),
  accessCardDeposit: decimalString.optional(),
  applicantFullName: z.string().trim().min(1).max(120).optional(),
  applicantNric: z.string().trim().min(1).max(40).optional(),
  applicantContact: z.string().trim().min(1).max(40).optional(),
  applicantEmail: z.string().trim().email().optional(),
  nationality: z.string().trim().min(1).max(60).optional(),
  emergencyContactName: z.string().trim().min(1).max(120).optional(),
  emergencyContactPhone: z.string().trim().min(1).max(40).optional(),
  emergencyContactRelation: z.string().trim().max(40).optional(),
  occupation: z.string().trim().max(120).optional(),
  monthlyIncome: decimalString.optional(),
  reason: z.string().trim().min(10, "Reason must be at least 10 characters.").optional(),
});

// Admin post-signing edit. All `patch` fields are optional — only the fields
// the admin chooses to change are sent. Reason is mandatory (≥10 chars) and
// surfaces verbatim in the AuditLog row's `meta.reason`. customTerms and the
// signed-PDF artifact are intentionally NOT editable here: the customer's
// agreed-to T&Cs and signed PDF blob are part of the legal record. Typo
// corrections on identity/charges/dates are in scope; clause changes are not.
export const adminEditReservationSchema = z.object({
  patch: z.object({
    carPark: z.string().trim().max(40).nullable().optional(),
    proposedMoveIn: z.string().datetime().optional(),
    proposedMoveOut: z.string().datetime().nullable().optional(),
    specialRemarks: z.string().trim().max(2000).nullable().optional(),
    reservationDeposit: decimalString.optional(),
    documentationFee: decimalString.optional(),
    rentalDeposit: decimalString.optional(),
    utilityDeposit: decimalString.optional(),
    accessCardDeposit: decimalString.optional(),
    applicantFullName: z.string().trim().min(1).max(120).optional(),
    applicantNric: z.string().trim().min(1).max(40).optional(),
    applicantContact: z.string().trim().min(1).max(40).optional(),
    applicantEmail: z.string().trim().email().optional(),
    nationality: z.string().trim().min(1).max(60).optional(),
    emergencyContactName: z.string().trim().min(1).max(120).optional(),
    emergencyContactPhone: z.string().trim().min(1).max(40).optional(),
    emergencyContactRelation: z.string().trim().max(40).optional(),
    occupation: z.string().trim().max(120).optional(),
    monthlyIncome: decimalString.optional(),
    // D5: admin needs to edit the T&C list too — previously only the agent
    // could touch this via resubmit. customTerms is the array of clauses
    // shown verbatim on the signed PDF; an empty array means "use the
    // bundled defaults".
    customTerms: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  }),
  reason: z.string().trim().min(10, "Reason must be at least 10 characters."),
});
