// Multi-month statement export (Task D1) — a streamed ZIP of an owner's CLEAN
// statement PDFs (and, optionally, their separate proof packs) over a month range.
//
// Three binding properties:
//   1. PURE renderer — each statement's bytes come from `renderCleanStatementPdfBytes`
//      (side-effect-free; no putObject / pdfKey write / audit), OR are served from the
//      already-stored `Invoice.pdfKey` via `fetchStorageBuffer` to skip a re-render.
//      We NEVER call the side-effectful `regenerateStatementPdf` here.
//   2. POST-ONLY + owner-scoped — only an owner's POSTED statements
//      (PORTAL_VISIBLE_STATEMENT_STATUSES) in range are included; drafts/void are
//      excluded by the Prisma WHERE. The caller supplies the ownerPartyId (the admin
//      route from a query, the portal route ALWAYS from the session).
//   3. BOUNDED — the range is capped at ≤24 months (CPU: ≤24 renders) and the archive
//      is STREAMED (the consumer drains each entry before the next is appended), so
//      memory stays bounded regardless of range size.
import archiver from "archiver";
import { getDb } from "@kason/db";
import { fetchStorageBuffer } from "../../lib/storage";
import { renderCleanStatementPdfBytes } from "./owner-billing.service";
import { buildProofPackPdf } from "./proof-pack.service";
import { PORTAL_VISIBLE_STATEMENT_STATUSES } from "./owner-statement-visibility";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

/** Hard cap on the range span — bounds CPU (each month = at most one render). */
export const MAX_RANGE_MONTHS = 24;

const MONTH_RE = /^\d{4}-\d{2}$/;

/** A POST-only statement resolved for the export (one ZIP entry each). */
export interface ResolvedStatement {
  id: string;
  /** First-of-month UTC billing period (never null — the WHERE excludes nulls). */
  periodMonth: Date;
  /** Per-apartment scope (Invoice.apartmentId); null = legacy combined statement. */
  apartmentId: string | null;
  /** Stored soft-copy key, reused to skip a re-render when the bytes are present. */
  pdfKey: string | null;
  status: string;
}

export interface MonthRangeExportParams {
  ownerPartyId: string;
  /** "YYYY-MM" inclusive lower bound. */
  fromMonth: string;
  /** "YYYY-MM" inclusive upper bound. */
  toMonth: string;
  /** When true, append each month's separate proof pack (`bills-*.pdf`) too. */
  includeProof: boolean;
}

/** A write-only sink (Hono's StreamingApi, or a test collector) the ZIP drains into. */
export interface ZipSink {
  write(chunk: Uint8Array): unknown | Promise<unknown>;
}

type RangeValidation = { ok: true; from: Date; to: Date } | { ok: false; error: string };

