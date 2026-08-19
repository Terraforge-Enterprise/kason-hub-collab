import { getDb } from "@kason/db";
import { tenantVisibleDocumentWhere } from "@kason/shared";
import { remainingCreditByNote } from "../../billing-documents/credit-apply.service";

type SessionScope = { partyId: string; orgId: string };

export type PortalDocItem = {
  id: string;
  fileName: string;
  fileType: string;
  /** Bytes. 0 = unknown: reservation-backed files carry no size column, and the
   *  portal Documents page does not render this field. Never treat as "empty file". */
  fileSize: number;
  storageKey: string;
  label: string | null;
  createdAt: string;
};

/** Human labels for the reservation identification scans (kinds per
 *  reservations/validation.ts RESERVATION_DOC_KINDS). */
const ID_DOC_LABEL: Record<string, string> = {
  passport_front: "Identification · Passport (front)",
  passport_back: "Identification · Passport (back)",
  ic_front: "Identification · IC (front)",
  ic_back: "Identification · IC (back)",
};

/** Best-effort content type from a filename — the reservation stores no MIME column. */
function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

/**
 * The tenant's OWN reservation-backed files: the signed reservation PDF, plus the
 * identification scans they uploaded during the reservation flow.
 *
 * THIS IS THE SINGLE OWNERSHIP PREDICATE for those files. Both `listDocuments` and
 * `verifyFileOwnership` resolve through it, so "listed" and "downloadable" cannot
 * drift apart — a row that lists but 404s is a dead end, and a key that downloads
 * without listing is a leak. Do not re-derive this scope anywhere else.
 *
 * Scope: `UnitReservation.tenantPartyId = session.partyId` AND
 * `organizationId = session.orgId`. `tenantPartyId` is the same link that draws the
 * admin tenant list's "Has reservation" tag, so what the admin sees as attached to
 * this tenant is exactly what the tenant can read back — no more.
 *
 * Deliberately NOT gated on holding a Tenancy: a tenant whose reservation is signed
 * but whose tenancy has not been created yet still owns that document.
 */
async function listReservationFiles(session: SessionScope): Promise<PortalDocItem[]> {
  const db = getDb();

  const reservations = await db.unitReservation.findMany({
    where: { organizationId: session.orgId, tenantPartyId: session.partyId },
    select: {
      id: true,
      referenceCode: true,
      signedPdfKey: true,
      signedAt: true,
      issuedAt: true,
      documents: { select: { id: true, kind: true, fileKey: true, filename: true, uploadedAt: true } },
    },
  });

  const out: PortalDocItem[] = [];
  for (const r of reservations) {
    if (r.signedPdfKey) {
      out.push({
        // Synthetic, prefixed id — cannot collide with a Document uuid.
        id: `reservation:${r.id}:signed`,
        fileName: `${r.referenceCode}-signed.pdf`,
        fileType: "application/pdf",
        fileSize: 0,
        storageKey: r.signedPdfKey,
        // "agreement" makes the page's Agreements chip match (classifyDoc keys off the
        // label text). It says RESERVATION agreement on purpose: reservation-terms.ts
        // states this form "does not constitute a formal tenancy agreement", so calling
        // it one here would misdescribe a signed document back to the person who signed it.
        label: `Signed Reservation Agreement · ${r.referenceCode}`,
        createdAt: (r.signedAt ?? r.issuedAt).toISOString(),
      });
    }
    for (const d of r.documents) {
      out.push({
        id: `reservation-doc:${d.id}`,
        fileName: d.filename,
        fileType: contentTypeFor(d.filename),
        fileSize: 0,
        storageKey: d.fileKey,
        label: ID_DOC_LABEL[d.kind] ?? `Identification · ${d.kind}`,
        createdAt: d.uploadedAt.toISOString(),
      });
    }
  }
  return out;
}

