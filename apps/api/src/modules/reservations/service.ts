import { randomBytes } from "node:crypto";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { UnitReservation } from "@prisma/client";
import { recordAudit } from "../../lib/audit";
import { maskIdNumber } from "../../lib/ic-reveal";
import { generateReferenceCodeTx } from "../../lib/reference-codes/generator";
import { RefPrefixUnconfiguredError } from "../../lib/reference-codes/errors";
import {
  createSignedDownloadUrl,
  deleteObject,
  putObject,
  requireBucket,
} from "../../lib/storage";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import { renderToHtml } from "../../lib/document-templates/render";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import {
  queueSignedConfirmationEmailTx,
  queueAgentNotifyEmailTx,
} from "./email";
import * as repo from "./repository";
import { canAgentSeeUnit } from "../listings/listings-visibility";
import { buildReservationBodyHtml } from "./render-body";
import type {
  ReservationDto,
  ReservationSession,
  ReservationStatus,
  SectionAInput,
  SectionBInput,
  SignInput,
} from "./types";
import type { z } from "zod";
import type {
  adminEditReservationSchema,
  resubmitReservationSchema,
} from "./validation";

class SignError extends Error {
  constructor(
    public readonly code: "EMPTY_SIGNATURE" | "NAME_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SignError";
  }
}

async function validateSignaturePng(b64DataUrl: string): Promise<Buffer> {
  const m = b64DataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new SignError("EMPTY_SIGNATURE", "Invalid signature image");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 200) throw new SignError("EMPTY_SIGNATURE", "Signature too small");
  const sharp = (await import("sharp")).default;
  const stats = await sharp(buf).stats();
  const minMean = Math.min(...stats.channels.slice(0, 3).map((c) => c.mean));
  if (minMean > 250) {
    throw new SignError("EMPTY_SIGNATURE", "Signature appears blank");
  }
  return buf;
}

export type ServiceResult<T> =
  | { ok: true; data: T; status: 200 | 201 }
  | { ok: false; error: string; status: 400 | 403 | 404 | 409 | 422; details?: unknown; code?: string };

export function needsApproval(input: SectionAInput): boolean {
  // Any non-empty list = a customised set, fires the manager gate.
  // Empty list = use bundled defaults verbatim, no approval.
  return (input.customTerms ?? []).length > 0;
}

export async function createReservationService(
  session: ReservationSession,
  input: SectionAInput,
): Promise<
  ServiceResult<{ id: string; referenceCode: string; publicToken: string; expiresAt: Date; status: ReservationStatus }>
> {
  if (session.role !== "agent" && session.role !== "admin") {
    return { ok: false, error: "Only agents or admins can create reservations", status: 403 };
  }

  const db = getDb();

  const unit = await repo.findUnitEligibilityFields(session.orgId, input.unitId);
  if (!unit || unit.propertyId !== input.propertyId) {
    return { ok: false, error: "Unit not found in this organization", status: 404 };
  }

  if (!unit.ownerPartyId) {
    return { ok: false as const, status: 409, code: "UNIT_HAS_NO_OWNER" as const, error: "This unit has no assigned owner. Assign an owner before issuing a reservation." };
  }

  // Agent reservations must target a ready-now active listing the agent can
  // see. Admins reserve from any unit in the org (the picker UX handles its
  // own filtering). Defence-in-depth — the portal picker only offers
  // eligible units, but a hand-crafted POST must not bypass the rule.
  if (session.role === "agent") {
    if (unit.listingStatus !== "active" || !unit.readyNow) {
      return {
        ok: false,
        error: "This unit is not a ready-now listing — reservations cannot be created.",
        status: 403,
      };
    }
    const grants = await repo.findAgentVisibilityGrants(session.orgId, session.partyId);
    const grantedSet = new Set(grants.map((g) => g.unitId));
    const visible = canAgentSeeUnit(
      {
        id: input.unitId,
        visibilityMode: unit.visibilityMode,
        hiddenFromPartyIds: unit.hiddenFromPartyIds,
        sourcingAgentId: unit.sourcingAgentId,
        inChargePartyId: unit.inChargePartyId,
      },
      session.partyId,
      grantedSet.has(input.unitId) ? [session.partyId] : [],
    );
    if (!visible) {
      return { ok: false, error: "Unit not available to this agent", status: 403 };
    }
  }

  const org = await db.organization.findUniqueOrThrow({
    where: { id: session.orgId },
    select: { reservationLinkExpiryDays: true },
  });
  const expiresAt = new Date(Date.now() + org.reservationLinkExpiryDays * 24 * 60 * 60 * 1000);

  const publicToken = randomBytes(16).toString("base64url");

  const approval = needsApproval(input);
  const initialStatus = approval ? "pending_approval" : "pending_customer";

  try {
    const result = await db.$transaction(async (tx) => {
      const referenceCode = await generateReferenceCodeTx(tx, session.orgId, "reservation_form");

      const reservation = await tx.unitReservation.create({
        data: {
          organizationId: session.orgId,
          referenceCode,
          status: initialStatus,
          issuedByPartyId: session.partyId,
          expiresAt,
          publicToken,
          propertyId: input.propertyId,
          unitId: input.unitId,
          carPark: input.carPark ?? null,
          proposedMoveIn: new Date(input.proposedMoveIn),
          proposedMoveOut: input.proposedMoveOut ? new Date(input.proposedMoveOut) : null,
          specialRemarks: input.specialRemarks ?? null,
          reservationDeposit: input.reservationDeposit,
          documentationFee: input.documentationFee,
          rentalDeposit: input.rentalDeposit,
          utilityDeposit: input.utilityDeposit,
          accessCardDeposit: input.accessCardDeposit,
          agreedMonthlyRent: input.agreedMonthlyRent,
          // Stored for record-keeping only. The sign-link is no longer
          // auto-emailed — the agent shares it manually from the reservation
          // detail page (Copy / WhatsApp / Download PDF).
          applicantEmail: input.customerEmail,
          customTerms: input.customTerms ?? [],
        },
      });

      await repo.insertTransitionTx(tx, {
        orgId: session.orgId,
        reservationId: reservation.id,
        fromStatus: null,
        toStatus: initialStatus,
        actor: `agent:${session.userId}`,
      });

      return reservation;
    });

    return {
      ok: true,
      data: {
        id: result.id,
        referenceCode: result.referenceCode,
        publicToken: result.publicToken,
        expiresAt: result.expiresAt,
        status: result.status as ReservationStatus,
      },
      status: 201,
    };
  } catch (err) {
    if (err instanceof RefPrefixUnconfiguredError) {
      return { ok: false, error: err.message, status: 422 };
    }
    throw err;
  }
}