/** "YYYY-MM" → first-of-month UTC Date (the billing period's stored shape). */
function firstOfMonthUtc(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/** "YYYY-MM" from a first-of-month UTC Date. */
function monthKey(periodMonth: Date): string {
  return periodMonth.toISOString().slice(0, 7);
}

/** Inclusive count of calendar months from `from` to `to` (same month ⇒ 1). */
function monthSpanInclusive(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
}

/**
 * Validate the requested range BEFORE any streaming starts (a 200 stream can't be
 * turned back into a 400): both bounds "YYYY-MM", from ≤ to, span ≤ 24 months.
 * Returns the parsed Date bounds on success, else a human-readable error string the
 * route maps to a 400.
 */
export function validateExportRange(fromMonth: string, toMonth: string): RangeValidation {
  if (!MONTH_RE.test(fromMonth) || !MONTH_RE.test(toMonth)) {
    return { ok: false, error: "fromMonth and toMonth must be in YYYY-MM format" };
  }
  const from = firstOfMonthUtc(fromMonth);
  const to = firstOfMonthUtc(toMonth);
  if (from.getTime() > to.getTime()) {
    return { ok: false, error: "fromMonth must be on or before toMonth" };
  }
  if (monthSpanInclusive(from, to) > MAX_RANGE_MONTHS) {
    return { ok: false, error: `range must not exceed ${MAX_RANGE_MONTHS} months` };
  }
  return { ok: true, from, to };
}

/**
 * Resolve an owner's POST-only owner-statements within [fromMonth, toMonth] (org-scoped).
 * Reuses PORTAL_VISIBLE_STATEMENT_STATUSES so drafts/void are never exported. Ordered by
 * month then apartment for a stable ZIP. Used by the routes for the pre-stream emptiness
 * check (empty ⇒ 404) AND by `streamMonthRangeZip` itself.
 */
export async function resolveOwnerStatementsInRange(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  fromMonth: string,
  toMonth: string,
): Promise<ResolvedStatement[]> {
  const rows = await getDb().invoice.findMany({
    where: {
      organizationId: ctx.orgId,
      ownerPartyId,
      invoiceType: "owner_statement",
      status: { in: [...PORTAL_VISIBLE_STATEMENT_STATUSES] },
      periodMonth: { gte: firstOfMonthUtc(fromMonth), lte: firstOfMonthUtc(toMonth) },
    },
    select: { id: true, periodMonth: true, apartmentId: true, pdfKey: true, status: true },
    orderBy: [{ periodMonth: "asc" }, { apartmentId: "asc" }],
  });
  return rows
    .filter((r): r is typeof r & { periodMonth: Date } => r.periodMonth !== null)
    .map((r) => ({
      id: r.id,
      periodMonth: r.periodMonth,
      apartmentId: r.apartmentId ?? null,
      pdfKey: r.pdfKey ?? null,
      status: r.status,
    }));
}

/** Apartment segment for an entry name: "-<apt8>" when scoped, "" for legacy combined. */
function aptSegment(apartmentId: string | null): string {
  return apartmentId ? `-${apartmentId.slice(0, 8)}` : "";
}

/**
 * Bytes for one statement entry: serve the already-stored soft copy when present
 * (no re-render), else render the CLEAN PDF with the PURE renderer.
 */
async function statementBytes(ctx: OwnerBillingActorCtx, stmt: ResolvedStatement): Promise<Buffer> {
  if (stmt.pdfKey) {
    const stored = await fetchStorageBuffer(stmt.pdfKey);
    if (stored) return stored;
  }
  return renderCleanStatementPdfBytes(ctx, stmt.id);
}

/**
 * Stream a ZIP of the owner's POST-only statements in range into `sink`.
 *
 * Per statement: `statement-<YYYY-MM>[-<apt>].pdf` (clean PDF). When
 * `includeProof`, also `bills-<YYYY-MM>[-<apt>].pdf` for months whose proof pack is
 * non-null. The archive is produced and drained CONCURRENTLY — the for-await loop
 * applies backpressure so only ~one entry is in memory at a time. A producer error
 * (e.g. a failed render) destroys the archive so the consumer rejects with that
 * error instead of hanging.
 *
 * The caller MUST pre-validate the range (`validateExportRange`) and the non-empty
 * result (`resolveOwnerStatementsInRange`) — once a chunk is written the HTTP status
 * is already 200.
 */
export async function streamMonthRangeZip(
  ctx: OwnerBillingActorCtx,
  params: MonthRangeExportParams,
  sink: ZipSink,
): Promise<void> {
  const statements = await resolveOwnerStatementsInRange(ctx, params.ownerPartyId, params.fromMonth, params.toMonth);

  const archive = archiver("zip", { zlib: { level: 9 } });
  // Non-fatal issues (e.g. stat failures) must not abort the whole download.
  archive.on("warning", (err: Error) => {
    // eslint-disable-next-line no-console
    console.warn(`[owner-billing] multi-month-export: archiver warning: ${err?.message ?? err}`);
  });

  // Producer: append every entry then finalize. Runs concurrently with the drain.
  const produce = (async () => {
    for (const stmt of statements) {
      const month = monthKey(stmt.periodMonth);
      archive.append(await statementBytes(ctx, stmt), {
        name: `statement-${month}${aptSegment(stmt.apartmentId)}.pdf`,
      });
      if (params.includeProof) {
        const proof = await buildProofPackPdf(ctx, params.ownerPartyId, month, stmt.apartmentId);
        if (proof) {
          archive.append(Buffer.from(proof), { name: `bills-${month}${aptSegment(stmt.apartmentId)}.pdf` });
        }
      }
    }
    await archive.finalize();
  })();
  // On a producer error, destroy the archive so the for-await below rejects with the
  // ORIGINAL error (a `destroy(err)` surfaces `err` through the async iterator) rather
  // than hanging on a stream that never ends. The `.catch` also prevents an unhandled
  // rejection — the error is re-surfaced to the caller via the consumer loop.
  produce.catch((err: unknown) => archive.destroy(err instanceof Error ? err : new Error(String(err))));

  try {
    for await (const chunk of archive as AsyncIterable<Buffer>) {
      await sink.write(chunk);
    }
  } catch (err) {
    if (!archive.destroyed) archive.destroy();
    throw err;
  }
  // Re-throw a producer error that happened after the stream had already ended cleanly.
  await produce;
}