/** Documents linked to this tenant's tenancies via the DocumentLink store. */
async function listTenancyLinkedDocuments(session: SessionScope): Promise<PortalDocItem[]> {
  const db = getDb();

  const tenancies = await db.tenancy.findMany({
    where: { tenantPartyId: session.partyId, organizationId: session.orgId },
    select: { id: true },
  });
  const tenancyIds = tenancies.map((t) => t.id);
  if (tenancyIds.length === 0) return [];

  const links = await db.documentLink.findMany({
    where: {
      organizationId: session.orgId,
      linkedEntityType: "tenancy",
      linkedEntityId: { in: tenancyIds },
    },
    include: {
      document: {
        select: {
          id: true,
          fileName: true,
          fileType: true,
          fileSize: true,
          storageKey: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return links.map((l) => ({
    id: l.document.id,
    fileName: l.document.fileName,
    fileType: l.document.fileType,
    fileSize: l.document.fileSize,
    storageKey: l.document.storageKey,
    label: l.label,
    createdAt: l.document.createdAt.toISOString(),
  }));
}

/**
 * GET /portal-api/documents — everything this tenant may read, newest first.
 *
 * Two sources. DocumentLink (tenancy-linked uploads) is the original one; note that
 * nothing in the application writes it today — its only writer is the seed script —
 * so on a real tenancy it contributes nothing. Reservation-backed files are what a
 * real tenant actually has.
 */
export async function listDocuments(session: SessionScope): Promise<PortalDocItem[]> {
  const [linked, reservation] = await Promise.all([
    listTenancyLinkedDocuments(session),
    listReservationFiles(session),
  ]);
  return [...linked, ...reservation].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Ownership gate for GET /portal-api/files?key=… — returns the file when this tenant
 * may read it, null otherwise (→ 404, never leak existence).
 *
 * Resolves through the SAME two sources as `listDocuments`, so the set of downloadable
 * keys is exactly the set of listed keys. The reservation branch is a linear scan over
 * the tenant's own handful of files, which is the cheap price of that guarantee.
 */
export async function verifyFileOwnership(session: SessionScope, storageKey: string) {
  const db = getDb();

  const tenancies = await db.tenancy.findMany({
    where: { tenantPartyId: session.partyId, organizationId: session.orgId },
    select: { id: true },
  });
  const tenancyIds = tenancies.map((t) => t.id);

  if (tenancyIds.length > 0) {
    const link = await db.documentLink.findFirst({
      where: {
        document: { storageKey },
        linkedEntityType: "tenancy",
        linkedEntityId: { in: tenancyIds },
        organizationId: session.orgId,
      },
      include: {
        document: { select: { storageKey: true, fileName: true, fileType: true } },
      },
    });
    if (link?.document) return link.document;
  }

  const own = await listReservationFiles(session);
  const hit = own.find((f) => f.storageKey === storageKey);
  return hit ? { storageKey: hit.storageKey, fileName: hit.fileName, fileType: hit.fileType } : null;
}

// ── Accounting docs (tenant-visible BillingDocuments) ───────────────────────

export type PortalBillingDocItem = {
  id: string;
  docType: string;
  documentNumber: string;
  status: string;
  issuedAt: string;
  billingMonth: string | null;
  total: string;
  reason: string | null;
  originalDocumentNumber: string | null;
  /**
   * For a CREDIT NOTE only: how much of it is still unspent, 2-dp string.
   * `null` on every other doc type, and on a note that has been fully consumed.
   *
   * Why the tenant needs it: the note's `total` says a credit was ISSUED, which
   * reads as history. This says money is still sitting on their account waiting
   * to come off a future bill — the difference between "you were credited RM50
   * once" and "you hold RM50". Without it a tenant had no way to see the credit
   * at all, only the document that created it.
   */
  creditRemaining: string | null;
};

function money2dp(v: { toString(): string }): string {
  const n = parseFloat(v.toString());
  return Number.isNaN(n) ? "0.00" : n.toFixed(2);
}

/** THIS tenant's issued documents (own-data-only: partyId + org scoped). */
export async function listTenantBillingDocuments(scope: { partyId: string; orgId: string }): Promise<PortalBillingDocItem[]> {
  const db = getDb();
  const rows = await db.billingDocument.findMany({
    where: {
      organizationId: scope.orgId,
      partyId: scope.partyId,
      counterpartyType: "tenant",
      // Un-issued documents are not the tenant's to see. Nothing writes DRAFT
      // today (the column defaults to ISSUED), so this is a forward guard: the
      // day an admin-side draft-document workflow lands, it must not appear in
      // the portal by default. CANCELLED/SUPERSEDED stay visible — those were
      // genuinely issued and their replacements reference them.
      ...tenantVisibleDocumentWhere(),
      // ...except a REPLACED PROFORMA (R9). A proforma is a request for payment the
      // workflow replaces whole whenever the month's charges change, so once re-billing
      // is routine a tenant would open Documents and find three PI- numbers for one
      // month with no way to tell which to pay. Scoped to proforma deliberately: a
      // cancelled invoice or credit note IS a real record and stays visible.
      NOT: { docType: "proforma", documentStatus: "CANCELLED" },
    },
    select: {
      id: true, docType: true, documentNumber: true, status: true, issuedAt: true,
      billingMonth: true, total: true, reason: true, originalDocumentId: true,
      creditAmount: true,
    },
    orderBy: { issuedAt: "desc" },
    take: 200,
  });
  const originalIds = [...new Set(rows.map((r) => r.originalDocumentId).filter((x): x is string => x !== null))];
  const originals = originalIds.length
    ? await db.billingDocument.findMany({
        where: { organizationId: scope.orgId, id: { in: originalIds } },
        select: { id: true, documentNumber: true },
      })
    : [];
  const originalNumber = new Map(originals.map((o) => [o.id, o.documentNumber]));
  // Unapplied balance per credit note, from the SAME derivation the appliers use
  // (creditAmount − Σ applied) — a tenant must never be shown credit that an
  // apply call would refuse to spend. One batched query for the whole page.
  const remaining = await remainingCreditByNote(
    db,
    scope.orgId,
    rows
      .filter((r) => r.docType === "credit_note" && r.creditAmount !== null)
      .map((r) => ({ id: r.id, creditAmount: Number(r.creditAmount!.toString()) })),
  );
  return rows.map((r) => ({
    id: r.id,
    docType: r.docType,
    documentNumber: r.documentNumber,
    status: r.status,
    issuedAt: r.issuedAt.toISOString(),
    billingMonth: r.billingMonth ? r.billingMonth.toISOString().slice(0, 10) : null,
    total: money2dp(r.total),
    reason: r.reason,
    originalDocumentNumber: r.originalDocumentId ? (originalNumber.get(r.originalDocumentId) ?? null) : null,
    creditRemaining: remaining.has(r.id) ? money2dp(remaining.get(r.id)!) : null,
  }));
}

/** Own-document check for the PDF route — null when not this tenant's doc. */
export async function findOwnTenantBillingDocument(scope: { partyId: string; orgId: string }, id: string): Promise<{ id: string } | null> {
  const db = getDb();
  // Gates the PDF download. Must apply the SAME visibility filter as the list
  // above — otherwise a document hidden from the list is still downloadable by
  // id, which is the more damaging leak of the two (it hands over the rendered
  // document, not just a row).
  return db.billingDocument.findFirst({
    where: {
      id,
      organizationId: scope.orgId,
      partyId: scope.partyId,
      counterpartyType: "tenant",
      ...tenantVisibleDocumentWhere(),
      // Kept in lock-step with the list's R9 filter above.
      NOT: { docType: "proforma", documentStatus: "CANCELLED" },
    },
    select: { id: true },
  });
}