export async function cancelReservationService(
  session: ReservationSession,
  id: string,
  cancelReason: string,
): Promise<ServiceResult<{ id: string; status: "cancelled" }>> {
  if (session.role === "viewer") return { ok: false, error: "Read-only role", status: 403 };

  return getDb().$transaction(async (tx) => {
    const reservation = await tx.unitReservation.findFirst({
      where: { id, organizationId: session.orgId },
    });
    if (!reservation) {
      return { ok: false, error: "Reservation not found", status: 404 as const };
    }
    const cancellable = new Set(["pending_customer", "pending_approval", "needs_amendment"]);
    if (!cancellable.has(reservation.status)) {
      return { ok: false, error: `Cannot cancel — current status: ${reservation.status}`, status: 409 };
    }
    if (session.role === "agent" && reservation.issuedByPartyId !== session.partyId) {
      return {
        ok: false,
        error: "Agents may only cancel their own reservations",
        status: 403 as const,
      };
    }

    await tx.unitReservation.update({
      where: { id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledById: session.userId,
        cancelReason,
      },
    });

    await repo.insertTransitionTx(tx, {
      orgId: session.orgId,
      reservationId: id,
      fromStatus: reservation.status,
      toStatus: "cancelled",
      actor: `${session.operatorRole ?? session.role}:${session.userId}`,
      note: cancelReason,
    });

    return {
      ok: true as const,
      data: { id, status: "cancelled" as const },
      status: 200 as const,
    };
  });
}

export async function approveReservationService(
  session: ReservationSession,
  id: string,
): Promise<ServiceResult<{ id: string; status: "pending_customer" }>> {
  if (session.role !== "admin") {
    return { ok: false, error: "Operators only", status: 403 };
  }
  if (session.operatorRole !== "admin" && session.operatorRole !== "manager") {
    return { ok: false, error: "Only managers or super admins may approve", status: 403 };
  }

  return getDb().$transaction(async (tx) => {
    const reservation = await tx.unitReservation.findFirst({
      where: { id, organizationId: session.orgId },
    });
    if (!reservation) return { ok: false, error: "Reservation not found", status: 404 as const };
    if (reservation.status !== "pending_approval") {
      return {
        ok: false,
        error: `Cannot approve — current status: ${reservation.status}`,
        status: 409 as const,
      };
    }
    await tx.unitReservation.update({
      where: { id },
      data: {
        status: "pending_customer",
        approvalReviewedAt: new Date(),
        approvalReviewedById: session.userId,
        approvalNote: null,
      },
    });

    await repo.insertTransitionTx(tx, {
      orgId: session.orgId,
      reservationId: id,
      fromStatus: "pending_approval",
      toStatus: "pending_customer",
      actor: `${session.operatorRole}:${session.userId}`,
    });

    return {
      ok: true as const,
      data: { id, status: "pending_customer" as const },
      status: 200 as const,
    };
  });
}

export async function rejectReservationService(
  session: ReservationSession,
  id: string,
  note: string,
): Promise<ServiceResult<{ id: string; status: "needs_amendment" }>> {
  if (session.role !== "admin") {
    return { ok: false, error: "Operators only", status: 403 };
  }
  if (session.operatorRole !== "admin" && session.operatorRole !== "manager") {
    return { ok: false, error: "Only managers or super admins may reject", status: 403 };
  }

  return getDb().$transaction(async (tx) => {
    const reservation = await tx.unitReservation.findFirst({
      where: { id, organizationId: session.orgId },
    });
    if (!reservation) return { ok: false, error: "Reservation not found", status: 404 as const };
    if (reservation.status !== "pending_approval") {
      return {
        ok: false,
        error: `Cannot reject — current status: ${reservation.status}`,
        status: 409 as const,
      };
    }

    await tx.unitReservation.update({
      where: { id },
      data: {
        status: "needs_amendment",
        approvalReviewedAt: new Date(),
        approvalReviewedById: session.userId,
        approvalNote: note,
      },
    });

    await repo.insertTransitionTx(tx, {
      orgId: session.orgId,
      reservationId: id,
      fromStatus: "pending_approval",
      toStatus: "needs_amendment",
      actor: `${session.operatorRole}:${session.userId}`,
      note,
    });

    return {
      ok: true as const,
      data: { id, status: "needs_amendment" as const },
      status: 200 as const,
    };
  });
}

