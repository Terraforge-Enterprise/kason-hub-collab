import { getDb } from "@kason/db";
import { summarizeStatement } from "@kason/shared";
import type { OwnerStatementLine } from "@kason/shared";
import { getCollectedRentForOwnerMonth } from "../financials/portal.financials.repository";

// ─── Owner-portal "own statements" surface (Task E3) ────────────────────────
//
// READ-ONLY, strictly own-only. Lists THIS owner's owner_statement Invoices and
// resolves the signed PDF download for one of them. EVERY query is scoped by
//   ownerPartyId === session.partyId  AND  organizationId === session.orgId
//   AND invoiceType === "owner_statement"
// so an owner can NEVER see another owner's statement. The cross-owner isolation
// test pins this contract.
//
// The route gates these on ENABLE_PHASE2_OWNER_BILLING — flag-off callers never
// reach the repository (empty list / 404), so the surface is dark when off.

type SessionScope = { partyId: string; orgId: string };

/** One row in the owner's own-statements list. */
export interface OwnerStatementListItem {
  id: string;
  /** First-of-month ISO date, or null when the statement carries no period. */
  periodMonth: string | null;
  status: string;
  /** Invoice.totalAmount, 2dp string. */
  totalAmount: string;
  /** collectedRent − Σ deductions (incl. SST), 2dp string. Optional — present
   *  only when the statement's period resolves a "YYYY-MM" we can price. */
  netRemittance?: string;
  /** Per-unit scope: the Apartment this statement was generated for, or null
   *  for legacy owner-combined statements. Used by the portal unit selector when
   *  an owner holds multiple apartments (Task 11). */
  apartmentId: string | null;
}

function money2dp(value: { toString(): string } | null | undefined): string {
  if (value == null) return "0.00";
  return Number(value.toString()).toFixed(2);
}

