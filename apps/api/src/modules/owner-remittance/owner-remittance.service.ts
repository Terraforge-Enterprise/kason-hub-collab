// Phase-2 owner remittance — POST /owner-remittances service (Task 6) +
// POST /owner-remittances/:id/allocate service (Task 7).
// Plan: docs/superpowers/plans/2026-07-20-rent-reclassification-phase2-remittance-offset.md (Task 6/7).
// Spec: docs/superpowers/specs/2026-07-20-rental-reclassification-owner-payable-completion-design.md
// (R8/R9/R25; GC1-GC10).
//
// recordRemittanceService: ONE `getDb().$transaction`, guards run in the
// EXACT numbered order below (0a pre-tx; 1-13 in-tx), every money-mutating
// write lands in that SAME transaction, notify runs AFTER commit only for a
// freshly-created entry. Any guard breach throws RemittanceGuardError, which
// rolls back the whole tx (nothing written) and maps to the matching
// {status, error} pair. Behavior inventory + RED/GREEN evidence for every
// guard: apps/api/src/modules/owner-remittance/__tests__/remittance.integration.test.ts.
//
// allocatePreStatementService (Task 7): same conventions (ONE locked tx,
// AllocateGuardError → {status,error} mapping, whole-tx rollback on any
// breach). See its own docstring below for the guard order and the
// idempotency design (no fingerprint column exists on OwnerRemittanceAllocation
// — retry-safety comes from the table's own
// @@unique([organizationId, payoutEntryId, ownerStatementPeriodId])
// instead). Behavior inventory + RED/GREEN evidence:
// apps/api/src/modules/owner-remittance/__tests__/allocate.integration.test.ts.
import { z } from "zod";
import { getDb } from "@kason/db";
import { toCents, centsToString } from "@kason/shared";
import { computeRequestFingerprint } from "@kason/shared/owner-remittance";
import type {
  RemittanceCreateInput,
  RemittanceAllocateInput,
  OffsetCreateInput,
  ReverseInput,
} from "@kason/shared";
import {
  lockOwnerPayable,
  findEntryByIdempotency,
  computeAvailableOwnerPayableC,
  periodRemainingPayableC,
  insertPayoutEntry,
  insertRemittanceAllocations,
  settleIvownChargeTx,
} from "./owner-remittance.repository";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { mintDocumentNumberTx } from "../../lib/reference-codes/series-numbers";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { notifyOwnerOfRemittance, notifyOwnerOfReversal } from "./owner-remittance.notify";
import { refreshDocumentStatusForCharges } from "../billing-documents/status.service";
import { StaleError, PartyMismatchError, restoreChargeTx } from "../payments/payments.repository";
import { derivePeriodRemittanceStatus } from "./owner-remittance.status";
import type { PeriodRemittanceStatus } from "./owner-remittance.status";

// ─── Actor + result types ──────────────────────────────────────────────────

export interface RemittanceActorCtx {
  orgId: string;
  actorUserId: string;
  actorRole: string;
  ip?: string;
  userAgent?: string;
}

type RemittanceOk = { ok: true; status: 200 | 201; data: { entryId: string } };
type RemittanceErr = { ok: false; status: 404 | 409 | 422; error: string };
export type RecordRemittanceResult = RemittanceOk | RemittanceErr;

/** Thrown inside the transaction on any guard breach — rolls back the whole
 *  tx (Prisma re-throws on a callback throw) and is mapped back to a
 *  ServiceResult by the outer catch. Never escapes recordRemittanceService. */