export async function resubmitReservationService(
  session: ReservationSession,
  id: string,
  input: z.infer<typeof resubmitReservationSchema>,
  meta?: { ip?: string; userAgent?: string },
): Promise<ServiceResult<{ id: string; status: ReservationStatus }>> {
  if (session.role !== "agent") {
    return { ok: false, error: "Agents only", status: 403 };
  }

  // Captured outside the transaction so the post-commit S3 cleanup can use
  // them. Only populated when the agent is editing a signed reservation.
  let signedPdfKeyToDelete: string | null = null;
  let signatureDrawingKeyToDelete: string | null = null;

  const txResult = await getDb().$transaction(async (tx) => {
    const reservation = await tx.unitReservation.findFirst({
      where: { id, organizationId: session.orgId },
    });
    if (!reservation) return { ok: false as const, error: "Reservation not found", status: 404 as const };
    if (reservation.issuedByPartyId !== session.partyId) {
      return { ok: false as const, error: "Not your reservation", status: 403 as const };
    }
    // Agents may self-edit on every live status:
    //   needs_amendment / pending_approval / pending_customer — normal patch
    //   signed                                                — D2 reset
    // Terminal statuses (cancelled, expired) stay read-only.
    const RESUBMIT_ALLOWED = new Set([
      "needs_amendment",
      "pending_approval",
      "pending_customer",
      "signed",
    ]);
    if (!RESUBMIT_ALLOWED.has(reservation.status)) {
      return {
        ok: false as const,
        error: `Cannot resubmit — current status: ${reservation.status}`,
        status: 409 as const,
      };
    }

    // D2: signed edits require a reason ≥10 chars (audit-grade explanation).
    // Schema enforces ≥10 if a reason IS provided, but the field is optional
    // there; presence is required here.
    if (reservation.status === "signed" && (!input.reason || input.reason.trim().length < 10)) {
      return {
        ok: false as const,
        error: "Reason (≥10 characters) is required when editing a signed reservation.",
        status: 400 as const,
      };
    }

    // Next-status policy:
    //   signed                          → pending_customer (D2 reset)
    //   needs_amendment + custom terms  → pending_approval (manager re-reviews)
    //   needs_amendment + defaults only → pending_customer (skip approval)
    //   pending_approval                → pending_approval (manager sees latest)
    //   pending_customer                → pending_customer (no transition)
    let nextStatus: ReservationStatus;
    if (reservation.status === "signed") {
      nextStatus = "pending_customer";
    } else if (reservation.status === "pending_customer") {
      nextStatus = "pending_customer";
    } else if (reservation.status === "pending_approval") {
      nextStatus = "pending_approval";
    } else {
      nextStatus =
        input.customTerms.length > 0 ? "pending_approval" : "pending_customer";
    }

    // Only the needs_amendment + pending_approval (re-review) flow resets
    // approval metadata. pending_customer + signed edits PRESERVE the
    // manager's approval — that decision is still valid; only the
    // signature is being redone.
    const resetApproval =
      reservation.status !== "pending_customer" && reservation.status !== "signed";

    const data: Prisma.UnitReservationUpdateInput = {
      status: nextStatus,
      customTerms: input.customTerms,
      ...(resetApproval
        ? {
            approvalReviewedAt: null,
            approvalReviewedById: null,
            approvalNote: null,
          }
        : {}),
      ...(input.carPark !== undefined ? { carPark: input.carPark } : {}),
      ...(input.proposedMoveIn ? { proposedMoveIn: new Date(input.proposedMoveIn) } : {}),
      ...(input.proposedMoveOut !== undefined
        ? { proposedMoveOut: input.proposedMoveOut ? new Date(input.proposedMoveOut) : null }
        : {}),
      ...(input.specialRemarks !== undefined ? { specialRemarks: input.specialRemarks } : {}),
      ...(input.reservationDeposit !== undefined ? { reservationDeposit: input.reservationDeposit } : {}),
      ...(input.documentationFee !== undefined ? { documentationFee: input.documentationFee } : {}),
      ...(input.rentalDeposit !== undefined ? { rentalDeposit: input.rentalDeposit } : {}),
      ...(input.utilityDeposit !== undefined ? { utilityDeposit: input.utilityDeposit } : {}),
      ...(input.accessCardDeposit !== undefined ? { accessCardDeposit: input.accessCardDeposit } : {}),
      ...(input.applicantFullName !== undefined ? { applicantFullName: input.applicantFullName } : {}),
      ...(input.applicantNric !== undefined ? { applicantNric: input.applicantNric } : {}),
      ...(input.applicantContact !== undefined ? { applicantContact: input.applicantContact } : {}),
      ...(input.applicantEmail !== undefined ? { applicantEmail: input.applicantEmail } : {}),
      ...(input.nationality !== undefined ? { nationality: input.nationality } : {}),
      ...(input.emergencyContactName !== undefined ? { emergencyContactName: input.emergencyContactName } : {}),
      ...(input.emergencyContactPhone !== undefined ? { emergencyContactPhone: input.emergencyContactPhone } : {}),
      ...(input.emergencyContactRelation !== undefined ? { emergencyContactRelation: input.emergencyContactRelation } : {}),
      ...(input.occupation !== undefined ? { occupation: input.occupation } : {}),
      ...(input.monthlyIncome !== undefined ? { monthlyIncome: input.monthlyIncome } : {}),
    };

    // D2 signed reset: null the 7 signature fields + capture old S3 keys
    // for post-commit deletion.
    if (reservation.status === "signed") {
      signedPdfKeyToDelete = reservation.signedPdfKey;
      signatureDrawingKeyToDelete = reservation.signatureDrawingKey;
      Object.assign(data, buildSignedResetPatch());
    }

    const after = await tx.unitReservation.update({ where: { id }, data });

    // Emit a transition row whenever status changes.
    if (nextStatus !== reservation.status) {
      await repo.insertTransitionTx(tx, {
        orgId: session.orgId,
        reservationId: id,
        fromStatus: reservation.status,
        toStatus: nextStatus,
        actor: `agent:${session.userId}`,
        note: reservation.status === "signed" ? input.reason : undefined,
      });
    }

    // D2: write an AuditLog row for the signed→pending_customer reset.
    // Other agent edits (needs_amendment/pending_approval/pending_customer)
    // are recorded by the transition row alone — the reset is a stronger
    // event (re-sign required) and warrants the full audit trail.
    if (reservation.status === "signed") {
      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: "agent",
        action: "agent_edit_signed_reset",
        entityType: "UnitReservation",
        entityId: id,
        diff: {
          before: serializeReservationForAudit(reservation),
          after: serializeReservationForAudit(after),
        } as Prisma.InputJsonValue,
        meta: { reason: input.reason! } as Prisma.InputJsonValue,
        ip: meta?.ip,
        userAgent: meta?.userAgent,
      });
    }

    return {
      ok: true as const,
      data: { id, status: nextStatus },
      status: 200 as const,
    };
  });

  if (txResult.ok && (signedPdfKeyToDelete || signatureDrawingKeyToDelete)) {
    await deleteSignedArtifactsBestEffort(
      signedPdfKeyToDelete,
      signatureDrawingKeyToDelete,
    );
  }

  return txResult;
}

export async function fillReservationByTokenService(
  token: string,
  input: SectionBInput,
): Promise<ServiceResult<{ id: string }>> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) {
    return { ok: false, error: "Not found", status: 404 };
  }

  return getDb().$transaction(async (tx) => {
    const reservation = await tx.unitReservation.findFirst({ where: { publicToken: token } });
    if (
      !reservation ||
      reservation.status !== "pending_customer" ||
      reservation.expiresAt < new Date()
    ) {
      return { ok: false, error: "Not found", status: 404 as const };
    }

    await tx.unitReservation.update({
      where: { id: reservation.id },
      data: {
        applicantFullName: input.applicantFullName,
        applicantNric: input.applicantNric,
        applicantContact: input.applicantContact,
        applicantEmail: input.applicantEmail,
        applicantAddressLine1: input.applicantAddressLine1,
        applicantAddressLine2: input.applicantAddressLine2 ?? null,
        applicantCity: input.applicantCity,
        applicantPostcode: input.applicantPostcode,
        applicantState: input.applicantState,
        applicantCountry: input.applicantCountry,
        nationality: input.nationality,
        emergencyContactName: input.emergencyContactName,
        emergencyContactPhone: input.emergencyContactPhone,
        emergencyContactRelation: input.emergencyContactRelation ?? null,
        occupation: input.occupation ?? null,
        monthlyIncome: input.monthlyIncome ?? null,
      },
    });

    return { ok: true as const, data: { id: reservation.id }, status: 200 as const };
  });
}