/** "YYYY-MM" from a first-of-month period Date (UTC), or null. */
function periodToMonthKey(periodMonth: Date | null): string | null {
  if (!periodMonth) return null;
  const y = periodMonth.getUTCFullYear();
  const m = String(periodMonth.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** First-of-month UTC Date for a "YYYY-MM" month string. */
function firstOfMonthUtc(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/**
 * Per-statement net remittance, computed the SAME way the financials/reports
 * extensions do: collectedRent (D1 helper, owner+org scoped) − Σ(deduction line
 * amount + its SST) via summarizeStatement. The whole Invoice.sstAmount is the
 * statement's aggregate fee SST, so it is attached to EXACTLY ONE management-fee
 * line for the summary (never per-line). Returns undefined when the statement has
 * no resolvable "YYYY-MM" period (we cannot price collected rent without one).
 */
async function netRemittanceFor(
  scope: SessionScope,
  monthKey: string | null,
  sstAmount: { toString(): string } | null,
  charges: { chargeType: string; amount: { toString(): string } }[],
): Promise<string | undefined> {
  if (!monthKey) return undefined;
  const collectedRent = await getCollectedRentForOwnerMonth(scope.orgId, scope.partyId, monthKey);
  const sstTotal = sstAmount === null ? "0.00" : sstAmount.toString();

  let sstAttached = false;
  const lines: OwnerStatementLine[] = charges.map((line) => {
    const isFee = line.chargeType === "management_fee";
    const carriesSst = isFee && !sstAttached;
    if (carriesSst) sstAttached = true;
    return {
      chargeType: line.chargeType,
      amount: line.amount.toString(),
      sstAmount: carriesSst ? sstTotal : "0.00",
    };
  });
  // SST with no fee line to carry it (defensive — SST only exists because a fee
  // line was billed) → append a synthetic zero-base fee line so it still deducts.
  if (!sstAttached && Number(sstTotal) !== 0) {
    lines.push({ chargeType: "management_fee", amount: "0.00", sstAmount: sstTotal });
  }
  return summarizeStatement({ collectedRent, lines }).netRemittance;
}

/**
 * List THIS owner's owner_statement Invoices, optionally filtered by month
 * ("YYYY-MM" → periodMonth first-of-month). Owner+org scoped + invoiceType-pinned
 * — a cross-owner / cross-org / non-statement row is excluded by the WHERE.
 * Each row carries its net remittance (when the period resolves a month).
 */
export async function listOwnStatements(
  scope: SessionScope,
  month?: string,
): Promise<OwnerStatementListItem[]> {
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("Invalid month format");
  }
  const db = getDb();
  const rows = await db.invoice.findMany({
    where: {
      organizationId: scope.orgId,
      ownerPartyId: scope.partyId,
      invoiceType: "owner_statement",
      ...(month ? { periodMonth: firstOfMonthUtc(month) } : {}),
    },
    select: {
      id: true,
      periodMonth: true,
      status: true,
      totalAmount: true,
      sstAmount: true,
      apartmentId: true,
      charges: {
        where: { status: { not: "void" } },
        select: { chargeType: true, amount: true },
      },
    },
    orderBy: { periodMonth: "desc" },
  });

  const items: OwnerStatementListItem[] = [];
  for (const row of rows) {
    const monthKey = periodToMonthKey(row.periodMonth);
    const netRemittance = await netRemittanceFor(scope, monthKey, row.sstAmount, row.charges);
    items.push({
      id: row.id,
      periodMonth: row.periodMonth?.toISOString() ?? null,
      status: row.status,
      totalAmount: money2dp(row.totalAmount),
      apartmentId: row.apartmentId ?? null,
      ...(netRemittance !== undefined ? { netRemittance } : {}),
    });
  }
  return items;
}

/**
 * Resolve the pdfKey for one of THIS owner's statements. Owner+org scoped +
 * invoiceType-pinned: a statement belonging to a different owner (or org), or a
 * non-statement invoice id, resolves to null → the route maps that to 404 (never
 * leak another owner's statement existence). When the statement exists but has no
 * pdfKey, `{ found: true, pdfKey: null }` distinguishes "not generated" (404
 * "PDF not generated") from "not yours / not found" (`null`).
 */
export async function findOwnStatementPdfKey(
  scope: SessionScope,
  id: string,
): Promise<{ pdfKey: string | null } | null> {
  const db = getDb();
  const inv = await db.invoice.findFirst({
    where: {
      id,
      organizationId: scope.orgId,
      ownerPartyId: scope.partyId,
      invoiceType: "owner_statement",
    },
    select: { pdfKey: true },
  });
  if (!inv) return null;
  return { pdfKey: inv.pdfKey ?? null };
}

// ─── Owner-portal statement DETAIL (Task HF1) ───────────────────────────────
//
// The owner-own counterpart to the admin GET /statements/:id detail. Returns ONE
// of THIS owner's statements with its non-void child Charge lines + the same
// money rollup the portal financials surface and the statement PDF agree on:
//   netRemittance = collectedRent − Σ(deduction line + its SST), via
//   summarizeStatement (the SAME helper), and a feeBreakdown describing the
//   management-fee line (or null when no fee line exists). Owner+org scoped +
//   invoiceType-pinned — another owner's id resolves to null → the route maps
//   that to 404 (never leak its existence). READ-ONLY.

/** One non-void line on the owner's own statement detail (Decimals serialised). */
export interface OwnerStatementDetailLine {
  id: string;
  chargeNumber: string;
  chargeType: string;
  unitId: string | null;
  description: string | null;
  /** 2dp money string (RM). */
  amount: string;
  currency: string;
  status: string;
}

/** Management-fee breakdown for the owner's own statement, or null when no fee line. */
export interface OwnerStatementDetailFeeBreakdown {
  percentLabel: string;
  /** Fee base (pre-SST), 2dp string. */
  base: string;
  /** SST charged on the fee, 2dp string. */
  sst: string;
  /** base + sst, 2dp string. */
  total: string;
}

/** The owner-own statement detail DTO returned to the portal. */
export interface OwnerStatementDetail {
  id: string;
  /** First-of-month ISO date, or null when the statement carries no period. */
  periodMonth: string | null;
  status: string;
  currency: string;
  /** Invoice.totalAmount (Σ line amounts + SST), 2dp string. */
  totalAmount: string;
  /** Statement-level fee SST (Invoice.sstAmount), 2dp string. */
  sstAmount: string;
  /** Rent collected for the owner this period, 2dp string. */
  collectedRent: string;
  /** Σ(line amount + its SST), 2dp string. */
  totalDeductions: string;
  /** collectedRent − totalDeductions, 2dp string (may be negative). */
  netRemittance: string;
  lines: OwnerStatementDetailLine[];
  /** Management-fee breakdown, or null when the statement carries no fee line. */
  feeBreakdown: OwnerStatementDetailFeeBreakdown | null;
}

/**
 * Build a human label for the management-fee line from the owner's active fee
 * config: percent → "<value>%", fixed → "Fixed", cap → "Capped"; "Fee" otherwise.
 * Mirrors the financials-extended label helper so the portal reads consistently.
 */
function feePercentLabel(
  feeType: string | null | undefined,
  feeValue: string | null | undefined,
): string {
  if (feeType === "percent" && feeValue != null) {
    return `${feeValue.replace(/\.0+$/, "")}%`;
  }
  if (feeType === "fixed") return "Fixed";
  if (feeType === "cap") return "Capped";
  return "Fee";
}

/**
 * Detail for ONE of THIS owner's statements. Owner+org scoped + invoiceType-pinned
 * — a statement belonging to a different owner (or org), or a non-statement id,
 * resolves to null → 404 at the route (never leak existence). The money rollup is
 * computed the SAME way the financials extension does: collectedRent via the D1
 * helper, netRemittance via summarizeStatement with the whole Invoice.sstAmount
 * attached to EXACTLY ONE management-fee line (never per-line — a multi-fee-line
 * statement would otherwise double-count it).
 */
export async function getOwnStatementDetail(
  scope: SessionScope,
  id: string,
): Promise<OwnerStatementDetail | null> {
  const db = getDb();
  const inv = await db.invoice.findFirst({
    where: {
      id,
      organizationId: scope.orgId,
      ownerPartyId: scope.partyId,
      invoiceType: "owner_statement",
    },
    select: {
      id: true,
      periodMonth: true,
      status: true,
      currency: true,
      totalAmount: true,
      sstAmount: true,
      charges: {
        where: { status: { not: "void" } },
        select: {
          id: true,
          chargeNumber: true,
          chargeType: true,
          unitId: true,
          description: true,
          amount: true,
          currency: true,
          status: true,
        },
        orderBy: { chargeNumber: "asc" },
      },
    },
  });
  // Not this owner's statement (cross-owner / cross-org / unknown) → null → 404.
  if (!inv) return null;

  const monthKey = periodToMonthKey(inv.periodMonth);
  // Collected rent — REUSE the D1 helper (owner+org scoped). When the statement has
  // no resolvable "YYYY-MM" period we cannot price collected rent → treat as 0.
  const collectedRent = monthKey
    ? await getCollectedRentForOwnerMonth(scope.orgId, scope.partyId, monthKey)
    : "0.00";

  // Attach the whole statement SST to EXACTLY ONE management-fee line for the
  // summary (the upstream generate path folds every fee line's SST into the one
  // Invoice.sstAmount column). summarizeStatement sums each line's own sstAmount.
  const sstTotal = inv.sstAmount === null ? "0.00" : inv.sstAmount.toString();
  const hasFeeLine = inv.charges.some((l) => l.chargeType === "management_fee");
  let sstAttached = false;
  const summaryLines: OwnerStatementLine[] = inv.charges.map((line) => {
    const carriesSst = line.chargeType === "management_fee" && !sstAttached;
    if (carriesSst) sstAttached = true;
    return {
      chargeType: line.chargeType,
      amount: line.amount.toString(),
      sstAmount: carriesSst ? sstTotal : "0.00",
    };
  });
  // Defensive: SST with no fee line to carry it (should not happen) → synthetic
  // zero-base fee line so the SST still deducts from net remittance.
  if (!hasFeeLine && Number(sstTotal) !== 0) {
    summaryLines.push({ chargeType: "management_fee", amount: "0.00", sstAmount: sstTotal });
  }
  const summary = summarizeStatement({ collectedRent, lines: summaryLines });

  // feeBreakdown — present only when a management-fee line exists. Base = Σ mgmt-fee
  // line amounts (pre-SST); sst = statement SST; total = base + sst.
  let feeBreakdown: OwnerStatementDetailFeeBreakdown | null = null;
  if (hasFeeLine) {
    const feeConfig = await db.managementFeeConfig.findFirst({
      where: { organizationId: scope.orgId, ownerPartyId: scope.partyId, isActive: true },
      orderBy: { updatedAt: "desc" },
      select: { feeType: true, feeValue: true },
    });
    let feeBaseCents = 0;
    for (const line of inv.charges) {
      if (line.chargeType === "management_fee") {
        feeBaseCents += Math.round(Number(line.amount.toString()) * 100);
      }
    }
    const sstCents = Math.round(Number(sstTotal) * 100);
    feeBreakdown = {
      percentLabel: feePercentLabel(feeConfig?.feeType ?? null, feeConfig?.feeValue?.toString() ?? null),
      base: (feeBaseCents / 100).toFixed(2),
      sst: (sstCents / 100).toFixed(2),
      total: ((feeBaseCents + sstCents) / 100).toFixed(2),
    };
  }

  return {
    id: inv.id,
    periodMonth: inv.periodMonth?.toISOString() ?? null,
    status: inv.status,
    currency: inv.currency,
    totalAmount: money2dp(inv.totalAmount),
    sstAmount: money2dp(inv.sstAmount),
    collectedRent,
    totalDeductions: summary.totalDeductions,
    netRemittance: summary.netRemittance,
    lines: inv.charges.map((ch) => ({
      id: ch.id,
      chargeNumber: ch.chargeNumber,
      chargeType: ch.chargeType,
      unitId: ch.unitId ?? null,
      description: ch.description ?? null,
      amount: money2dp(ch.amount),
      currency: ch.currency,
      status: ch.status,
    })),
    feeBreakdown,
  };
}

// ── Accounting docs: documents linked to one OWN statement ──────────────────

export type PortalStatementDocItem = {
  id: string;
  docType: string;
  documentNumber: string;
  status: string;
  issuedAt: string;
  total: string;
  reason: string | null;
};

/**
 * Documents pointing at this statement via statementInvoiceId (the IVOWN
 * invoice + Plan-3 CNs). Own-data-only: the statement must belong to this
 * owner; returns null when it doesn't (caller 404s — never leak existence).
 */
export async function listOwnStatementDocuments(
  scope: { partyId: string; orgId: string },
  statementId: string,
): Promise<PortalStatementDocItem[] | null> {
  const db = getDb();
  const statement = await db.invoice.findFirst({
    where: { id: statementId, organizationId: scope.orgId, ownerPartyId: scope.partyId, invoiceType: "owner_statement" },
    select: { id: true, periodMonth: true },
  });
  if (!statement) return null;
  // Owner charge-adjustment CN/DNs are minted with originalDocumentId (the
  // statement's IVOWN invoice document), never statementInvoiceId — so without
  // the third OR branch below every owner note was invisible here even though
  // the owner could download one by direct id (punch list C, 2026-08-06).
  const ivownDocs = await db.billingDocument.findMany({
    where: { organizationId: scope.orgId, statementInvoiceId: statementId, docType: "invoice" },
    select: { id: true },
  });
  const rows = await db.billingDocument.findMany({
    where: {
      organizationId: scope.orgId,
      OR: [
        // Documents explicitly linked to this statement (the IVOWN invoice + Plan-3 CNs).
        { statementInvoiceId: statementId },
        // OEA read-time union: an Owner Expense Advice is issued at BILL time, long
        // before a statement exists, so it never carries statementInvoiceId. Match it by
        // owner + period instead. A read-time union avoids mutating issued documents and
        // surfaces the advice even before a statement is issued.
        //
        // OWN-DATA: scoped to THIS owner's partyId — never widen. The statement was
        // already proven to belong to scope.partyId above, and partyId here re-proves it
        // for the unlinked rows, which carry no statement to inherit scoping from.
        //
        // Deliberately NOT gated by ENABLE_OWNER_WEB_EXPENSE_HIDE: that flag declutters
        // the statement's utility list, but this document is the audit trail for money
        // taken out of the owner's rent and must always be reachable.
        ...(statement.periodMonth
          ? [{
              docType: "owner_expense_advice",
              counterpartyType: "owner",
              partyId: scope.partyId,
              billingMonth: statement.periodMonth,
            }]
          : []),
        // Owner CN/DN read-time union: notes reference the IVOWN by
        // originalDocumentId. OWN-DATA re-proven via partyId, same as the OEA
        // branch — the note must belong to THIS owner, not merely reference a
        // document of theirs.
        ...(ivownDocs.length
          ? [{
              docType: { in: ["credit_note", "debit_note"] },
              counterpartyType: "owner",
              partyId: scope.partyId,
              originalDocumentId: { in: ivownDocs.map((d) => d.id) },
            }]
          : []),
      ],
    },
    select: { id: true, docType: true, documentNumber: true, status: true, issuedAt: true, total: true, reason: true },
    orderBy: { issuedAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    docType: r.docType,
    documentNumber: r.documentNumber,
    status: r.status,
    issuedAt: r.issuedAt.toISOString(),
    total: (() => { const n = parseFloat(r.total.toString()); return Number.isNaN(n) ? "0.00" : n.toFixed(2); })(),
    reason: r.reason,
  }));
}

/** Own-document check for the owner PDF route (any doc on any OWN statement). */
export async function findOwnStatementDocument(
  scope: { partyId: string; orgId: string },
  docId: string,
): Promise<{ id: string } | null> {
  const db = getDb();
  const doc = await db.billingDocument.findFirst({
    where: { id: docId, organizationId: scope.orgId, counterpartyType: "owner", partyId: scope.partyId },
    select: { id: true },
  });
  return doc;
}
