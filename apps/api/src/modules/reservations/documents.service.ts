// apps/api/src/modules/reservations/documents.service.ts
//
// Reservation ID-document service. Handles server-derived Supabase Storage
// object keys and token-gated upload/mark/delete for the anonymous customer
// flow, plus an org-scoped admin view-url lookup.
//
// SECURITY: object keys are ALWAYS derived server-side from the
// token-resolved reservation's organizationId + id and the kind enum
// (buildReservationDocKey). The caller never supplies or influences a
// storage key — mark-uploaded re-derives the key rather than trusting a
// client-provided fileKey.
import { getDb } from "@kason/db";
import {
  createSignedUploadUrl,
  createSignedDownloadUrl,
  deleteObject,
  requireBucket,
} from "../../lib/storage";
import { RESERVATION_DOC_KINDS } from "./validation";

type Ok<T> = { ok: true; data: T; status: 200 | 201 };
type Err = { ok: false; error: string; status: 404 | 409 | 500 };
type Result<T> = Ok<T> | Err;

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

// Admin ID-doc view URL lifetime.
const VIEW_URL_TTL_SEC = 1800;

export function buildReservationDocKey(
  orgId: string,
  reservationId: string,
  kind: string,
): string {
  // Defense-in-depth: routes already enum-validate `kind` via Zod, so this
  // should never trip on a real request. It exists to stop a future caller
  // that forgets validation from string-interpolating an attacker-controlled
  // `kind` into a storage object key (path traversal).
  if (!(RESERVATION_DOC_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid reservation document kind: ${kind}`);
  }
  return `reservations/${orgId}/${reservationId}/id-docs/${kind}`;
}

// Resolves a reservation by publicToken, gated to status === "pending_customer"
// and unexpired. Malformed token / no match / wrong status / expired all fall
// through the same "not editable right now" path — callers distinguish
// malformed/no-match (404) from a valid token in the wrong state (409).
async function loadReservationByToken(
  token: string,
): Promise<
  | { ok: true; reservation: { id: string; organizationId: string } }
  | { ok: false; reason: "not_found" | "not_pending" }
> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "not_found" };
  const reservation = await getDb().unitReservation.findFirst({
    where: { publicToken: token },
  });
  if (!reservation) return { ok: false, reason: "not_found" };
  if (reservation.status !== "pending_customer" || reservation.expiresAt < new Date()) {
    return { ok: false, reason: "not_pending" };
  }
  return {
    ok: true,
    reservation: { id: reservation.id, organizationId: reservation.organizationId },
  };
}

function gateError(reason: "not_found" | "not_pending"): Err {
  return reason === "not_found"
    ? { ok: false, error: "Not found", status: 404 }
    : { ok: false, error: "Reservation is not open for edits", status: 409 };
}

export async function requestReservationUploadUrlByToken(
  token: string,
  input: { kind: string; contentType: string; filename: string },
): Promise<Result<{ uploadUrl: string; method: string; headers: Record<string, string> }>> {
  const gated = await loadReservationByToken(token);
  if (!gated.ok) return gateError(gated.reason);
  const { reservation } = gated;

  const storageKey = buildReservationDocKey(reservation.organizationId, reservation.id, input.kind);
  try {
    const signed = await createSignedUploadUrl({ storageKey, contentType: input.contentType });
    return {
      ok: true,
      data: { uploadUrl: signed.uploadUrl, method: signed.method, headers: signed.headers },
      status: 200,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create upload URL",
      status: 500,
    };
  }
}

export async function markReservationDocUploadedByToken(
  token: string,
  input: { kind: string; filename: string },
): Promise<Result<{ id: string; kind: string; filename: string; uploadedAt: string }>> {
  const gated = await loadReservationByToken(token);
  if (!gated.ok) return gateError(gated.reason);
  const { reservation } = gated;

  const fileKey = buildReservationDocKey(reservation.organizationId, reservation.id, input.kind);
  const row = await getDb().unitReservationDocument.upsert({
    where: { reservationId_kind: { reservationId: reservation.id, kind: input.kind } },
    create: {
      organizationId: reservation.organizationId,
      reservationId: reservation.id,
      kind: input.kind,
      fileKey,
      filename: input.filename,
    },
    update: {
      fileKey,
      filename: input.filename,
      uploadedAt: new Date(),
    },
  });

  return {
    ok: true,
    data: {
      id: row.id,
      kind: row.kind,
      filename: row.filename,
      uploadedAt: row.uploadedAt.toISOString(),
    },
    status: 201,
  };
}

export async function deleteReservationDocByToken(
  token: string,
  kind: string,
): Promise<Result<{ deleted: true }>> {
  const gated = await loadReservationByToken(token);
  if (!gated.ok) return gateError(gated.reason);
  const { reservation } = gated;

  const existing = await getDb().unitReservationDocument.findUnique({
    where: { reservationId_kind: { reservationId: reservation.id, kind } },
  });
  if (!existing) return { ok: false, error: "Not found", status: 404 };

  await deleteObject(requireBucket(), existing.fileKey);
  await getDb().unitReservationDocument.delete({ where: { id: existing.id } });

  return { ok: true, data: { deleted: true }, status: 200 };
}

export async function getReservationDocViewUrlForAdmin(
  orgId: string,
  reservationId: string,
  docId: string,
): Promise<Result<{ url: string; expiresAt: string }>> {
  const doc = await getDb().unitReservationDocument.findFirst({
    where: { id: docId, reservationId, organizationId: orgId },
  });
  if (!doc) return { ok: false, error: "Not found", status: 404 };

  const url = await createSignedDownloadUrl(doc.fileKey, { ttlSeconds: VIEW_URL_TTL_SEC });
  return {
    ok: true,
    data: {
      url,
      expiresAt: new Date(Date.now() + VIEW_URL_TTL_SEC * 1000).toISOString(),
    },
    status: 200,
  };
}