export async function signReservationByTokenService(
  token: string,
  input: SignInput,
  meta: { ip: string; userAgent: string },
): Promise<ServiceResult<{ id: string; signedPdfDownloadUrl: string }>> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) {
    return { ok: false, error: "Not found", status: 404 };
  }

  const db = getDb();
  const reservationRaw = await db.unitReservation.findFirst({
    where: { publicToken: token },
    include: {
      property: { select: { id: true, name: true } },
      unit: { select: { id: true, apartment: { select: { unitCode: true } } } },
    },
  });
  const reservation = reservationRaw
    ? {
        ...reservationRaw,
        unit: {
          id: reservationRaw.unit.id,
          unitCode: reservationRaw.unit.apartment.unitCode,
        },
      }
    : null;
  if (
    !reservation ||
    reservation.status !== "pending_customer" ||
    reservation.expiresAt < new Date()
  ) {
    return { ok: false, error: "Not found", status: 404 };
  }

  if (
    !reservation.applicantFullName ||
    !reservation.applicantNric ||
    !reservation.applicantContact ||
    !reservation.applicantEmail ||
    !reservation.applicantAddressLine1 ||
    !reservation.applicantCity ||
    !reservation.applicantPostcode ||
    !reservation.applicantState ||
    !reservation.applicantCountry
  ) {
    return { ok: false, error: "Section B is incomplete", status: 400 };
  }

  const idDocCount = await getDb().unitReservationDocument.count({
    where: { reservationId: reservation.id },
  });
  if (idDocCount === 0) {
    return { ok: false, error: "ID_DOCUMENT_REQUIRED", status: 400 };
  }

  if (
    input.typedName.trim().toLowerCase() !==
    reservation.applicantFullName.trim().toLowerCase()
  ) {
    return { ok: false, error: "Typed name does not match applicant name", status: 400 };
  }

  let pngBuffer: Buffer;
  try {
    pngBuffer = await validateSignaturePng(input.signaturePngBase64);
  } catch (err) {
    if (err instanceof SignError) return { ok: false, error: err.message, status: 400 };
    throw err;
  }

  const template = await getTemplateForOrgDocType(
    reservation.organizationId,
    "reservation_form",
  );
  const idDocKinds = (
    await getDb().unitReservationDocument.findMany({
      where: { reservationId: reservation.id },
      select: { kind: true },
    })
  ).map((d) => d.kind);
  const bodyHtml = buildReservationBodyHtml({
    applicant: {
      fullName: reservation.applicantFullName,
      nric: reservation.applicantNric,
      contact: reservation.applicantContact,
      email: reservation.applicantEmail,
      addressLine1: reservation.applicantAddressLine1 ?? "",
      addressLine2: reservation.applicantAddressLine2 ?? undefined,
      city: reservation.applicantCity ?? "",
      postcode: reservation.applicantPostcode ?? "",
      state: reservation.applicantState ?? "",
      country: reservation.applicantCountry ?? "",
      nationality: reservation.nationality,
      occupation: reservation.occupation,
      monthlyIncome: reservation.monthlyIncome?.toString() ?? null,
      emergencyContactName: reservation.emergencyContactName,
      emergencyContactPhone: reservation.emergencyContactPhone,
      emergencyContactRelation: reservation.emergencyContactRelation,
    },
    property: {
      name: reservation.property.name,
      unitCode: reservation.unit.unitCode,
      carPark: reservation.carPark,
    },
    schedule: {
      moveIn: reservation.proposedMoveIn,
      moveOut: reservation.proposedMoveOut,
      remarks: reservation.specialRemarks,
    },
    section1: {
      reservationDeposit: reservation.reservationDeposit.toString(),
      documentationFee: reservation.documentationFee.toString(),
    },
    section2: {
      rentalDeposit: reservation.rentalDeposit.toString(),
      utilityDeposit: reservation.utilityDeposit.toString(),
      accessCardDeposit: reservation.accessCardDeposit.toString(),
    },
    termsCustomization: {
      customTerms: reservation.customTerms,
    },
    documentsProvided: {
      passport: idDocKinds.some((k) => k.startsWith("passport")),
      ic: idDocKinds.some((k) => k.startsWith("ic")),
    },
  });

  const signedAt = new Date();
  const html = renderToHtml({
    template,
    referenceCode: reservation.referenceCode,
    issuedDate: reservation.issuedAt,
    dueDate: reservation.expiresAt,
    bodyHtml,
    signature: {
      pngDataUrl: input.signaturePngBase64,
      typedName: input.typedName,
      signedAt,
      ip: meta.ip,
    },
  });
  const pdfBuffer = await htmlToPdf(html);

  const sigKey = `reservations/${reservation.id}/signature.png`;
  const pdfKey = `reservations/${reservation.id}/signed.pdf`;
  // Storage writes happen before the DB transaction. If the transaction
  // fails (STATE_CONFLICT or any DB error), the PNG + PDF blobs remain
  // in Supabase Storage with no row pointing at them. Accepted for v1 —
  // low-volume sign-attempts, no Storage lifecycle rules yet. Cleanup
  // is a follow-up if orphan rates become measurable.
  await putObject(sigKey, pngBuffer, "image/png");
  await putObject(pdfKey, pdfBuffer, "application/pdf");

  // 24h TTL — tenant may read the confirmation email hours later. The
  // global default (30 min) is appropriate for in-app downloads where
  // the user clicks immediately, but emails need a longer window.
  const signedPdfDownloadUrl = await createSignedDownloadUrl(pdfKey, { ttlSeconds: 86400 });

  try {
    await db.$transaction(async (tx) => {
      const fresh = await tx.unitReservation.findFirst({
        where: { id: reservation.id, status: "pending_customer" },
      });
      if (!fresh) throw new Error("STATE_CONFLICT");

      // Re-count ID documents under the same transaction snapshot as the
      // status re-check above. The pre-transaction count at ~:608 is a fast
      // fail for the common case, but it happens before the slow
      // non-transactional PDF render + storage writes — a concurrent
      // DELETE /documents/:kind can remove the last doc during that window
      // and would otherwise slip through since `fresh` only re-checks
      // status, not document count. This closes that TOCTOU gap.
      const idDocCountTx = await tx.unitReservationDocument.count({
        where: { reservationId: reservation.id },
      });
      if (idDocCountTx === 0) throw new Error("ID_DOCUMENT_GONE");

      await tx.unitReservation.update({
        where: { id: reservation.id },
        data: {
          status: "signed",
          signedAt,
          signedFromIp: meta.ip,
          signedUserAgent: meta.userAgent,
          signatureDrawingKey: sigKey,
          signatureTypedName: input.typedName,
          signatureAgreementTickedAt: signedAt,
          signedPdfKey: pdfKey,
        },
      });

      await repo.insertTransitionTx(tx, {
        orgId: reservation.organizationId,
        reservationId: reservation.id,
        fromStatus: "pending_customer",
        toStatus: "signed",
        actor: "customer:public",
      });

      await queueSignedConfirmationEmailTx(tx, {
        orgId: reservation.organizationId,
        recipientEmail: reservation.applicantEmail!,
        referenceCode: reservation.referenceCode,
        signedPdfDownloadUrl,
      });

      const agent = await tx.party.findFirst({
        where: { id: reservation.issuedByPartyId },
        select: { primaryEmail: true },
      });
      if (agent?.primaryEmail) {
        await queueAgentNotifyEmailTx(tx, {
          orgId: reservation.organizationId,
          recipientEmail: agent.primaryEmail,
          referenceCode: reservation.referenceCode,
        });
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "ID_DOCUMENT_GONE") {
      return { ok: false, error: "ID_DOCUMENT_REQUIRED", status: 400 };
    }
    if (err instanceof Error && err.message === "STATE_CONFLICT") {
      return { ok: false, error: "Reservation no longer pending", status: 409 };
    }
    throw err;
  }

  return { ok: true, data: { id: reservation.id, signedPdfDownloadUrl }, status: 200 };
}

export async function listEligibleUnitsForAgent(
  orgId: string,
  agentPartyId: string,
): Promise<repo.EligibleUnitForReservation[]> {
  const [units, grants] = await Promise.all([
    repo.findReadyNowActiveUnitsInOrg(orgId),
    repo.findAgentVisibilityGrants(orgId, agentPartyId),
  ]);
  const grantedSet = new Set(grants.map((g) => g.unitId));
  return units
    .filter((u) =>
      canAgentSeeUnit(
        {
          id: u.id,
          visibilityMode: u.visibilityMode,
          hiddenFromPartyIds: u.hiddenFromPartyIds,
          sourcingAgentId: u.sourcingAgentId,
          inChargePartyId: u.inChargePartyId,
        },
        agentPartyId,
        grantedSet.has(u.id) ? [agentPartyId] : [],
      ),
    )
    .map((u) => ({
      id: u.id,
      unitCode: u.unitCode,
      unitType: u.unitType,
      bedrooms: u.bedrooms,
      visibilityMode: u.visibilityMode,
      hiddenFromPartyIds: u.hiddenFromPartyIds,
      sourcingAgentId: u.sourcingAgentId,
      inChargePartyId: u.inChargePartyId,
      property: u.property,
    }));
}

export type PickableReservationDto = {
  id: string;
  referenceCode: string;
  applicant: {
    fullName: string | null;
    nricMasked: string | null;
    contact: string | null;
    email: string | null;
  };
  proposedMoveIn: string;
  proposedMoveOut: string | null;
  agreedMonthlyRent: string | null;
  unit: { label: string };
};

// Partitioned apartments carry more than one Listing (Master/Medium/Small
// etc.) against the same Apartment.unitCode, so the room type is folded into
// the label to disambiguate. A WHOLE-unit listing's listingType is the
// generic "apartment" — no room type to show, so the unitCode stands alone.
function buildUnitLabel(unit: { listingType: string; apartment: { unitCode: string } }): string {
  const isWholeApartment = unit.listingType.toLowerCase() === "apartment";
  return isWholeApartment
    ? unit.apartment.unitCode
    : `${unit.apartment.unitCode} (${unit.listingType})`;
}

// Shared row→DTO mapper for both the pickable list and the tenant-linked
// lookup — the repository's `pickableSelect` guarantees both queries hydrate
// the identical row shape, so this one function covers the mask/ISO/label
// logic for both call sites instead of duplicating it.
function toPickableReservationDto(
  r: Awaited<ReturnType<typeof repo.listPickableReservations>>[number],
): PickableReservationDto {
  return {
    id: r.id,
    referenceCode: r.referenceCode,
    applicant: {
      fullName: r.applicantFullName,
      nricMasked: maskIdNumber(r.applicantNric),
      contact: r.applicantContact,
      email: r.applicantEmail,
    },
    proposedMoveIn: r.proposedMoveIn.toISOString(),
    proposedMoveOut: r.proposedMoveOut?.toISOString() ?? null,
    agreedMonthlyRent: r.agreedMonthlyRent?.toString() ?? null,
    unit: { label: buildUnitLabel(r.unit) },
  };
}

// Picker source for tenant-create-from-reservation (T3/T5+). Read-only —
// any operator (incl. viewer) may call this. NRIC is masked here, in the
// service layer, so the raw value can never leave via this list endpoint.
export async function listPickableReservationsService(
  session: ReservationSession,
): Promise<PickableReservationDto[]> {
  const rows = await repo.listPickableReservations(session.orgId);
  return rows.map(toPickableReservationDto);
}

// The tenant-driven auto-derive source (T13/R5): resolves the SELECTED
// TENANT's own signed, not-yet-converted reservation (if any), so the web
// assign form can derive tenancy terms from the reservation actually linked
// to that tenant instead of trusting a free-pick reservation select that
// could belong to an unrelated applicant. Read-only, any operator (incl.
// viewer) may call this — same access as /pickable. Org-scoped, so a
// foreign/invalid/unlinked tenantPartyId naturally resolves null (no
// existence oracle for other orgs' parties).
export async function getLinkedSignedReservationService(
  session: ReservationSession,
  tenantPartyId: string,
): Promise<PickableReservationDto | null> {
  const r = await repo.findLinkedSignedReservation(session.orgId, tenantPartyId);
  return r ? toPickableReservationDto(r) : null;
}

async function toDto(
  row: Awaited<ReturnType<typeof repo.findByIdInOrg>>,
  opts: { includePublicToken?: boolean } = {},
): Promise<ReservationDto | null> {
  if (!row) return null;
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    status: row.status as ReservationDto["status"],
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    property: { id: row.property.id, name: row.property.name },
    unit: { id: row.unit.id, unitCode: row.unit.unitCode },
    carPark: row.carPark,
    proposedMoveIn: row.proposedMoveIn.toISOString(),
    proposedMoveOut: row.proposedMoveOut?.toISOString() ?? null,
    specialRemarks: row.specialRemarks,
    charges: {
      reservationDeposit: row.reservationDeposit.toString(),
      documentationFee: row.documentationFee.toString(),
      rentalDeposit: row.rentalDeposit.toString(),
      utilityDeposit: row.utilityDeposit.toString(),
      accessCardDeposit: row.accessCardDeposit.toString(),
    },
    agreedMonthlyRent: row.agreedMonthlyRent?.toString() ?? null,
    applicant: {
      fullName: row.applicantFullName,
      nric: row.applicantNric,
      contact: row.applicantContact,
      email: row.applicantEmail,
      addressLine1: row.applicantAddressLine1,
      addressLine2: row.applicantAddressLine2,
      city: row.applicantCity,
      postcode: row.applicantPostcode,
      state: row.applicantState,
      country: row.applicantCountry,
      nationality: row.nationality,
      occupation: row.occupation,
      monthlyIncome: row.monthlyIncome?.toString() ?? null,
      emergencyContactName: row.emergencyContactName,
      emergencyContactPhone: row.emergencyContactPhone,
      emergencyContactRelation: row.emergencyContactRelation,
    },
    documents: row.documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      filename: d.filename,
      uploadedAt: d.uploadedAt.toISOString(),
    })),
    signedAt: row.signedAt?.toISOString() ?? null,
    customTerms: row.customTerms,
    approvalNote: row.approvalNote,
    publicToken:
      opts.includePublicToken && row.status === "pending_customer"
        ? row.publicToken
        : undefined,
    signedPdfDownloadUrl: row.signedPdfKey ? await createSignedDownloadUrl(row.signedPdfKey) : null,
  };
}