class RemittanceGuardError extends Error {
  constructor(
    public code: string,
    public httpStatus: 404 | 409 | 422,
  ) {
    super(code);
    this.name = "RemittanceGuardError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export async function recordRemittanceService(
  actor: RemittanceActorCtx,
  input: RemittanceCreateInput,
): Promise<RecordRemittanceResult> {
  // 0a. AMOUNT_TOO_LARGE (422) [B25] — pre-tx, pure: check the STRING
  // integer-part length BEFORE any toCents conversion (avoids float-precision
  // loss on a many-digit string). OwnerLedgerEntry.amount is Decimal(12,2) —
  // max 10 integer digits (9999999999.99).
  const integerPartLength = input.amount.split(".")[0]!.length;
  if (integerPartLength > 10) {
    return { ok: false, status: 422, error: "AMOUNT_TOO_LARGE" };
  }

  // R25/GC6: sha256 of the canonicalized payload with idempotencyKey stripped.
  // Computed ONCE, pre-tx (pure) — compared against the stored fingerprint on
  // a matching (org, settlementKind, idempotencyKey) triple below.
  const fingerprint = computeRequestFingerprint(input);

  // GC2: convert the input amount string → cents ONCE, here, at the service
  // boundary. Everything downstream of this point is integer cents.
  const amountC = toCents(input.amount, "recordRemittanceService");

  // redesign P1 — REM- remittance display number. This is the ONLY call site
  // that mints one: a real cash-out payout (OWNER_REMITTANCE or
  // PRE_STATEMENT_REMITTANCE — both land here). recordOffsetService
  // (OWNER_RECEIVABLE_OFFSET) and reverseRemittanceService/reverseOffsetService
  // deliberately never mint — neither is new cash to the owner. Lazily ensure
  // the org's REM series exists BEFORE the tx (own connection, same
  // lazy-ensure convention as OST/EXP) — skipped entirely when the flag is
  // off (zero behavior change, no extra round-trip). A REPLAY (guard 2 below)
  // returns early and never reaches the mint call, so a retry never burns a
  // second number for the same logical remittance.
  const shouldMintRem = isPhase2FlagEnabled("ENABLE_OWNER_DOC_NUMBERING");
  if (shouldMintRem) {
    await ensureChargeCategorySeeds(actor.orgId);
  }

  let txResult: { kind: "replay" | "created"; entryId: string };
  try {
    txResult = await getDb().$transaction(async (tx) => {
      // 1. Owner-level advisory lock — FIRST, before any read of payable (GC3).
      await lockOwnerPayable(tx, actor.orgId, input.ownerPartyId);

      // 2. Idempotency (GC6). Status-agnostic read (findEntryByIdempotency
      // matches even a voided prior row) — same fingerprint ⇒ REPLAY (return
      // the existing success, write nothing); different fingerprint ⇒ 409.
      const existing = await findEntryByIdempotency(
        tx,
        actor.orgId,
        input.settlementKind,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          return { kind: "replay" as const, entryId: existing.id };
        }
        throw new RemittanceGuardError("IDEMPOTENCY_KEY_REUSED", 409);
      }

      // 3. Reversal-aware available payable (cents), read inside the SAME
      // locked tx as the guard+write that follows (GC3).
      const availableC = await computeAvailableOwnerPayableC(tx, actor.orgId, input.ownerPartyId);

      // 4. OVER_REMITTANCE (409) — applies identically to BOTH settlementKind
      // values; structurally impossible to bypass, never surfaced as a status
      // on the created row (there is no created row when this fires).
      if (amountC > availableC) {
        throw new RemittanceGuardError("OVER_REMITTANCE", 409);
      }

      // 5. Load each allocation's OwnerStatementPeriod. Aggregate by
      // ownerStatementPeriodId FIRST (B33) — two lines to the same period are
      // summed, not double-counted; required because
      // @@unique([org, payoutEntryId, ownerStatementPeriodId]) forbids two
      // allocation rows for one period from one payout.
      const aggregatedC = new Map<string, number>();
      for (const line of input.allocations) {
        const lineC = toCents(line.allocatedAmount, "recordRemittanceService.allocation");
        aggregatedC.set(
          line.ownerStatementPeriodId,
          (aggregatedC.get(line.ownerStatementPeriodId) ?? 0) + lineC,
        );
      }

      // propertyId-derivation ingredients (guard 8, below), gathered here
      // because this is where each period's apartmentId is on hand — the
      // DERIVATION itself (a pure computation, no rejection) happens after
      // guard 7 to match the spec's step numbering; collecting the raw
      // per-period facts during this loop is data prep, not a guard.
      let sawCombinedOrNullScope = false;
      const distinctPropertyIds = new Set<string>();

      for (const [periodId, sumC] of aggregatedC) {
        // Org-scoped lookup (Finding 3): a period id belonging to a
        // different org — or no period at all — resolves to null here
        // (findFirst never throws), never a silent cross-org read.
        const period = await tx.ownerStatementPeriod.findFirst({
          where: { id: periodId, organizationId: actor.orgId },
          select: { ownerPartyId: true, apartmentId: true },
        });
        if (!period) {
          throw new RemittanceGuardError("OWNER_STATEMENT_PERIOD_NOT_FOUND", 404);
        }
        if (period.ownerPartyId !== input.ownerPartyId) {
          throw new RemittanceGuardError("OWNER_MISMATCH", 422);
        }

        const remainingC = await periodRemainingPayableC(tx, actor.orgId, periodId);
        if (sumC > remainingC) {
          throw new RemittanceGuardError("ALLOCATION_EXCEEDS_PERIOD", 409);
        }

        if (period.apartmentId == null) {
          sawCombinedOrNullScope = true; // combined-scope period ⇒ never attributable to one property
        } else {
          const apt = await tx.apartment.findFirst({
            where: { id: period.apartmentId, organizationId: actor.orgId },
            select: { propertyId: true },
          });
          // OwnerStatementPeriod.apartmentId carries no FK (plain column, like
          // OwnerLedgerEntry.apartmentId) — defensively treat an unresolvable
          // reference the SAME as combined-scope (never guess a propertyId).
          if (apt) distinctPropertyIds.add(apt.propertyId);
          else sawCombinedOrNullScope = true;
        }
      }

      // 6. CURRENCY_MISMATCH (422) [GC10] — loaded fresh inside the tx. A
      // missing org row (actor.orgId is FK-guaranteed via the session's
      // User row; "missing" should never happen in practice) throws via
      // findFirstOrThrow rather than silently skipping the comparison — a
      // money guard must never fail open. Matches the codebase's established
      // *OrThrow convention for this exact "look up the session's org"
      // lookup (organization/service.ts, reservations/service.ts,
      // bills-grid/{service,recurring.service}.ts, document-templates/
      // {repository,service}.ts all use findUnique/findFirstOrThrow here).
      // Deliberately NOT a RemittanceGuardError/user-facing money code: the
      // Prisma NotFoundError propagates uncaught to app.ts's global
      // onError → plain internal 500, which is the correct shape for a
      // should-never-happen condition, not a domain guard outcome.
      const org = await tx.organization.findFirstOrThrow({
        where: { id: actor.orgId },
        select: { defaultCurrency: true },
      });
      if (input.currency !== org.defaultCurrency) {
        throw new RemittanceGuardError("CURRENCY_MISMATCH", 422);
      }

      // 7. Allocation-total bound, both kinds (spec R9: "Σ active allocations
      // = payout amount" for OWNER_REMITTANCE; a PRE_STATEMENT_REMITTANCE
      // "may be created partly/fully unallocated" — under-allocation only,
      // NEVER over). OWNER_REMITTANCE must match EXACTLY
      // (REMITTANCE_NOT_FULLY_ALLOCATED on any ≠). PRE_STATEMENT_REMITTANCE
      // may be under-allocated (the unallocated remainder is exactly what
      // Task 7's top-up endpoint later consumes) but never over-allocated —
      // ALLOCATION_EXCEEDS_UNALLOCATED on Σ > amountC, same error code Task 7
      // uses for the identical Σ ≤ amount invariant at top-up time.
      const totalAllocatedC = [...aggregatedC.values()].reduce((sum, c) => sum + c, 0);
      if (input.settlementKind === "OWNER_REMITTANCE" && totalAllocatedC !== amountC) {
        throw new RemittanceGuardError("REMITTANCE_NOT_FULLY_ALLOCATED", 409);
      }
      if (input.settlementKind === "PRE_STATEMENT_REMITTANCE" && totalAllocatedC > amountC) {
        throw new RemittanceGuardError("ALLOCATION_EXCEEDS_UNALLOCATED", 409);
      }

      // 8. propertyId derivation (user decision) — never a sentinel; null
      // unless EVERY allocation resolves to exactly the SAME single
      // property (no combined-scope/null-apartment period in the mix). An
      // empty aggregatedC (never reachable today — the Zod schema requires
      // allocations.min(1) — but kept correct defensively) also falls
      // through to null via the SAME expression (distinctPropertyIds.size
      // would be 0, not 1).
      const propertyId: string | null =
        !sawCombinedOrNullScope && distinctPropertyIds.size === 1
          ? [...distinctPropertyIds][0]!
          : null;

      // 9. Bank proof (R8) — a bank remittance is never silently proofless;
      // it is surfaced as PROOF_PENDING until attached, never rejected.
      // Any other paymentMethod (cash/cheque/other) carries no proof concept.
      const proofStatus: string | null =
        input.paymentMethod === "bank_transfer"
          ? input.proofKey
            ? "PROOF_ATTACHED"
            : "PROOF_PENDING"
          : null;

      // 10. Write the payout entry. Mint the REM- number (if due) immediately
      // before the write, INSIDE this transaction — mintDocumentNumberTx's own
      // contract: a rollback (any guard above threw, or one later fails) burns
      // nothing, no gap.
      let remittanceNumber: string | null = null;
      if (shouldMintRem) {
        const series = await tx.documentSeries.findFirst({
          where: { organizationId: actor.orgId, code: "REM" },
        });
        if (series) {
          remittanceNumber = await mintDocumentNumberTx(tx, actor.orgId, series, new Date());
        } else {
          // Non-fatal, defense-in-depth (ensureChargeCategorySeeds above is
          // expected to always have created it) — the remittance itself must
          // never fail because of the display-number side effect.
          // eslint-disable-next-line no-console
          console.warn(`[owner-remittance] record: REM series not found for org ${actor.orgId} — recorded without a number`);
        }
      }
      const created = await insertPayoutEntry(tx, {
        orgId: actor.orgId,
        ownerPartyId: input.ownerPartyId,
        propertyId,
        settlementKind: input.settlementKind,
        amount: input.amount,
        effectiveDate: new Date(input.effectiveDate),
        paymentMethod: input.paymentMethod,
        bankReference: input.bankReference ?? null,
        proofKey: input.proofKey ?? null,
        proofStatus,
        memo: input.memo ?? null,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdById: actor.actorUserId,
        updatedById: actor.actorUserId,
        remittanceNumber,
      });

      // 11. Write the AGGREGATED-by-period allocations (unique per period).
      const allocationInputs = [...aggregatedC.entries()].map(([ownerStatementPeriodId, allocatedAmountC]) => ({
        ownerStatementPeriodId,
        allocatedAmountC,
      }));
      await insertRemittanceAllocations(tx, actor.orgId, created.id, allocationInputs, actor.actorUserId);

      // 12. Audit — same tx, so it rolls back with everything else on any
      // LATER failure (there is none past this point today, but the
      // invariant holds regardless of future additions).
      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_remittance.record",
        entityType: "OwnerLedgerEntry",
        entityId: created.id,
        diff: {
          after: {
            id: created.id,
            ownerPartyId: input.ownerPartyId,
            propertyId,
            settlementKind: input.settlementKind,
            amountC,
            paymentMethod: input.paymentMethod,
            proofStatus,
            allocations: allocationInputs,
          },
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      // 13. Commit (implicit on return from the $transaction callback).
      return { kind: "created" as const, entryId: created.id };
    });
  } catch (err) {
    if (err instanceof RemittanceGuardError) {
      return { ok: false, status: err.httpStatus, error: err.code };
    }
    throw err;
  }

  // Notify AFTER commit, best-effort — never on replay (a replay is not a
  // new event; no second notify). notifyOwnerOfRemittance never throws
  // (internal try/catch, payments.owner-notify.ts precedent) — no wrapping
  // try/catch needed here, matching that precedent's call sites exactly.
  if (txResult.kind === "created") {
    await notifyOwnerOfRemittance(actor.orgId, input.ownerPartyId, input.amount, input.settlementKind);
  }

  return {
    ok: true,
    status: txResult.kind === "replay" ? 200 : 201,
    data: { entryId: txResult.entryId },
  };
}

// ─── Task 7: allocatePreStatementService ───────────────────────────────────

type AllocateOk = { ok: true; status: 200; data: { entryId: string; unallocatedC: number } };
type AllocateErr = { ok: false; status: 400 | 404 | 409 | 422; error: string };
export type AllocateRemittanceResult = AllocateOk | AllocateErr;

/**
 * Thrown inside allocatePreStatementService's transaction on any guard
 * breach — same rollback contract as RemittanceGuardError above (Prisma
 * re-throws on a callback throw, rolling back the whole tx). Kept as a
 * SEPARATE class rather than widening RemittanceGuardError's httpStatus
 * union to include 400: RemittanceGuardError's `err.httpStatus` flows
 * straight into recordRemittanceService's `RemittanceErr.status
 * (404|409|422)` return type above — widening it to admit 400 (which
 * recordRemittanceService never throws) would break that already-shipped
 * function's own typecheck for no benefit. Never escapes
 * allocatePreStatementService.
 */
class AllocateGuardError extends Error {
  constructor(
    public code: string,
    public httpStatus: 400 | 404 | 409 | 422,
  ) {
    super(code);
    this.name = "AllocateGuardError";
  }
}

const entryIdSchema = z.string().uuid();

/**
 * Adds allocations to an existing PRE_STATEMENT_REMITTANCE (created
 * partly/fully unallocated by recordRemittanceService, above), up to the
 * entry's total amount. ONE `getDb().$transaction`, guards run in the EXACT
 * numbered order below (0 pre-tx; 1-9 in-tx). Any guard breach throws
 * AllocateGuardError, rolling back the whole tx (nothing written).
 *
 * IDEMPOTENCY (GC6) — the request schema (Task 4's remittanceAllocateSchema)
 * requires `idempotencyKey`, but it is deliberately UNREAD here.
 * OwnerRemittanceAllocation carries NO idempotencyKey/requestFingerprint
 * column (unlike OwnerLedgerEntry, which Task 6's create endpoint keys its
 * own fingerprint-based replay detection on) — there is no natural slot to
 * persist a per-call fingerprint for a "top up an existing entry" operation.
 * Retry-safety instead comes from the table's OWN
 * `@@unique([organizationId, payoutEntryId, ownerStatementPeriodId])`
 * constraint: at most one allocation row can ever exist for a given
 * (entry, period) pair. Guard 6 below pre-checks, for every NEW period the
 * request targets, whether that pair already has a row; an EXACT amount
 * match is treated as an idempotent no-op (the retry's natural outcome —
 * nothing is re-written, nothing is double-counted), a DIFFERENT amount is
 * rejected as a genuine conflict (409 PERIOD_ALREADY_ALLOCATED) rather than
 * silently merged/overwritten — this endpoint has no "top up an
 * already-allocated period" operation; the schema's own one-row-per-period
 * constraint makes that a hard boundary, not an oversight (adversarial-audit
 * finding 2: confirmed accepted product limit, not a gap). Because the
 * comparison is by CONTENT (period → amount), not by idempotencyKey value,
 * a retry is safe regardless of what idempotencyKey the client sends —
 * accepted-but-unused is intentional, not a bug.
 */
export async function allocatePreStatementService(
  actor: RemittanceActorCtx,
  entryId: string,
  input: RemittanceAllocateInput,
): Promise<AllocateRemittanceResult> {
  // 0. entryId format guard (pre-tx, pure). entryId is a raw URL path
  // param — unlike every id-shaped field in Task 6's request body, it is
  // NEVER Zod-validated before reaching here (remittanceAllocateSchema
  // covers only {allocations, idempotencyKey}). A malformed UUID handed to
  // a `@db.Uuid` WHERE-equals clause throws a raw Postgres
  // "invalid input syntax for type uuid" error rather than matching zero
  // rows, which would otherwise surface as an uncaught 500 instead of a
  // clean 404. Folded into the SAME code as a genuine not-found: a
  // malformed id can never resolve to a real entry, so the two cases are
  // indistinguishable to the caller, and not distinguishing them avoids
  // confirming/denying id-shape validity as a side channel.
  if (!entryIdSchema.safeParse(entryId).success) {
    return { ok: false, status: 404, error: "REMITTANCE_NOT_FOUND" };
  }

  let txResult: { entryId: string; unallocatedC: number };
  try {
    txResult = await getDb().$transaction(async (tx) => {
      // 1. Load the entry, org-scoped. Not found / foreign org → 404
      // (findFirst never throws on a non-match — a wrong-org id resolves to
      // null here, never a silent cross-org read, matching Task 6's period
      // lookup precedent).
      const entry = await tx.ownerLedgerEntry.findFirst({
        where: { id: entryId, organizationId: actor.orgId },
      });
      if (!entry) {
        throw new AllocateGuardError("REMITTANCE_NOT_FOUND", 404);
      }

      // 2. Only a PRE_STATEMENT_REMITTANCE accepts later allocation — an
      // OWNER_REMITTANCE must be fully allocated at creation (Task 6 guard
      // 7) and an OWNER_RECEIVABLE_OFFSET has its own settlement mechanism
      // (Task 8) entirely.
      if (entry.settlementKind !== "PRE_STATEMENT_REMITTANCE") {
        throw new AllocateGuardError("NOT_PRE_STATEMENT_REMITTANCE", 400);
      }

      // 3a. A reversed remittance can't be allocated — an active reversal
      // (R11: append-only, one-way `reversalOfEntryId` pointer; "is
      // reversed" is DERIVED from the existence of an active reversal row,
      // never a mutable flag on the original) restored the owner's payable
      // already; adding allocations to the reversed entry now would
      // misattribute money that's no longer this entry's to allocate.
      const activeReversal = await tx.ownerLedgerEntry.findFirst({
        where: { organizationId: actor.orgId, reversalOfEntryId: entry.id, status: "active" },
        select: { id: true },
      });
      if (activeReversal) {
        throw new AllocateGuardError("ALREADY_REVERSED", 409);
      }

      // 3b. Independently, the PRE-EXISTING Phase-1 manual-void endpoint can
      // flip `status` directly (no reversal row involved) — a voided entry
      // must be rejected too, same as an actively-reversed one (Task 5's
      // periodRemainingPayableC docstring: these are two INDEPENDENT ways a
      // payout entry leaves the owner's active set).
      if (entry.status !== "active") {
        throw new AllocateGuardError("ENTRY_NOT_ACTIVE", 409);
      }

      // 4. Owner-level advisory lock — the owner comes from the ENTRY (the
      // request carries no ownerPartyId; the URL :id identifies the entry),
      // FIRST, before any read of payable/period state (GC3).
      await lockOwnerPayable(tx, actor.orgId, entry.ownerPartyId);

      // 5. Existing allocations for THIS entry. Every row found here is
      // automatically "active" — guard 3 above already proved the ONE
      // parent (this entry) is itself active and unreversed, so no extra
      // parent-status join is needed here (unlike periodRemainingPayableC,
      // which has to check across MANY parent entries).
      const existingRows = await tx.ownerRemittanceAllocation.findMany({
        where: { organizationId: actor.orgId, payoutEntryId: entry.id },
        select: { ownerStatementPeriodId: true, allocatedAmountC: true },
      });
      const existingByPeriod = new Map(existingRows.map((r) => [r.ownerStatementPeriodId, r.allocatedAmountC]));

      // Aggregate the NEW request's lines by period FIRST (B33 precedent —
      // Task 6 guard 5): two lines targeting the SAME period are summed, not
      // double-counted or double-inserted — required because
      // @@unique([org, payoutEntryId, ownerStatementPeriodId]) forbids two
      // allocation rows for one period from one payout (an un-aggregated
      // pass would raw-P2002-crash on a same-period repeat instead of
      // cleanly summing it).
      const newByPeriod = new Map<string, number>();
      for (const line of input.allocations) {
        const lineC = toCents(line.allocatedAmount, "allocatePreStatementService.allocation");
        newByPeriod.set(line.ownerStatementPeriodId, (newByPeriod.get(line.ownerStatementPeriodId) ?? 0) + lineC);
      }

      // 6. Conflict scan — Pass A over EVERY distinct requested period,
      // BEFORE any Pass-B per-period guard runs on ANY of them, so
      // PERIOD_ALREADY_ALLOCATED is deterministic regardless of whether some
      // OTHER period in the same request would separately fail a Pass-B
      // guard (a single fused pass would make the reported error depend on
      // array order — adversarial-audit finding 3). An EXACT (summed) amount
      // match against an existing row is the idempotent-retry case (GC6 —
      // see this function's docstring): contributes nothing new, already
      // accounted for in existingByPeriod/existingSumC below, never
      // re-inserted. A DIFFERENT amount is a genuine conflict, not a retry —
      // this endpoint has no "top up an already-allocated period" operation
      // (the table's own one-row-per-period unique constraint makes that a
      // hard boundary), so it is rejected outright, whole tx rolled back.
      for (const [periodId, sumC] of newByPeriod) {
        if (!existingByPeriod.has(periodId)) continue;
        if (sumC !== existingByPeriod.get(periodId)) {
          throw new AllocateGuardError("PERIOD_ALREADY_ALLOCATED", 409);
        }
      }

      // 7. Pass B — per distinct period NOT already allocated on this entry:
      // org-consistency/owner/cap.
      const toInsert: { ownerStatementPeriodId: string; allocatedAmountC: number }[] = [];
      for (const [periodId, sumC] of newByPeriod) {
        if (existingByPeriod.has(periodId)) continue; // idempotent match — proven conflict-free by Pass A

        const period = await tx.ownerStatementPeriod.findFirst({
          where: { id: periodId, organizationId: actor.orgId },
          select: { ownerPartyId: true },
        });
        if (!period) {
          throw new AllocateGuardError("OWNER_STATEMENT_PERIOD_NOT_FOUND", 404);
        }
        if (period.ownerPartyId !== entry.ownerPartyId) {
          throw new AllocateGuardError("OWNER_MISMATCH", 422);
        }

        const remainingC = await periodRemainingPayableC(tx, actor.orgId, periodId);
        if (sumC > remainingC) {
          throw new AllocateGuardError("ALLOCATION_EXCEEDS_PERIOD", 409);
        }

        toInsert.push({ ownerStatementPeriodId: periodId, allocatedAmountC: sumC });
      }

      // 8. The entry's total allocations can never exceed its own amount —
      // same ALLOCATION_EXCEEDS_UNALLOCATED code Task 6 uses for the
      // identical Σ ≤ amount invariant at creation time.
      const amountC = toCents(entry.amount.toString(), "allocatePreStatementService");
      const existingSumC = [...existingByPeriod.values()].reduce((sum, c) => sum + c, 0);
      const newSumC = toInsert.reduce((sum, r) => sum + r.allocatedAmountC, 0);
      if (existingSumC + newSumC > amountC) {
        throw new AllocateGuardError("ALLOCATION_EXCEEDS_UNALLOCATED", 409);
      }

      // 9. Write the genuinely-new allocations (a pure idempotent replay —
      // toInsert empty because every requested period already matched an
      // existing row — writes nothing and logs no audit entry, mirroring
      // Task 6's own "no audit on a pure replay" precedent).
      if (toInsert.length > 0) {
        await insertRemittanceAllocations(tx, actor.orgId, entry.id, toInsert, actor.actorUserId);
        await recordAudit(tx, {
          organizationId: actor.orgId,
          actorUserId: actor.actorUserId,
          actorRole: actor.actorRole,
          action: "owner_remittance.allocate",
          entityType: "OwnerLedgerEntry",
          entityId: entry.id,
          diff: { after: { allocations: toInsert } },
          ip: actor.ip,
          userAgent: actor.userAgent,
        });
      }

      // 10. No new cash moves — no notify (Task 6 already notified the
      // owner once, at record time; a top-up allocation of already-recorded
      // money is not a fresh cash event).
      return { entryId: entry.id, unallocatedC: amountC - existingSumC - newSumC };
    });
  } catch (err) {
    if (err instanceof AllocateGuardError) {
      return { ok: false, status: err.httpStatus, error: err.code };
    }
    throw err;
  }

  return { ok: true, status: 200, data: txResult };
}

// ─── Task 8: recordOffsetService ───────────────────────────────────────────

// Decimal(12,2) max value is 9999999999.99 (10 integer digits) — the cap
// OwnerLedgerEntry.amount (and, transitively, this endpoint's derived total)
// can never exceed. In integer cents: 9999999999 * 100 + 99 = 999999999999.
// Mirrors recordRemittanceService's [B25] AMOUNT_TOO_LARGE guard, but checked
// against the SUMMED cents total rather than a single top-level amount
// string's integer-part length — offsetCreateSchema has NO top-level amount
// (the total is derived server-side as Σ(lineAllocations.allocatedAmount),
// see that schema's own docstring), so there is no single pre-conversion
// string to length-check. Summing via toCents first is still precision-safe:
// toCents does integer string-split arithmetic (not parseFloat), and cents
// values up to 999999999999 are far inside Number.MAX_SAFE_INTEGER (2^53-1).
const DECIMAL_12_2_MAX_CENTS = 999_999_999_999;

type OffsetOk = { ok: true; status: 200 | 201; data: { entryId: string } };
type OffsetErr = { ok: false; status: 409 | 422; error: string };
export type RecordOffsetResult = OffsetOk | OffsetErr;

/** Thrown inside recordOffsetService's transaction on any guard breach —
 *  same rollback contract as RemittanceGuardError/AllocateGuardError above
 *  (Prisma re-throws on a callback throw, rolling back the whole tx). Never
 *  escapes recordOffsetService. */
class OffsetGuardError extends Error {
  constructor(
    public code: string,
    public httpStatus: 409 | 422,
  ) {
    super(code);
    this.name = "OffsetGuardError";
  }
}

/**
 * POST /owner-receivable-offsets — non-cash settlement of an owner's own
 * IVOWN (owner-billed, MANAGER_REVENUE) invoice lines by drawing down that
 * SAME owner's payable. Net effect: owner payable ↓ AND the settled IVOWN
 * charges' outstanding ↓, in the SAME transaction — no cash moves, no
 * Payment is ever created. ONE `getDb().$transaction`, guards run in the
 * EXACT numbered order below (0 pre-tx; 1-9 in-tx, under the SAME
 * lockOwnerPayable advisory lock recordRemittanceService uses). Any guard
 * breach throws OffsetGuardError, which rolls back the whole tx (nothing
 * written — no idempotency row, no allocation row, no Charge mutation) and
 * maps to the matching {status, error} pair. Behavior inventory + RED/GREEN
 * evidence for every guard: apps/api/src/modules/owner-remittance/__tests__/
 * offset.integration.test.ts.
 *
 * ⚠️ MONEY-CRITICAL UNIT BOUNDARY: this service computes and guards entirely
 * in integer CENTS (matching every other Phase-2 remittance guard). The
 * actual Charge settlement happens through settleIvownChargeTx
 * (owner-remittance.repository.ts), which converts to RINGGIT DECIMALS at
 * its OWN call to applyAllocationToChargeTx — see that function's docstring
 * for the full contract. This service never calls applyAllocationToChargeTx
 * directly and never passes allocatedAmountC anywhere that expects RM.
 */
export async function recordOffsetService(
  actor: RemittanceActorCtx,
  input: OffsetCreateInput,
): Promise<RecordOffsetResult> {
  // 0. Pre-tx AMOUNT_TOO_LARGE (422) [B25] — Σ lineAllocations in cents,
  // computed ONCE here (pure, no DB read) and reused below both for the
  // OFFSET_EXCEEDS_PAYABLE guard and the payout entry's own amount.
  const amountC = input.lineAllocations.reduce(
    (sum, l) => sum + toCents(l.allocatedAmount, "recordOffsetService.line"),
    0,
  );
  if (amountC > DECIMAL_12_2_MAX_CENTS) {
    return { ok: false, status: 422, error: "AMOUNT_TOO_LARGE" };
  }

  // R25/GC6: sha256 of the canonicalized payload with idempotencyKey stripped.
  // Computed ONCE, pre-tx (pure) — compared against the stored fingerprint on
  // a matching (org, "OWNER_RECEIVABLE_OFFSET", idempotencyKey) triple below.
  const fingerprint = computeRequestFingerprint(input);

  let txResult: { kind: "replay" | "created"; entryId: string; chargeIds: string[] };
  try {
    txResult = await getDb().$transaction(async (tx) => {
      // 1. Owner-level advisory lock — FIRST, before any read of payable (GC3).
      await lockOwnerPayable(tx, actor.orgId, input.ownerPartyId);

      // 2. Idempotency (GC6) — SAME fingerprint mechanism + settlementKind-scoped
      // lookup as Task 6/recordRemittanceService, just under the
      // "OWNER_RECEIVABLE_OFFSET" kind. Status-agnostic (matches a voided prior
      // row too — findEntryByIdempotency's own contract).
      const existing = await findEntryByIdempotency(tx, actor.orgId, "OWNER_RECEIVABLE_OFFSET", input.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          return { kind: "replay" as const, entryId: existing.id, chargeIds: [] as string[] };
        }
        throw new OffsetGuardError("IDEMPOTENCY_KEY_REUSED", 409);
      }

      // 3. Reversal-aware available payable (cents), read inside the SAME
      // locked tx as the guard+write that follows (GC3). OFFSET_EXCEEDS_PAYABLE
      // applies to the WHOLE offset total, before any per-line validation runs.
      const availableC = await computeAvailableOwnerPayableC(tx, actor.orgId, input.ownerPartyId);
      if (amountC > availableC) {
        throw new OffsetGuardError("OFFSET_EXCEEDS_PAYABLE", 409);
      }

      // 4. Resolve + validate EVERY line, aggregating cents by resolved
      // chargeId (B33 — two lines on one charge summed; required because
      // OwnerReceivableOffsetAllocation's own @@unique([organizationId,
      // offsetEntryId, chargeId]) forbids two rows for one (offset, charge)
      // pair — an un-aggregated per-line settle would raw-P2002 on the
      // SECOND line of a same-charge pair). propertyId-derivation ingredients
      // (guard 6, below) are also collected in this SAME pass.
      const aggregated = new Map<string, { allocatedAmountC: number; lineIds: string[] }>();
      let sawNullPropertyDoc = false;
      const distinctPropertyIds = new Set<string>();

      for (const line of input.lineAllocations) {
        const lineC = toCents(line.allocatedAmount, "recordOffsetService.allocation");

        // Org-scoped via the line's PARENT document (BillingDocumentLine
        // itself carries no organizationId column) — a line belonging to a
        // different org, or no line at all, resolves to null here (findFirst
        // never throws), never a silent cross-org read (correction-replace.
        // service.ts:81 precedent for this exact join shape).
        const docLine = await tx.billingDocumentLine.findFirst({
          where: { id: line.billingDocumentLineId, document: { organizationId: actor.orgId } },
          select: {
            chargeId: true,
            document: {
              select: { docType: true, ledgerTreatment: true, partyId: true, seriesId: true, propertyId: true },
            },
          },
        });
        // chargeId is nullable for overpayment-CN lines (R12a, schema.prisma:2245)
        // — an offset settles a CHARGE, so a line with no charge can never be a
        // valid target. Folded into the SAME NOT_IVOWN_RECEIVABLE code as a
        // missing/foreign line and a wrong docType/ledgerTreatment/series below
        // — none of these describe a settleable IVOWN receivable line.
        if (!docLine || docLine.chargeId === null) {
          throw new OffsetGuardError("NOT_IVOWN_RECEIVABLE", 422);
        }
        if (docLine.document.docType !== "invoice" || docLine.document.ledgerTreatment !== "MANAGER_REVENUE") {
          throw new OffsetGuardError("NOT_IVOWN_RECEIVABLE", 422);
        }
        // Series is resolved CONFIGURATION (DEFAULT_SERIES_FOR_CLASSIFICATION's
        // own docstring), not a hard-coded literal — BillingDocument.seriesId is
        // a plain column (no Prisma relation) pointing at DocumentSeries.code.
        const series = await tx.documentSeries.findFirst({
          where: { id: docLine.document.seriesId, organizationId: actor.orgId },
          select: { code: true },
        });
        if (series?.code !== "IVOWN") {
          throw new OffsetGuardError("NOT_IVOWN_RECEIVABLE", 422);
        }
        // Only NOW (a confirmed IVOWN owner-receivable line) does a party
        // mismatch mean OWNER_MISMATCH rather than "not an IVOWN line at all".
        if (docLine.document.partyId !== input.ownerPartyId) {
          throw new OffsetGuardError("OWNER_MISMATCH", 422);
        }

        if (docLine.document.propertyId == null) sawNullPropertyDoc = true;
        else distinctPropertyIds.add(docLine.document.propertyId);

        const chargeId = docLine.chargeId;
        const agg = aggregated.get(chargeId);
        if (agg) {
          agg.allocatedAmountC += lineC;
          agg.lineIds.push(line.billingDocumentLineId);
        } else {
          aggregated.set(chargeId, { allocatedAmountC: lineC, lineIds: [line.billingDocumentLineId] });
        }
      }

      // 5. CURRENCY_MISMATCH (422) [GC10] — loaded fresh inside the tx, same
      // findFirstOrThrow "should never happen" convention as
      // recordRemittanceService guard 6 (see that function's comment for the
      // full rationale — a missing org row throws uncaught, never a silent
      // skip of a money guard).
      const org = await tx.organization.findFirstOrThrow({
        where: { id: actor.orgId },
        select: { defaultCurrency: true },
      });
      if (input.currency !== org.defaultCurrency) {
        throw new OffsetGuardError("CURRENCY_MISMATCH", 422);
      }

      // 6. propertyId derivation (Task 6a decision, mirrored from
      // recordRemittanceService guard 8) — never a sentinel; null unless
      // EVERY line resolves to exactly the SAME single property (no
      // null-propertyId document in the mix).
      const propertyId: string | null =
        !sawNullPropertyDoc && distinctPropertyIds.size === 1 ? [...distinctPropertyIds][0]! : null;

      // 7. Write the payout entry — ONE OWNER_RECEIVABLE_OFFSET row, reduces
      // payable ONCE. NO paymentMethod/bankReference/proofKey/proofStatus
      // (all omitted -> insertPayoutEntry's own `?? null` defaults) — offsets
      // aren't cash (schema.prisma:2616's own comment). includeInPayout:false
      // and every other fixed column are hard-coded inside insertPayoutEntry
      // itself, not re-decided here.
      const created = await insertPayoutEntry(tx, {
        orgId: actor.orgId,
        ownerPartyId: input.ownerPartyId,
        propertyId,
        settlementKind: "OWNER_RECEIVABLE_OFFSET",
        amount: centsToString(amountC),
        effectiveDate: new Date(input.effectiveDate),
        memo: input.memo ?? null,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdById: actor.actorUserId,
        updatedById: actor.actorUserId,
      });

      // 8. Per charge, settle + write the OwnerReceivableOffsetAllocation row.
      // settleIvownChargeTx owns the cents->RM conversion into
      // applyAllocationToChargeTx (see its own docstring for the unit
      // boundary) — this loop only ever deals in cents.
      const chargeIds: string[] = [];
      for (const [chargeId, agg] of aggregated) {
        const result = await settleIvownChargeTx(tx, {
          orgId: actor.orgId,
          ownerPartyId: input.ownerPartyId,
          offsetEntryId: created.id,
          chargeId,
          allocatedAmountC: agg.allocatedAmountC,
          billingDocumentLineId: agg.lineIds.length === 1 ? agg.lineIds[0]! : null,
          createdById: actor.actorUserId,
        });
        if (result.exceeded) {
          throw new OffsetGuardError("OFFSET_EXCEEDS_LINE_OUTSTANDING", 409);
        }
        chargeIds.push(chargeId);
      }

      // 9. Audit — same tx, rolls back with everything else on any later
      // failure (there is none past this point today).
      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_remittance.offset",
        entityType: "OwnerLedgerEntry",
        entityId: created.id,
        diff: {
          after: {
            id: created.id,
            ownerPartyId: input.ownerPartyId,
            propertyId,
            amountC,
            chargeIds,
          },
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      // 10. No Payment, no receipt, no bank movement — commit (implicit on
      // return from the $transaction callback).
      return { kind: "created" as const, entryId: created.id, chargeIds };
    });
  } catch (err) {
    if (err instanceof OffsetGuardError) {
      return { ok: false, status: err.httpStatus, error: err.code };
    }
    // settleIvownChargeTx (above) shares the SAME guarded charge-mutation rail
    // every payment-allocation path uses (applyAllocationToChargeTx,
    // payments.repository.ts) — a StaleError (optimistic updatedAt-in-WHERE
    // miss, or a voided charge) can escape it uncaught. Genuinely reachable in
    // prod: the lockOwnerPayable advisory lock this tx takes does NOT
    // serialize against the payments module (allocatePaymentTx et al never
    // take it), so a cash Payment allocated to the SAME IVOWN charge
    // concurrently with this offset can race it — the loser gets StaleError.
    // Mapped here (rather than left to escape to app.onError's uncaught->500
    // default) so a money endpoint returns a clean, retryable conflict.
    if (err instanceof StaleError) {
      return { ok: false, status: 409, error: "OFFSET_CONFLICT" };
    }
    // PartyMismatchError: the CHARGE row's own partyId (re-read fresh inside
    // settleIvownChargeTx) doesn't match the expected owner — a defense-in-
    // depth check distinct from guard 4 above (which compares the
    // DOCUMENT's partyId). 422, not the 400 payments.service.ts maps this
    // error to elsewhere — deliberately consistent with THIS function's own
    // convention instead (every other party/ownership guard here —
    // OWNER_MISMATCH, NOT_IVOWN_RECEIVABLE, CURRENCY_MISMATCH — is 422).
    if (err instanceof PartyMismatchError) {
      return { ok: false, status: 422, error: "OFFSET_CHARGE_PARTY_MISMATCH" };
    }
    throw err;
  }

  // Post-commit, best-effort, flag-gated (ENABLE_PHASE2_BILLING_DOCS), never-
  // throws — re-derives the settled charges' documents' settlement status
  // (payments.service.ts precedent: EVERY OTHER charge-outstanding-mutating
  // flow — allocate/post/void/reverse — calls this the SAME way after its own
  // commit). Skipped on a pure replay (nothing new settled). Deliberately NO
  // syncOwnerLedgerForCharges call: that hook derives owner INCOME/EXPENSE
  // lines from a charge's unit/carpark owner (tenant-side rent/utility
  // charges) — an IVOWN receivable charge is the OWNER's own liability, not
  // income to sync, and the ONE payout entry above already moved this
  // owner's payable exactly once; calling it here would risk a second,
  // unrelated ledger write for the same charges. Deliberately NO notify —
  // no cash was disbursed, so there is nothing for the owner to be told.
  if (txResult.kind === "created" && txResult.chargeIds.length > 0) {
    await refreshDocumentStatusForCharges(txResult.chargeIds);
  }

  return {
    ok: true,
    status: txResult.kind === "replay" ? 200 : 201,
    data: { entryId: txResult.entryId },
  };
}

// ─── Task 9: reverseRemittanceService / reverseOffsetService ──────────────
//
// Append-only, net-zero, restore-EXACTLY-once reversal (R11; GC5). A
// reversal is a SECOND `direction:"payout"` OwnerLedgerEntry with
// `reversalOfEntryId = <original id>`, the SAME settlementKind and amount as
// the original — the ORIGINAL row is NEVER mutated (stays status:"active",
// carries no back-pointer; "is reversed" is DERIVED from the existence of an
// active reversal, never a mutable flag). Task 3 made the owner running
// balance reversal-aware: a payout line WITH reversalOfEntryId ADDS +amount
// (restores payable) instead of subtracting, so original(−amount) +
// reversal(+amount) nets to exactly zero automatically — this module never
// posts a separate negating write (that would double-restore).
//
// Both functions share ONE locked tx, in this exact order:
//   1. Minimal existence lookup (id, org) → 404 if missing. Only reads
//      ownerPartyId — NOT the canonical read for any guard below (see 3).
//   2. lockOwnerPayable — FIRST, before any lifecycle re-check (GC3).
//   3. RE-READ the full entry UNDER the lock and run every lifecycle guard
//      (kind, active, not-itself-a-reversal) against THIS read, never the
//      step-1 snapshot — closes the Task-7 pre-lock TOCTOU (WATCH-T9): a
//      concurrent Phase-1 manual-void does not take this advisory lock, so
//      a pre-lock snapshot could be stale by the time the lock is held.
//      CANNOT_REVERSE_A_REVERSAL (409) rejects a target that is ITSELF a
//      reversal (reversalOfEntryId already set) — un-reversal is not a
//      supported operation. Without it, computeOwnerRunningBalance's
//      unconditional +amount-for-any-reversal-row math (owner-net-payout.ts)
//      lets a reverse-of-a-reversal chain (R1→R2→R3→…) over-restore payable
//      without bound, since ALREADY_REVERSED (step 5) only guards a SECOND
//      reversal of the SAME original, not a reversal targeting a reversal.
//   4. Idempotency (GC6) on the REVERSAL's own (org, settlementKind,
//      idempotencyKey) — same fingerprint ⇒ replay (return the existing
//      reversal, write nothing); different ⇒ 409 IDEMPOTENCY_KEY_REUSED.
//   5. ALREADY_REVERSED (409) — reject if an active reversal already exists
//      (an OwnerLedgerEntry with reversalOfEntryId = entryId AND
//      status:"active"). MANDATORY: without this, a second reversal would
//      add +amount AGAIN, over-restoring payable (Task-5 review Finding 2).
//      Together with step 4's idempotent replay, this guarantees the
//      offset's charge-restore loop (reverseOffsetService step 7 below)
//      runs AT MOST ONCE per original entry — restore-exactly-once.
//   6. Append the reversal entry via insertPayoutEntry. effectiveDate is
//      `new Date()` — the MOMENT of reversal, never the original's date
//      (reverseSchema carries no date field) — so the reversal's OWN
//      statementMonth recognises the +payout in ITS OWN period, never
//      retroactively touching the original's period or any frozen
//      OwnerStatementPeriod snapshot (Task-3 user decision / WATCH-T9).
//   7. (offset only) Restore every settled charge via the SAME guarded
//      restoreChargeTx rail void/reverse already use.
//   8. recordAudit. Commit (implicit on return). Notify post-commit,
//      best-effort, never for a replay.

type ReverseOk = { ok: true; status: 200 | 201; data: { entryId: string } };
type ReverseErr = { ok: false; status: 400 | 404 | 409; error: string };
export type ReverseResult = ReverseOk | ReverseErr;

/** Thrown inside either reverse function's transaction on any guard breach —
 *  same rollback contract as the sibling *GuardError classes above (Prisma
 *  re-throws on a callback throw, rolling back the whole tx). Shared by BOTH
 *  reverseRemittanceService and reverseOffsetService (unlike
 *  RemittanceGuardError/AllocateGuardError's split across Task 6/7 — those
 *  were separated because Task 7 shipped AFTER Task 6 and widening the
 *  already-shipped RemittanceGuardError's status union risked that
 *  function's own return type; reverseRemittanceService and
 *  reverseOffsetService are introduced together here with an IDENTICAL
 *  400|404|409 status union, so one shared class is the simpler, equally
 *  safe choice). Never escapes either reverse function. */
class ReverseGuardError extends Error {
  constructor(
    public code: string,
    public httpStatus: 400 | 404 | 409,
  ) {
    super(code);
    this.name = "ReverseGuardError";
  }
}

const REMITTANCE_REVERSIBLE_KINDS = new Set(["OWNER_REMITTANCE", "PRE_STATEMENT_REMITTANCE"]);

/**
 * POST /owner-remittances/:id/reverse — reverses an OWNER_REMITTANCE or
 * PRE_STATEMENT_REMITTANCE entry. See the module-level docstring above for
 * the full step order shared with reverseOffsetService. The remittance's
 * OwnerRemittanceAllocation rows are NOT mutated or deleted here — they
 * become inactive automatically the moment this reversal is active
 * (periodRemainingPayableC derives allocation activity from the parent's
 * active reversal, Task 5).
 */
export async function reverseRemittanceService(
  actor: RemittanceActorCtx,
  entryId: string,
  input: ReverseInput,
): Promise<ReverseResult> {
  // 0. entryId format guard (pre-tx, pure) — SAME rationale as
  // allocatePreStatementService's guard 0 above: entryId is a raw URL path
  // param, never Zod-validated (reverseSchema covers only
  // {reason, idempotencyKey}). A malformed UUID handed to a `@db.Uuid`
  // WHERE-equals clause throws a raw Postgres error rather than matching
  // zero rows; folded into the same 404 as a genuine not-found (the two are
  // indistinguishable to the caller either way).
  if (!entryIdSchema.safeParse(entryId).success) {
    return { ok: false, status: 404, error: "REMITTANCE_NOT_FOUND" };
  }

  // R25/GC6: computed ONCE, pre-tx (pure) — over {entryId, reason} (the
  // reversal has no request body "amount"/"settlementKind" of its own to
  // fingerprint; entryId is a path param, not part of `input`, so it must be
  // folded in explicitly here rather than relying on computeRequestFingerprint(input)
  // the way Task 6/8's create flows do).
  const fingerprint = computeRequestFingerprint({ entryId, reason: input.reason });

  let txResult:
    | { kind: "replay"; entryId: string }
    | { kind: "created"; entryId: string; ownerPartyId: string; amount: string; settlementKind: string };
  try {
    txResult = await getDb().$transaction(async (tx) => {
      // 1. Minimal existence lookup — only what's needed to acquire the
      // lock (ownerPartyId). NOT the canonical read for any guard below.
      const pre = await tx.ownerLedgerEntry.findFirst({
        where: { id: entryId, organizationId: actor.orgId },
        select: { ownerPartyId: true },
      });
      if (!pre) {
        throw new ReverseGuardError("REMITTANCE_NOT_FOUND", 404);
      }

      // 2. Owner-level advisory lock — FIRST, before any lifecycle re-check (GC3).
      await lockOwnerPayable(tx, actor.orgId, pre.ownerPartyId);

      // 3. RE-READ the full entry UNDER the lock (WATCH-T9 TOCTOU close —
      // see module docstring) — every guard AND every field the writer
      // below uses (amount, propertyId, settlementKind) comes from THIS
      // read, never the step-1 snapshot.
      const entry = await tx.ownerLedgerEntry.findFirst({
        where: { id: entryId, organizationId: actor.orgId },
      });
      if (!entry) {
        throw new ReverseGuardError("REMITTANCE_NOT_FOUND", 404);
      }
      if (!entry.settlementKind || !REMITTANCE_REVERSIBLE_KINDS.has(entry.settlementKind)) {
        throw new ReverseGuardError("NOT_A_REMITTANCE", 400);
      }
      if (entry.status !== "active") {
        throw new ReverseGuardError("ENTRY_NOT_ACTIVE", 409);
      }
      // CANNOT_REVERSE_A_REVERSAL (409) — a reversal entry (reversalOfEntryId
      // already set) is not itself independently reversible; un-reversal is
      // not a supported operation here. Grouped with this step's other
      // lifecycle guards (kind, active) — same re-read, same precedence
      // ahead of idempotency/ALREADY_REVERSED below. Without this, a
      // reverse-of-a-reversal would append a SECOND active row carrying
      // reversalOfEntryId; computeOwnerRunningBalance (owner-net-payout.ts)
      // adds +amount for ANY active row with reversalOfEntryId set,
      // unconditionally — over-restoring payable by one full amount, and the
      // chain (reverse R2 → R3 → …) inflates it without bound. ALREADY_
      // REVERSED (step 5 below) does NOT catch this: it only looks for an
      // active reversal OF entry.id, and a freshly-targeted reversal row has
      // none yet. A normal first-level reverse targets the ORIGINAL
      // (reversalOfEntryId === null) and is completely unaffected.
      if (entry.reversalOfEntryId) {
        throw new ReverseGuardError("CANNOT_REVERSE_A_REVERSAL", 409);
      }

      // 4. Idempotency (GC6) — the REVERSAL's OWN idempotencyKey, scoped by
      // the entry's settlementKind (the reversal carries the identical
      // kind — findEntryByIdempotency's unique triple is
      // (org, settlementKind, idempotencyKey), so this matches only other
      // reversal attempts of this SAME kind family, never a create-time key
      // by coincidence — collision is a 128-bit-random-UUID-reuse event,
      // the same accepted risk Task 6/8's own idempotency keys carry).
      const existing = await findEntryByIdempotency(tx, actor.orgId, entry.settlementKind, input.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          return { kind: "replay" as const, entryId: existing.id };
        }
        throw new ReverseGuardError("IDEMPOTENCY_KEY_REUSED", 409);
      }

      // 5. ALREADY_REVERSED (409) — MANDATORY single-active-reversal guard
      // (see module docstring). Without this, a second reversal would add
      // +amount AGAIN, over-restoring payable.
      const activeReversal = await tx.ownerLedgerEntry.findFirst({
        where: { organizationId: actor.orgId, reversalOfEntryId: entry.id, status: "active" },
        select: { id: true },
      });
      if (activeReversal) {
        throw new ReverseGuardError("ALREADY_REVERSED", 409);
      }

      // 6. Append the reversal entry. NO cash fields (paymentMethod/
      // bankReference/proofKey/proofStatus all omitted -> insertPayoutEntry's
      // own `?? null` defaults) — a reversal is a ledger correction, never a
      // fresh cash event, mirroring the offset entry's own no-cash-fields
      // convention. propertyId is the ORIGINAL's propertyId verbatim
      // (including null — preserves owner-level scope for a cross-property/
      // combined-scope original). effectiveDate = now (module docstring
      // step 6) drives both transactionDate and statementMonth via
      // insertPayoutEntry's own derivation.
      const amountC = toCents(entry.amount.toString(), "reverseRemittanceService");
      const created = await insertPayoutEntry(tx, {
        orgId: actor.orgId,
        ownerPartyId: entry.ownerPartyId,
        propertyId: entry.propertyId,
        settlementKind: entry.settlementKind,
        amount: centsToString(amountC),
        effectiveDate: new Date(),
        memo: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        reversalOfEntryId: entry.id,
        createdById: actor.actorUserId,
        updatedById: actor.actorUserId,
      });

      // 7. Audit — same tx, rolls back with everything else on any later failure.
      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_remittance.reverse",
        entityType: "OwnerLedgerEntry",
        entityId: created.id,
        diff: {
          after: {
            id: created.id,
            reversalOfEntryId: entry.id,
            settlementKind: entry.settlementKind,
            amountC,
            reason: input.reason,
          },
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      // 8. Commit (implicit on return).
      return {
        kind: "created" as const,
        entryId: created.id,
        ownerPartyId: entry.ownerPartyId,
        amount: centsToString(amountC),
        settlementKind: entry.settlementKind,
      };
    });
  } catch (err) {
    if (err instanceof ReverseGuardError) {
      return { ok: false, status: err.httpStatus, error: err.code };
    }
    throw err;
  }

  // Notify AFTER commit, best-effort — never on replay (a replay is not a
  // new event). notifyOwnerOfReversal never throws (own try/catch, mirrors
  // notifyOwnerOfRemittance's precedent) — no wrapping try/catch needed here.
  if (txResult.kind === "created") {
    await notifyOwnerOfReversal(actor.orgId, txResult.ownerPartyId, txResult.amount, txResult.settlementKind);
  }

  return {
    ok: true,
    status: txResult.kind === "replay" ? 200 : 201,
    data: { entryId: txResult.entryId },
  };
}

/**
 * POST /owner-receivable-offsets/:id/reverse — reverses an
 * OWNER_RECEIVABLE_OFFSET entry. Same steps 1-5 as reverseRemittanceService
 * above (module-level docstring), scoped to the OWNER_RECEIVABLE_OFFSET kind
 * only, THEN additionally restores every settled charge — the receivable
 * side of the offset — via the SAME guarded restoreChargeTx rail
 * void/reverse already use. NO cash refund, NO Payment/Refund row is ever
 * created (an offset was never cash to begin with).
 */
export async function reverseOffsetService(
  actor: RemittanceActorCtx,
  entryId: string,
  input: ReverseInput,
): Promise<ReverseResult> {
  // 0. entryId format guard (pre-tx, pure) — same rationale as
  // reverseRemittanceService's guard 0 above.
  if (!entryIdSchema.safeParse(entryId).success) {
    return { ok: false, status: 404, error: "OFFSET_NOT_FOUND" };
  }

  const fingerprint = computeRequestFingerprint({ entryId, reason: input.reason });

  let txResult:
    | { kind: "replay"; entryId: string }
    | { kind: "created"; entryId: string; ownerPartyId: string; amount: string; chargeIds: string[] };
  try {
    txResult = await getDb().$transaction(async (tx) => {
      // 1. Minimal existence lookup (see reverseRemittanceService step 1).
      const pre = await tx.ownerLedgerEntry.findFirst({
        where: { id: entryId, organizationId: actor.orgId },
        select: { ownerPartyId: true },
      });
      if (!pre) {
        throw new ReverseGuardError("OFFSET_NOT_FOUND", 404);
      }

      // 2. Owner-level advisory lock — FIRST (GC3).
      await lockOwnerPayable(tx, actor.orgId, pre.ownerPartyId);

      // 3. RE-READ the full entry UNDER the lock (WATCH-T9 TOCTOU close).
      const entry = await tx.ownerLedgerEntry.findFirst({
        where: { id: entryId, organizationId: actor.orgId },
      });
      if (!entry) {
        throw new ReverseGuardError("OFFSET_NOT_FOUND", 404);
      }
      if (entry.settlementKind !== "OWNER_RECEIVABLE_OFFSET") {
        throw new ReverseGuardError("NOT_AN_OFFSET", 400);
      }
      if (entry.status !== "active") {
        throw new ReverseGuardError("ENTRY_NOT_ACTIVE", 409);
      }
      // CANNOT_REVERSE_A_REVERSAL (409) — SAME guard as
      // reverseRemittanceService above (see that function's comment for the
      // full rationale): a reversal entry (reversalOfEntryId already set) is
      // not itself independently reversible. Without this, reversing R1
      // would append a SECOND active row with reversalOfEntryId set, and
      // computeOwnerRunningBalance's unconditional +amount-for-any-reversal
      // math would over-restore payable — unboundedly if chained
      // (R2 → R3 → …). ALREADY_REVERSED (step 5 below) does not catch this
      // case (it only looks for an active reversal OF entry.id).
      if (entry.reversalOfEntryId) {
        throw new ReverseGuardError("CANNOT_REVERSE_A_REVERSAL", 409);
      }

      // 4. Idempotency (GC6) — SAME mechanism as reverseRemittanceService,
      // kind-scoped to "OWNER_RECEIVABLE_OFFSET" (a hard-coded literal here,
      // not entry.settlementKind — guard 3 above already proved they're
      // identical, and the literal avoids a nullable-field non-null
      // assertion for no behavior difference).
      const existing = await findEntryByIdempotency(tx, actor.orgId, "OWNER_RECEIVABLE_OFFSET", input.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint === fingerprint) {
          return { kind: "replay" as const, entryId: existing.id };
        }
        throw new ReverseGuardError("IDEMPOTENCY_KEY_REUSED", 409);
      }

      // 5. ALREADY_REVERSED (409) — MANDATORY (module docstring). This,
      // together with guard 4's idempotent replay, guarantees the
      // charge-restore loop below (step 7) runs AT MOST ONCE per original
      // offset entry — restore-exactly-once.
      const activeReversal = await tx.ownerLedgerEntry.findFirst({
        where: { organizationId: actor.orgId, reversalOfEntryId: entry.id, status: "active" },
        select: { id: true },
      });
      if (activeReversal) {
        throw new ReverseGuardError("ALREADY_REVERSED", 409);
      }

      // 6. Append the reversal entry — restores payable via Task 3's +amount
      // balance math (module docstring). NO cash fields.
      const amountC = toCents(entry.amount.toString(), "reverseOffsetService");
      const created = await insertPayoutEntry(tx, {
        orgId: actor.orgId,
        ownerPartyId: entry.ownerPartyId,
        propertyId: entry.propertyId,
        settlementKind: "OWNER_RECEIVABLE_OFFSET",
        amount: centsToString(amountC),
        effectiveDate: new Date(),
        memo: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        reversalOfEntryId: entry.id,
        createdById: actor.actorUserId,
        updatedById: actor.actorUserId,
      });

      // 7. Restore the receivable EXACTLY ONCE — every
      // OwnerReceivableOffsetAllocation row of the ORIGINAL offset entry (at
      // most ONE row per chargeId — the table's own
      // @@unique([organizationId, offsetEntryId, chargeId])). Guard 5 above
      // guarantees this loop itself runs at most once per original entry.
      const allocations = await tx.ownerReceivableOffsetAllocation.findMany({
        where: { organizationId: actor.orgId, offsetEntryId: entry.id },
        select: { chargeId: true, allocatedAmountC: true },
      });
      for (const alloc of allocations) {
        // ⚠️ UNIT BOUNDARY: restoreChargeTx (payments.repository.ts) takes
        // RINGGIT — it adds `amount` DIRECTLY to Charge.outstandingAmount,
        // capped at the charge's own amount. allocatedAmountC is CENTS
        // (same convention as every other quantity in this module). The
        // `/ 100` below is the ONE line that prevents a 100x over-restore —
        // mirrors settleIvownChargeTx's OWN docstring
        // (owner-remittance.repository.ts) for the identical unit boundary
        // in the FORWARD direction. NEVER remove this without also updating
        // every caller's units.
        await restoreChargeTx(tx, actor.orgId, alloc.chargeId, alloc.allocatedAmountC / 100);
      }

      // 8. Audit.
      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_remittance.reverse_offset",
        entityType: "OwnerLedgerEntry",
        entityId: created.id,
        diff: {
          after: {
            id: created.id,
            reversalOfEntryId: entry.id,
            amountC,
            reason: input.reason,
            chargeIds: allocations.map((a) => a.chargeId),
          },
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      // 9. Commit (implicit on return).
      return {
        kind: "created" as const,
        entryId: created.id,
        ownerPartyId: entry.ownerPartyId,
        amount: centsToString(amountC),
        chargeIds: allocations.map((a) => a.chargeId),
      };
    });
  } catch (err) {
    if (err instanceof ReverseGuardError) {
      return { ok: false, status: err.httpStatus, error: err.code };
    }
    // restoreChargeTx shares the SAME updatedAt-in-WHERE optimistic-
    // concurrency rail every charge mutation in this module uses — a
    // StaleError (missing charge / concurrent modification) can escape it
    // uncaught. Mapped here (rather than left to app.onError's
    // uncaught->500 default) so a money endpoint returns a clean, retryable
    // conflict — mirrors Task 8's OWN StaleError->409 fix for the FORWARD
    // settlement rail (settleIvownChargeTx).
    if (err instanceof StaleError) {
      return { ok: false, status: 409, error: "REVERSE_CONFLICT" };
    }
    throw err;
  }

  // Post-commit, best-effort, flag-gated INSIDE refreshDocumentStatusForCharges
  // itself (ENABLE_PHASE2_BILLING_DOCS) — re-derives the restored charges'
  // documents' settlementStatus (payments.service.ts precedent: EVERY OTHER
  // charge-outstanding-mutating flow, INCLUDING reverse, calls this the SAME
  // way after its own commit — recordOffsetService's own comment names
  // "reverse" explicitly). Skipped on a pure replay (nothing new restored).
  if (txResult.kind === "created" && txResult.chargeIds.length > 0) {
    await refreshDocumentStatusForCharges(txResult.chargeIds);
  }

  // Notify AFTER commit, best-effort — never on replay.
  if (txResult.kind === "created") {
    await notifyOwnerOfReversal(actor.orgId, txResult.ownerPartyId, txResult.amount, "OWNER_RECEIVABLE_OFFSET");
  }

  return {
    ok: true,
    status: txResult.kind === "replay" ? 200 : 201,
    data: { entryId: txResult.entryId },
  };
}

// ─── Task 10: getOwnerAccountService (read-only, R14) ──────────────────────
//
// GET /owner-remittances/owner/:ownerPartyId. Org+owner scoped, read-only —
// no lock (nothing is mutated), no single wrapping transaction (brief: "A
// read can run outside a tx — no lock needed"). Returns (a) every Phase-2
// settlement/reversal OwnerLedgerEntry for the owner and (b) every
// OwnerStatementPeriod's derived remittance status.
//
// TWO AXES, NEVER MERGED: an invoice's PAYMENT status is
// BillingDocument.settlementStatus — a completely different table, never
// read or referenced anywhere below. A period's REMITTANCE status (whether
// KAEN has paid the OWNER out) is the NEW derived axis this function
// computes. A tenant can have paid an invoice in full while the owner's
// period for that same month is still AWAITING_REMITTANCE — both true at
// once; this function only ever computes the second one.

export interface OwnerAccountEntryDto {
  id: string;
  ownerPartyId: string;
  propertyId: string | null;
  apartmentId: string | null;
  settlementKind: string;
  amount: string;
  status: string;
  paymentMethod: string | null;
  bankReference: string | null;
  proofKey: string | null;
  proofStatus: string | null;
  memo: string | null;
  reversalOfEntryId: string | null;
  transactionDate: string;
  statementMonth: string;
  createdAt: string;
}

export interface OwnerAccountPeriodDto {
  id: string;
  apartmentId: string | null;
  periodMonth: string;
  /** OwnerStatementPeriod.status ("open"|"frozen") — the PRE-EXISTING freeze/
   *  snapshot lifecycle flag, passed through verbatim. Deliberately named
   *  differently from `remittanceStatus` below: this is a THIRD, unrelated
   *  status axis (is the period's snapshot frozen yet?), never to be
   *  confused with either BillingDocument.settlementStatus (invoice payment)
   *  or remittanceStatus (owner payout) — three independent concepts. */
  periodStatus: string;
  netPayoutC: number;
  allocatedActiveC: number;
  remittanceStatus: PeriodRemittanceStatus;
}

export interface OwnerAccountResult {
  entries: OwnerAccountEntryDto[];
  periods: OwnerAccountPeriodDto[];
}

type OwnerAccountOk = { ok: true; status: 200; data: OwnerAccountResult };
type OwnerAccountErr = { ok: false; status: 400; error: string };
export type OwnerAccountServiceResult = OwnerAccountOk | OwnerAccountErr;

const ownerPartyIdSchema = z.string().uuid();

/**
 * ownerPartyId is a raw URL path param, never Zod-validated by Hono itself,
 * and used directly in Prisma WHERE clauses against `@db.Uuid` columns
 * (OwnerLedgerEntry.ownerPartyId, OwnerStatementPeriod.ownerPartyId) — a
 * non-UUID-shaped value would throw a raw Postgres "invalid input syntax for
 * type uuid" error (the exact bug class Task 7 found/fixed for its own `:id`
 * path param). 400, not folded into a 404: unlike a single-resource detail
 * fetch, this is a list/collection read with no per-resource not-found
 * concept — a malformed filter is a bad request, not "nothing found" (which
 * would risk silently masking a client bug behind an innocuous empty 200).
 *
 * No Party-existence check: ownerPartyId carries no FK anywhere in this
 * module (every write already accepts it as an opaque "plain column" — see
 * owner-remittance.repository.ts's own docstrings), and the closest sibling
 * read (owner-ledger.routes.ts's GET /owners/:ownerPartyId/months) matches
 * this same "no existence check, empty result for an unknown owner"
 * convention (getOwnerMonthsService) — an unknown/foreign ownerPartyId
 * legitimately resolves to `{entries:[], periods:[]}`, not 404.
 */
export async function getOwnerAccountService(
  actor: RemittanceActorCtx,
  ownerPartyId: string,
): Promise<OwnerAccountServiceResult> {
  if (!ownerPartyIdSchema.safeParse(ownerPartyId).success) {
    return { ok: false, status: 400, error: "INVALID_OWNER_PARTY_ID" };
  }

  const db = getDb();

  // (a) Every Phase-2 settlement/reversal row for this owner — settlementKind
  // set excludes legacy/sync payout rows (settlementKind:null); NOT filtered
  // by `status`, so voided entries and reversal entries (reversalOfEntryId
  // set) both still appear — this is a historical ledger view, not an
  // active-only balance read. Explicit `select` (not a bare findMany): never
  // ships idempotencyKey/requestFingerprint (payload-hash secrets) or
  // createdById/updatedById/sourceType/sourceChargeId (internal plumbing) —
  // only the allowlisted DTO fields below are ever fetched, let alone
  // returned. Ordered newest-first for a stable, predictable response.
  const entryRows = await db.ownerLedgerEntry.findMany({
    where: { organizationId: actor.orgId, ownerPartyId, settlementKind: { not: null } },
    select: {
      id: true,
      ownerPartyId: true,
      propertyId: true,
      apartmentId: true,
      settlementKind: true,
      amount: true,
      status: true,
      paymentMethod: true,
      bankReference: true,
      proofKey: true,
      proofStatus: true,
      memo: true,
      reversalOfEntryId: true,
      transactionDate: true,
      statementMonth: true,
      createdAt: true,
    },
    orderBy: { transactionDate: "desc" },
  });

  // (b) Every OwnerStatementPeriod for this owner (ALL of them, not just
  // open/frozen-filtered — the derived status is meaningful for either
  // lifecycle state). Explicit `select` — never ships `snapshotJson` (the
  // full frozen-statement blob) over the wire on every list call.
  const periodRows = await db.ownerStatementPeriod.findMany({
    where: { organizationId: actor.orgId, ownerPartyId },
    select: { id: true, apartmentId: true, periodMonth: true, status: true, netPayoutC: true },
    orderBy: { periodMonth: "desc" },
  });

  const periods: OwnerAccountPeriodDto[] = [];
  for (const period of periodRows) {
    // CONCURRENCY: netPayoutC is NOT immutable on an open (non-frozen)
    // period — a live recompute can rewrite it between two separately-timed
    // reads (OwnerStatementPeriod's own sourceMaxUpdatedAt monotonic-write
    // guard exists precisely because this happens). periodRemainingPayableC
    // internally re-reads netPayoutC itself and returns
    // `netPayoutC − activeSumC`; naively subtracting THAT from a netPayoutC
    // this loop read separately/earlier only equals `activeSumC` (the
    // intended allocatedActiveC) when BOTH reads see the SAME netPayoutC.
    // A short RepeatableRead transaction gives both reads one consistent
    // snapshot, closing that window — periodRemainingPayableC itself is
    // still called completely unmodified (Task-5 rail, reused verbatim, its
    // own allocation-activity logic never re-derived here).
    const { netPayoutC, remainingC } = await db.$transaction(
      async (tx) => {
        const remainingC = await periodRemainingPayableC(tx, actor.orgId, period.id);
        const fresh = await tx.ownerStatementPeriod.findFirst({
          where: { id: period.id, organizationId: actor.orgId },
          select: { netPayoutC: true },
        });
        // Can't have vanished: this loop already found the row an instant
        // ago inside the SAME serializable read history a RepeatableRead
        // snapshot observes; periodRemainingPayableC itself would already
        // have thrown "OwnerStatementPeriod not found" first if it had.
        return { netPayoutC: fresh!.netPayoutC, remainingC };
      },
      { isolationLevel: "RepeatableRead" },
    );
    const allocatedActiveC = netPayoutC - remainingC;

    periods.push({
      id: period.id,
      apartmentId: period.apartmentId,
      periodMonth: period.periodMonth.toISOString(),
      periodStatus: period.status,
      netPayoutC,
      allocatedActiveC,
      remittanceStatus: derivePeriodRemittanceStatus({ netPayoutC, allocatedActiveC }),
    });
  }

  return {
    ok: true,
    status: 200,
    data: {
      entries: entryRows.map((row) => ({
        id: row.id,
        ownerPartyId: row.ownerPartyId,
        propertyId: row.propertyId,
        apartmentId: row.apartmentId,
        // WHERE settlementKind:{not:null} guarantees non-null here.
        settlementKind: row.settlementKind as string,
        amount: row.amount.toString(),
        status: row.status,
        paymentMethod: row.paymentMethod,
        bankReference: row.bankReference,
        proofKey: row.proofKey,
        proofStatus: row.proofStatus,
        memo: row.memo,
        reversalOfEntryId: row.reversalOfEntryId,
        transactionDate: row.transactionDate.toISOString(),
        statementMonth: row.statementMonth.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
      periods,
    },
  };
}