export async function listReservationsForOrg(
  orgId: string,
  status?: string,
): Promise<ReservationDto[]> {
  const rows = await repo.listForOrg(orgId, status);
  const out: ReservationDto[] = [];
  for (const r of rows) {
    const dto = await toDto(r, { includePublicToken: true });
    if (dto) out.push(dto);
  }
  return out;
}

export async function listReservationsForAgent(
  orgId: string,
  partyId: string,
): Promise<ReservationDto[]> {
  const rows = await repo.listForAgent(orgId, partyId);
  const out: ReservationDto[] = [];
  for (const r of rows) {
    const dto = await toDto(r, { includePublicToken: true });
    if (dto) out.push(dto);
  }
  return out;
}

export async function getReservationForOrg(
  orgId: string,
  id: string,
  session: ReservationSession,
): Promise<ReservationDto | null> {
  const row = await repo.findByIdInOrg(orgId, id);
  if (!row) return null;
  // Agents may only read a reservation they themselves issued. Without this
  // gate the lookup is org-scoped only, so any authenticated agent who learns
  // another reservation's id could pull the full applicant PII (NRIC,
  // nationality, income, emergency contacts) and a signed-PDF URL through
  // toDto. Mirror the ownership check in getUnsignedReservationPdfService and
  // fail closed to null → the route answers 404 (never confirms existence).
  // Operators (admin adapter) and viewers are org-wide staff, so unaffected.
  if (session.role === "agent" && row.issuedByPartyId !== session.partyId) {
    return null;
  }
  const includePublicToken =
    session.role === "admin" ||
    (session.role === "agent" && row.issuedByPartyId === session.partyId);
  return toDto(row, { includePublicToken });
}

export async function getUnsignedReservationPdfService(
  session: ReservationSession,
  id: string,
): Promise<
  | { ok: true; pdf: Buffer; filename: string; status: 200 }
  | { ok: false; error: string; status: 403 | 404 | 409 }
> {
  const reservation = await repo.findByIdInOrg(session.orgId, id);
  if (!reservation) {
    return { ok: false, error: "Reservation not found", status: 404 };
  }
  // Admins can pull any unsigned reservation; agents only their own.
  // (No auto-emailed sign-link any more — agents now share the link
  // manually, and "Download PDF" is one of the channels.)
  if (
    session.role === "agent" &&
    reservation.issuedByPartyId !== session.partyId
  ) {
    return { ok: false, error: "Not your reservation", status: 403 };
  }
  if (reservation.status !== "pending_customer") {
    return {
      ok: false,
      error: `Unsigned PDF only available for pending_customer (current: ${reservation.status})`,
      status: 409,
    };
  }

  const template = await getTemplateForOrgDocType(
    reservation.organizationId,
    "reservation_form",
  );
  const idDocKinds = (
    await getDb().unitReservationDocument.findMany({
      where: { reservationId: reservation.id },
      select: { kind: true },
    })
  ).map((d) => d.kind);
  const bodyHtml = buildReservationBodyHtml({
    applicant: {
      fullName: reservation.applicantFullName ?? "",
      nric: reservation.applicantNric ?? "",
      contact: reservation.applicantContact ?? "",
      email: reservation.applicantEmail ?? "",
      addressLine1: reservation.applicantAddressLine1 ?? "",
      addressLine2: reservation.applicantAddressLine2 ?? undefined,
      city: reservation.applicantCity ?? "",
      postcode: reservation.applicantPostcode ?? "",
      state: reservation.applicantState ?? "",
      country: reservation.applicantCountry ?? "",
      nationality: reservation.nationality,
      occupation: reservation.occupation,
      monthlyIncome: reservation.monthlyIncome?.toString() ?? null,
      emergencyContactName: reservation.emergencyContactName,
      emergencyContactPhone: reservation.emergencyContactPhone,
      emergencyContactRelation: reservation.emergencyContactRelation,
    },
    property: {
      name: reservation.property.name,
      unitCode: reservation.unit.unitCode,
      carPark: reservation.carPark,
    },
    schedule: {
      moveIn: reservation.proposedMoveIn,
      moveOut: reservation.proposedMoveOut,
      remarks: reservation.specialRemarks,
    },
    section1: {
      reservationDeposit: reservation.reservationDeposit.toString(),
      documentationFee: reservation.documentationFee.toString(),
    },
    section2: {
      rentalDeposit: reservation.rentalDeposit.toString(),
      utilityDeposit: reservation.utilityDeposit.toString(),
      accessCardDeposit: reservation.accessCardDeposit.toString(),
    },
    termsCustomization: {
      customTerms: reservation.customTerms,
    },
    documentsProvided: {
      passport: idDocKinds.some((k) => k.startsWith("passport")),
      ic: idDocKinds.some((k) => k.startsWith("ic")),
    },
  });

  const html = renderToHtml({
    template,
    referenceCode: reservation.referenceCode,
    issuedDate: reservation.issuedAt,
    dueDate: reservation.expiresAt,
    bodyHtml,
    // No signature — this is the unsigned preview the operator
    // downloads before sending the sign-link.
  });
  const pdfBuffer = await htmlToPdf(html);

  return {
    ok: true,
    pdf: pdfBuffer,
    filename: `${reservation.referenceCode}-unsigned.pdf`,
    status: 200,
  };
}

// ── Admin edit-after-signing ─────────────────────────────────────────────────
//
// Spec §5.3. After a reservation is signed, admins may still need to correct
// typos (tenant name, contact, deposit amount). Each edit:
//   1. updates the reservation row inside a transaction
//   2. writes ONE AuditLog row with action=admin_edit_after_signing inside
//      the same transaction (audit and update share rollback semantics)
//   3. attaches the admin's mandatory reason as meta.reason
//
// The clauses customer agreed to (customTerms) and the signed-PDF blob are
// out of scope — those are the legal record. Typo-class fields only.

type AdminEditPatch = z.infer<typeof adminEditReservationSchema>["patch"];

/**
 * Convert a UnitReservation Prisma row to a JSON-safe shape for AuditLog
 * storage. Decimals → string (preserves precision the way Prisma serialises),
 * Dates → ISO strings. Stable across the before/after pair so diffs render
 * predictably in the audit-log UI.
 */
function serializeReservationForAudit(row: UnitReservation): Record<string, unknown> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    referenceCode: row.referenceCode,
    status: row.status,
    issuedByPartyId: row.issuedByPartyId,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    propertyId: row.propertyId,
    unitId: row.unitId,
    carPark: row.carPark,
    proposedMoveIn: row.proposedMoveIn.toISOString(),
    proposedMoveOut: row.proposedMoveOut ? row.proposedMoveOut.toISOString() : null,
    specialRemarks: row.specialRemarks,
    reservationDeposit: row.reservationDeposit.toString(),
    documentationFee: row.documentationFee.toString(),
    rentalDeposit: row.rentalDeposit.toString(),
    utilityDeposit: row.utilityDeposit.toString(),
    accessCardDeposit: row.accessCardDeposit.toString(),
    applicantFullName: row.applicantFullName,
    applicantNric: row.applicantNric,
    applicantContact: row.applicantContact,
    applicantEmail: row.applicantEmail,
    customTerms: row.customTerms,
    signedAt: row.signedAt ? row.signedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Translate a zod-parsed patch into the column-shaped data Prisma expects.
 * Date-strings → Date instances (Prisma rejects strings for DateTime cols).
 * Other fields pass through unchanged.
 */
function patchToPrismaData(patch: AdminEditPatch): Prisma.UnitReservationUpdateInput {
  const data: Prisma.UnitReservationUpdateInput = {};
  if (patch.carPark !== undefined) data.carPark = patch.carPark;
  if (patch.proposedMoveIn !== undefined) data.proposedMoveIn = new Date(patch.proposedMoveIn);
  if (patch.proposedMoveOut !== undefined) {
    data.proposedMoveOut = patch.proposedMoveOut ? new Date(patch.proposedMoveOut) : null;
  }
  if (patch.specialRemarks !== undefined) data.specialRemarks = patch.specialRemarks;
  if (patch.reservationDeposit !== undefined) data.reservationDeposit = patch.reservationDeposit;
  if (patch.documentationFee !== undefined) data.documentationFee = patch.documentationFee;
  if (patch.rentalDeposit !== undefined) data.rentalDeposit = patch.rentalDeposit;
  if (patch.utilityDeposit !== undefined) data.utilityDeposit = patch.utilityDeposit;
  if (patch.accessCardDeposit !== undefined) data.accessCardDeposit = patch.accessCardDeposit;
  if (patch.applicantFullName !== undefined) data.applicantFullName = patch.applicantFullName;
  if (patch.applicantNric !== undefined) data.applicantNric = patch.applicantNric;
  if (patch.applicantContact !== undefined) data.applicantContact = patch.applicantContact;
  if (patch.applicantEmail !== undefined) data.applicantEmail = patch.applicantEmail;
  if (patch.nationality !== undefined) data.nationality = patch.nationality;
  if (patch.emergencyContactName !== undefined) data.emergencyContactName = patch.emergencyContactName;
  if (patch.emergencyContactPhone !== undefined) data.emergencyContactPhone = patch.emergencyContactPhone;
  if (patch.emergencyContactRelation !== undefined) data.emergencyContactRelation = patch.emergencyContactRelation;
  if (patch.occupation !== undefined) data.occupation = patch.occupation;
  if (patch.monthlyIncome !== undefined) data.monthlyIncome = patch.monthlyIncome;
  if (patch.customTerms !== undefined) data.customTerms = patch.customTerms;
  return data;
}

// Statuses an admin/manager is allowed to edit. signed: post-sign typo fix
// (audit-trail required, plus a reset to pending_customer per D2 — the
// tenant must re-sign once the row changes). pending_customer: tenant has
// the sign link but hasn't clicked sign yet — fixing a typo here avoids
// the cancel-and-recreate roundtrip while still being audited. Any other
// status (pending_approval, needs_amendment, cancelled, expired) returns 409.
const ADMIN_EDITABLE_STATUSES = new Set(["signed", "pending_customer"]);

// D2: when a signed reservation is edited (from either portal or admin), the
// signed PDF + signature image no longer represent the latest data, so the
// row is reset to pending_customer and the tenant must re-sign. Returns
// `null` if `reservation.status !== "signed"` (caller should do its normal
// non-reset update instead).
function buildSignedResetPatch(): Prisma.UnitReservationUpdateInput {
  return {
    status: "pending_customer",
    signedAt: null,
    signedFromIp: null,
    signedUserAgent: null,
    signatureDrawingKey: null,
    signatureTypedName: null,
    signatureAgreementTickedAt: null,
    signedPdfKey: null,
  };
}

/**
 * Best-effort deletion of the signed PDF + signature PNG after a successful
 * signed→pending_customer reset. Run AFTER the DB transaction commits so a
 * mid-flow rollback never deletes a blob the row still references. Failures
 * are logged, not thrown — leaving an orphan blob is preferable to surfacing
 * a 5xx after the DB state has already changed. The user explicitly chose
 * Delete-immediately for this flow (D2) so orphans are the failure mode
 * only when Supabase Storage is unreachable.
 */
async function deleteSignedArtifactsBestEffort(
  signedPdfKey: string | null,
  signatureDrawingKey: string | null,
): Promise<void> {
  const keys = [signedPdfKey, signatureDrawingKey].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  if (keys.length === 0) return;
  let bucket: string;
  try {
    bucket = requireBucket();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[reservations] cannot delete signed artifacts — bucket not configured: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const key of keys) {
    try {
      await deleteObject(bucket, key);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reservations] failed to delete signed artifact ${key}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export async function adminEditAfterSigningService(
  session: ReservationSession,
  reservationId: string,
  input: {
    patch: AdminEditPatch;
    reason: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<ServiceResult<{ id: string }>> {
  // Spec §5.3: only admin role (operator). The session adapter flattens
  // admin/manager/editor into role:"admin" with operatorRole carrying the
  // true rank — gate on operatorRole here.
  if (session.role !== "admin") {
    return { ok: false, error: "Admin role required", status: 403 };
  }
  if (session.operatorRole !== "admin" && session.operatorRole !== "manager") {
    return { ok: false, error: "Only managers or super admins may edit reservations", status: 403 };
  }

  // Capture the signed keys for post-commit S3 cleanup (D2). Declared
  // outside the transaction closure so we can act on them after commit.
  let signedPdfKeyToDelete: string | null = null;
  let signatureDrawingKeyToDelete: string | null = null;

  const txResult = await getDb().$transaction(async (tx) => {
    const before = await tx.unitReservation.findFirst({
      where: { id: reservationId, organizationId: session.orgId },
    });
    if (!before) {
      return { ok: false as const, error: "Reservation not found", status: 404 as const };
    }
    if (!ADMIN_EDITABLE_STATUSES.has(before.status)) {
      return {
        ok: false as const,
        error:
          "This reservation cannot be edited in its current status. Only signed or awaiting-tenant reservations may be edited.",
        status: 409 as const,
      };
    }

    const data = patchToPrismaData(input.patch);
    // D2: signed edits trigger a full reset — the previously signed PDF is
    // no longer accurate, so the row flips to pending_customer and the
    // signature fields null out. The keys are captured for post-commit
    // blob deletion. The manager's approval (approvalReviewedAt/ById) is
    // intentionally preserved — only the signature is being redone.
    if (before.status === "signed") {
      signedPdfKeyToDelete = before.signedPdfKey;
      signatureDrawingKeyToDelete = before.signatureDrawingKey;
      Object.assign(data, buildSignedResetPatch());
    }

    const after = await tx.unitReservation.update({
      where: { id: reservationId },
      data,
    });

    // Log a transition row whenever signed → pending_customer fires.
    // pending_customer-stay edits don't log a transition (from===to is
    // recorded by the audit row instead).
    if (before.status === "signed") {
      await repo.insertTransitionTx(tx, {
        orgId: session.orgId,
        reservationId,
        fromStatus: "signed",
        toStatus: "pending_customer",
        actor: `${session.operatorRole ?? session.role}:${session.userId}`,
        note: input.reason,
      });
    }

    // Audit-log action codes:
    //   admin_edit_signed_reset       — D2 signed→pending_customer flip
    //   admin_edit_pending_customer   — pre-sign typo fix (no status change)
    const action =
      before.status === "signed"
        ? "admin_edit_signed_reset"
        : "admin_edit_pending_customer";

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: session.operatorRole ?? session.role,
      action,
      entityType: "UnitReservation",
      entityId: reservationId,
      diff: {
        before: serializeReservationForAudit(before),
        after: serializeReservationForAudit(after),
      } as Prisma.InputJsonValue,
      meta: { reason: input.reason } as Prisma.InputJsonValue,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return { ok: true as const, data: { id: reservationId }, status: 200 as const };
  });

  // After commit (only on success): best-effort deletion of the old signed
  // PDF + signature PNG. Failure here doesn't roll back the DB — the row
  // is correctly reset, just with orphan blobs.
  if (txResult.ok && (signedPdfKeyToDelete || signatureDrawingKeyToDelete)) {
    await deleteSignedArtifactsBestEffort(
      signedPdfKeyToDelete,
      signatureDrawingKeyToDelete,
    );
  }

  return txResult;
}

export interface ReservationEditHistoryEntry {
  id: string;
  createdAt: string;
  actorName: string;
  reason: string;
}

/**
 * Edit history for a single reservation — admin-only audit-trail surface.
 * Returns rows for any of the four edit action codes:
 *   - admin_edit_after_signing      (legacy, pre-D2 admin signed-edits)
 *   - admin_edit_signed_reset       (D2: admin signed→pending_customer flip)
 *   - admin_edit_pending_customer   (admin pre-sign typo fixes)
 *   - agent_edit_signed_reset       (D2: agent signed→pending_customer flip)
 * All are mutations worth surfacing on the detail page; the action code
 * preserves intent for downstream filtering.
 */
export async function getReservationEditHistory(
  session: ReservationSession,
  reservationId: string,
): Promise<ServiceResult<{ entries: ReservationEditHistoryEntry[] }>> {
  if (session.role !== "admin") {
    return { ok: false, error: "Admin role required", status: 403 };
  }
  if (session.operatorRole !== "admin" && session.operatorRole !== "manager") {
    return { ok: false, error: "Only managers or super admins may view edit history", status: 403 };
  }

  const rows = await getDb().auditLog.findMany({
    where: {
      organizationId: session.orgId,
      entityType: "UnitReservation",
      entityId: reservationId,
      action: {
        in: [
          "admin_edit_after_signing",
          "admin_edit_signed_reset",
          "admin_edit_pending_customer",
          "agent_edit_signed_reset",
        ],
      },
    },
    include: { actor: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
  });

  const entries: ReservationEditHistoryEntry[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actorName: r.actor.fullName,
    reason: (r.meta as { reason?: string } | null)?.reason ?? "",
  }));

  return { ok: true, status: 200, data: { entries } };
}
