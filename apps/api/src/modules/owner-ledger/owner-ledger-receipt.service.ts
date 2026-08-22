/**
 * owner-ledger-receipt.service.ts — On-demand Receipt PDF builder (Task 6).
 *
 * Produces a clean expense invoice PDF for the owner's pass-through expenses
 * for a given month, optionally scoped to one apartment.
 *
 * PURE READ — no audit, no money mutation, no storage write.
 * - NOT stored; NOT portal-visible.
 * - Reads the SAME ledger rows as the statement (via findOwnerLedgerRowsForMonth)
 *   so they can't disagree.
 *
 * Redesigned 2026-06-30 (spec: 2026-06-30-owner-expense-receipt-invoice-redesign.md):
 *   Content changed from a ledger dump to a clean expense invoice (iBilikPlus
 *   "Supplier Invoice" style). Filters to EXPENSE rows only; stored management_fee
 *   rows are excluded and replaced by a COMPUTED fee (via computeOwnerPayout,
 *   identical to the statement) so the receipt total foots to the statement's
 *   deductible-expenses total. Uses the existing landscape letterhead band (unchanged).
 *
 * Public surface:
 *   buildOwnerLedgerReceiptModel  — pure data model (testable without Chromium)
 *   buildOwnerLedgerReceiptPdf    — model → HTML → htmlToPdf → Uint8Array | null
 *   buildReceiptWithBillsPdf      — receipt + appended bills PDF
 */

import { getDb } from "@kason/db";
import { toCents, centsToString } from "@kason/shared";
import { htmlToPdf } from "../../lib/document-templates/pdf";
import { mergePdfs } from "../../lib/document-templates/merge-pdfs";
import { getTemplateForOrgDocType } from "../../lib/document-templates/service";
import type { ResolvedTemplate } from "../../lib/document-templates/types";
import {
  findOwnerLedgerRowsForMonth,
  computeOwnerPayout,
  isSuppressedFromSection5,
} from "../owner-billing/owner-statement-sections";
import { buildProofPackPdf } from "../owner-billing/proof-pack.service";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ReceiptLineItem {
  description: string;    // categoryToLabel(category) [+ row description if present]
  billingPeriod: string;  // month label e.g. "June 2026"
  qty: string;            // always "1.00"
  unitPrice: string;      // 2dp string
  amount: string;         // 2dp string (same as unitPrice for qty=1)
  tax: string;            // 2dp string — sstAmount or "0.00" for pass-through
}

export interface ReceiptModel {
  header: {
    template: ResolvedTemplate | null;  // existing owner_statement letterhead
    title: "Invoice";
    receiptNo: string;                  // derived: <IVOWN-series-prefix>-<YYYYMM>-<unit-or-ALL>
    date: string;                       // generation date YYYY-MM-DD
    property: string;                   // scopeLabel: unitCode or "All units"
    ownerName: string;
    period: string;                     // monthLabel e.g. "June 2026"
  };
  lineItems: ReceiptLineItem[];
  totals: {
    subTotal: string;   // Σ amount
    sst: string;        // Σ tax
    total: string;      // subTotal + sst
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function firstOfMonthUtc(month: string): Date {
  // month = "YYYY-MM"
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

function monthLabel(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function money2dp(val: { toString(): string } | null | undefined): string {
  if (val === null || val === undefined) return "0.00";
  const n = parseFloat(val.toString());
  return isNaN(n) ? "0.00" : n.toFixed(2);
}

function categoryToLabel(category: string): string {
  const MAP: Record<string, string> = {
    rental_income: "Rental Income",
    carpark_income: "Carpark Income",
    aircond_income: "Aircond Fee",
    utility_income: "Shared Utility Income",
    management_fee: "Management Fee",
    cleaning: "Cleaning",
    utilities_tnb: "Electricity (TNB)",
    tnb: "Electricity (TNB)",
    water: "Water",
    indah_water: "Sewerage / Indah Water",
    wifi: "Wi-Fi",
    maintenance: "Maintenance",
    insurance: "Fire Insurance",
    assessment_tax: "Assessment Tax",
    sewerage: "Sewerage / Indah Water",
    cukai_petak: "Cukai Petak",
    access_card: "Access Card",
    other: "Other",
    other_expense: "Other",
  };
  return MAP[category] ?? category;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Derive a deterministic receipt number from the month + scope.
 *
 * Format: <refPrefix>-<YYYYMM>-<scope>
 * <refPrefix> = the org's owner-document accounting series prefix
 *   (DocumentSeries where code="IVOWN"), passed in by the caller — falls
 *   back to the literal "IVOWN" when the org has no such row yet (see
 *   buildOwnerLedgerReceiptModel). This is an OWNER document, so refPrefix
 *   is ALWAYS resolved from the IVOWN series, never IVTEN (tenant-side).
 * <scope> = unitCode (or "ALL") sanitized to alphanumeric + hyphen.
 *
 * This is a DERIVED, non-persisted display string — it reads the series'
 * prefix but never allocates/mints a sequence number from it (unlike real
 * IVOWN invoices, which are minted via mintDocumentNumberTx).
 */
function buildReceiptNo(month: string, scopeLabel: string, refPrefix: string): string {
  // month is "YYYY-MM" — strip the dash for the YYYYMM component
  const yyyymm = month.replace("-", "");
  // sanitize: keep alphanumeric and hyphens, collapse spaces to hyphen
  const scope = scopeLabel
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .toUpperCase();
  return `${refPrefix}-${yyyymm}-${scope || "ALL"}`;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the data model for the expense receipt without invoking Chromium.
 *
 * Filters to EXPENSE rows only (direction === "expense"), excluding stored
 * management_fee rows (which are superseded by a fresh per-income-line computation
 * that is byte-identical to the statement assembler's deductible-expenses total).
 * Returns null when there are no qualifying expense rows for the given scope —
 * the HTTP route should respond 404 in that case.
 */
export async function buildOwnerLedgerReceiptModel(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  month: string,
  apartmentId: string | null,
): Promise<ReceiptModel | null> {
  const db = getDb();
  const monthStart = firstOfMonthUtc(month);

  const allRows = await findOwnerLedgerRowsForMonth(ctx, ownerPartyId, monthStart, apartmentId);

  // ── Management fee: SAME computation path as assembleYannieStatement ──────────
  //
  // The statement SUPPRESSES stored management_fee ledger rows and instead COMPUTES
  // the fee from income lines via computeOwnerPayout → computeManagementFee (so the
  // statement's deductible total is never read from a stored row). The receipt reuses
  // EXACTLY this computation so receipt.totals.total === statement.deductibleExpensesC
  // for the same scope — they can never diverge even if the fee config changes after
  // the charges were posted.
  //
  // Per-apartment scoping is automatic: allRows is already scoped to the requested
  // apartmentId by findOwnerLedgerRowsForMonth, so the computed fee covers only the
  // income lines of that apartment.
  //
  // NOTE: This fetch + computation is placed BEFORE the null guard below so that a
  // non-zero management fee alone can keep the receipt non-null (e.g. when all expense
  // rows are owner-paid / display-only twins and therefore excluded by the deductible
  // filter, but KAEN still collects a computed management fee from the income).
  const feeConfigRows = await db.managementFeeConfig.findMany({
    where: { organizationId: ctx.orgId, ownerPartyId, isActive: true },
    select: {
      propertyId: true,
      apartmentId: true,
      feeType: true,
      feeValue: true,
      capAmount: true,
      sstPercent: true,
      effectiveFrom: true,
      effectiveTo: true,
      freePeriodStart: true,
      freePeriodEnd: true,
      updatedAt: true,
    },
  });
  const payoutBreakdown = computeOwnerPayout({
    rows: allRows,
    feeConfigRows,
    depositCollectedC: 0,
    statementMonth: monthStart,
  });
  const { computedMgmtBaseC, computedMgmtSstC, computedMgmtTotalC } = payoutBreakdown;

  // Filter: EXPENSE rows only, using the IDENTICAL predicate the statement uses for its
  // deductible-expenses total so that receipt.totals.total === statement.deductibleExpensesC.
  //
  // Three classes excluded:
  //   1. management_fee rows — superseded by the computed fee appended below
  //   2. Source-2 display-only utility twins (includeInPayout:false, category in
  //      SECTION5_DISPLAY_ONLY_UTILITY_CATEGORIES) — the full Source-3 supplier bill
  //      (includeInPayout:true) is included instead; keeping the twin would double-count.
  //   3. Owner-paid expenses (includeInPayout:false, paidBy !== "kaen") — excluded from
  //      the deductible total on the statement; shown there as a non-deductible memo line.
  //
  // isSuppressedFromSection5 covers classes 1 and 2; the && e.includeInPayout guard
  // covers class 3 (owner-paid non-twin rows with includeInPayout:false).
  const expenseRows = allRows.filter(
    (e) =>
      e.direction === "expense" &&
      !isSuppressedFromSection5(e.category, e.includeInPayout) &&
      e.includeInPayout,
  );

  // Return null when there are no deductible expense rows AND no management fee.
  // This keeps the "404 when nothing to show" contract for the HTTP route while
  // allowing the receipt to render with ONLY a management fee line (e.g. when all
  // expense rows are owner-paid or display-only twins but income still accrues a fee).
  if (expenseRows.length === 0 && computedMgmtTotalC === 0) return null;

  // Owner-document reference prefix: sourced from this org's IVOWN accounting
  // series (never IVTEN — this is always an OWNER document, per the same
  // (organizationId, code) lookup shape billing-documents/issue.service.ts
  // uses to resolve a series for real document minting). Falls back to the
  // literal "IVOWN" when the org has no such row yet — DocumentSeries rows
  // are lazily seeded per-org (see charge-categories/seed.ts), so a freshly
  // created org may not have one. This receipt only reads the prefix
  // string; it never mints a sequence number (see file header).
  const ownerSeries = await db.documentSeries.findFirst({
    where: { organizationId: ctx.orgId, code: "IVOWN" },
    select: { prefix: true },
  });
  const refPrefix = ownerSeries?.prefix || "IVOWN";

  // Build listing → unitCode and apartment → unitCode maps for scopeLabel resolution.
  const listings = await db.listing.findMany({
    where: {
      ownerPartyId,
      organizationId: ctx.orgId,
      listingStatus: { not: "archived" },
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: {
      id: true,
      apartmentId: true,
      apartment: { select: { unitCode: true } },
    },
  });

  const apartmentToUnitCode = new Map<string, string>();
  for (const l of listings) {
    if (l.apartment) {
      apartmentToUnitCode.set(l.apartmentId, l.apartment.unitCode);
    }
  }

  // Derive scopeLabel
  let scopeLabel = "All units";
  if (apartmentId) {
    scopeLabel = apartmentToUnitCode.get(apartmentId) ?? apartmentId.slice(0, 8);
  }

  // Owner name
  const party = await db.party.findFirst({
    where: { id: ownerPartyId, organizationId: ctx.orgId },
    select: { displayName: true },
  });
  const ownerName = party?.displayName ?? "Owner";

  const period = monthLabel(monthStart);

  // Map expense rows → line items
  let subTotalCents = 0;
  let sstCents = 0;

  const lineItems: ReceiptLineItem[] = expenseRows.map((e) => {
    const amountStr = money2dp(e.amount);
    const taxStr = money2dp(e.sstAmount);

    subTotalCents += toCents(amountStr, "buildOwnerLedgerReceiptModel.subTotal");
    sstCents += toCents(taxStr, "buildOwnerLedgerReceiptModel.sst");

    // description: category label; append row description when present
    const categoryLabel = categoryToLabel(e.category);
    const description = e.description
      ? `${categoryLabel} — ${e.description}`
      : categoryLabel;

    return {
      description,
      billingPeriod: period,
      qty: "1.00",
      unitPrice: amountStr,
      amount: amountStr,
      tax: taxStr,
    };
  });

  // Append management fee line when the computed fee is non-zero.
  // The base goes in Amount; the SST on that base goes in Tax.
  if (computedMgmtTotalC > 0) {
    subTotalCents += computedMgmtBaseC;
    sstCents += computedMgmtSstC;
    lineItems.push({
      description: categoryToLabel("management_fee"),
      billingPeriod: period,
      qty: "1.00",
      unitPrice: centsToString(computedMgmtBaseC),
      amount: centsToString(computedMgmtBaseC),
      tax: centsToString(computedMgmtSstC),
    });
  }

  const totalCents = subTotalCents + sstCents;

  return {
    header: {
      template: null, // populated by the PDF builder after DB fetch
      title: "Invoice",
      receiptNo: buildReceiptNo(month, scopeLabel, refPrefix),
      date: isoDate(new Date()),
      property: scopeLabel,
      ownerName,
      period,
    },
    lineItems,
    totals: {
      subTotal: centsToString(subTotalCents),
      sst: centsToString(sstCents),
      total: centsToString(totalCents),
    },
  };
}

// ─── HTML renderer ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a minimal landscape letterhead band matching the template's owner_statement
 * header fields.  Three-zone CSS grid (logo | org name+IDs+contact, centered | title,
 * right-aligned) separated from the body by a bottom border — mirrors the portrait
 * renderToHtml `.doc-header` grid (document-templates/render.ts) but is self-contained
 * HTML so it doesn't depend on the React render pipeline.
 *
 * When `template` is null the band is omitted (graceful fallback — see standaloneTitle
 * in renderOwnerLedgerReceiptHtml, which is centered too as defense-in-depth).
 *
 * The right-zone title is driven by the `title` param (model.header.title = "Invoice") —
 * a single source so the band, the standalone fallback and the <title> tag can never
 * disagree.
 */
function renderLetterheadBand(template: ResolvedTemplate | null, title: string): string {
  if (!template) return "";

  const h = template.headerFields;

  const logoHtml =
    h.showLogo && template.logoUrl
      ? `<img src="${esc(template.logoUrl)}" alt="logo" style="max-width:100%;max-height:30mm">`
      : "";

  const centerLines: string[] = [
    `<div class="lh-org-name">${esc(template.orgName)}</div>`,
  ];
  if (h.showRegNo && template.orgRegNo) {
    centerLines.push(`<div class="lh-meta">Reg No: ${esc(template.orgRegNo)}</div>`);
  }
  if (h.showSalesTaxId && template.orgSalesTaxId) {
    centerLines.push(`<div class="lh-meta">Sales Tax ID: ${esc(template.orgSalesTaxId)}</div>`);
  }
  if (h.showServiceTaxId && template.orgServiceTaxId) {
    centerLines.push(`<div class="lh-meta">Service Tax ID: ${esc(template.orgServiceTaxId)}</div>`);
  }
  if (h.showAddress) {
    for (const line of template.orgAddressLines) {
      centerLines.push(`<div class="lh-meta">${esc(line)}</div>`);
    }
  }
  if (h.showEmail && template.orgEmail) {
    centerLines.push(`<div class="lh-meta">Email: ${esc(template.orgEmail)}</div>`);
  }
  if (h.showContact && template.orgContact) {
    centerLines.push(`<div class="lh-meta">Contact: ${esc(template.orgContact)}</div>`);
  }

  return `
<div class="lh-band">
  <div class="lh-logo">${logoHtml}</div>
  <div class="lh-center">${centerLines.join("")}</div>
  <div class="lh-title">${esc(title)}</div>
</div>`;
}

/**
 * Render the landscape receipt HTML — clean invoice layout.
 * Exported for unit-testing the layout without invoking Chromium.
 */
export function renderOwnerLedgerReceiptHtml(
  model: ReceiptModel,
  template: ResolvedTemplate | null,
): string {
  const { header, lineItems, totals } = model;

  // Line items table rows
  const lineItemsHtml = lineItems
    .map((li, idx) => `
      <tr>
        <td style="text-align:center">${idx + 1}</td>
        <td>${esc(li.description)}</td>
        <td style="text-align:center">${esc(li.qty)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">RM ${esc(li.unitPrice)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">RM ${esc(li.amount)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${li.tax === "0.00" ? "0.00" : `RM ${esc(li.tax)}`}</td>
      </tr>`.trim())
    .join("\n      ");

  // Footer text from template (org info) or generic fallback.
  // Respect the same showRegNo / showSalesTaxId / showContact flags that the letterhead uses.
  const footerOrgLine = template
    ? [
        template.orgName,
        template.headerFields.showRegNo && template.orgRegNo ? `Reg No: ${template.orgRegNo}` : null,
        template.headerFields.showSalesTaxId && template.orgSalesTaxId ? `SST: ${template.orgSalesTaxId}` : null,
        template.headerFields.showContact && template.orgContact ? `Tel: ${template.orgContact}` : null,
      ]
        .filter(Boolean)
        .map((s) => esc(s!))
        .join(" · ")
    : "";

  const css = `
    @page { size: A4 landscape; margin: 15mm 12mm 18mm 12mm }
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #1f2937; line-height: 1.4 }
    /* Landscape letterhead band — 3-zone grid (logo | centered org name + IDs |
       right-aligned title), mirroring the reservation form's .doc-header grid in
       document-templates/render.ts so every generated document shares one balanced
       letterhead layout instead of the old left-jammed flex row. */
    .lh-band { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 6mm; align-items: start; padding-bottom: 4mm; border-bottom: 1px solid #d1d5db; margin-bottom: 4mm }
    .lh-center { text-align: center }
    .lh-org-name { font-size: 11pt; font-weight: 700; margin-bottom: 1mm }
    .lh-meta { font-size: 8pt; color: #4b5563; line-height: 1.4 }
    .lh-title { font-size: 11pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5pt; text-align: right; white-space: nowrap; padding-top: 1mm }
    /* Receipt info block */
    .info-block { display: flex; justify-content: space-between; margin-bottom: 6mm; font-size: 9pt }
    .info-left .info-row { margin-bottom: 1.5mm }
    .info-left .info-label { font-size: 8pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.3pt; display: inline-block; width: 18mm }
    .info-left .info-value { font-weight: 600 }
    .info-right { text-align: right }
    .info-right .receipt-no { font-size: 10pt; font-weight: 700 }
    .info-right .receipt-date { font-size: 8pt; color: #6b7280; margin-top: 1mm }
    /* Table */
    table { width: 100%; border-collapse: collapse; margin-top: 2mm }
    thead tr { background: #f3f4f6 }
    th {
      text-align: left; font-size: 8pt; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5pt; padding: 2mm 3mm; border-bottom: 2px solid #d1d5db
    }
    td { padding: 1.5mm 3mm; border-bottom: 1px solid #e5e7eb; vertical-align: top }
    tbody tr:last-child td { border-bottom: none }
    /* Totals */
    .totals { margin-top: 5mm; border-top: 2px solid #111827; padding-top: 3mm }
    .totals-row { display: flex; justify-content: flex-end; gap: 20mm; margin-bottom: 1.5mm }
    .totals-row .tot-label { font-size: 8pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4pt; min-width: 42mm; text-align: right }
    .totals-row .tot-value { font-size: 9pt; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 22mm; text-align: right }
    .totals-row.grand .tot-label { font-size: 9pt; font-weight: 700; color: #111827 }
    .totals-row.grand .tot-value { font-size: 11pt; font-weight: 700 }
    /* Footer */
    .doc-footer { margin-top: 7mm; border-top: 1px solid #d1d5db; padding-top: 3mm; font-size: 7.5pt; color: #6b7280 }
  `;

  const letterheadHtml = renderLetterheadBand(template, header.title);

  // When there's no letterhead band, render a standalone title so the document title is visible
  const standaloneTitle = template
    ? ""
    : `<div class="standalone-title">${esc(header.title)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>${esc(header.title)}</title><style>${css}.standalone-title{font-size:14pt;font-weight:700;text-transform:uppercase;letter-spacing:0.5pt;margin-bottom:4mm;text-align:center}</style></head>
<body>
  ${letterheadHtml}
  ${standaloneTitle}

  <div class="info-block">
    <div class="info-left">
      <div class="info-row"><span class="info-label">Property</span><span class="info-value">${esc(header.property)}</span></div>
      <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${esc(header.ownerName)}</span></div>
      <div class="info-row"><span class="info-label">Period</span><span class="info-value">${esc(header.period)}</span></div>
    </div>
    <div class="info-right">
      <div class="receipt-no">${esc(header.receiptNo)}</div>
      <div class="receipt-date">Date: ${esc(header.date)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="text-align:center;width:8mm">#</th>
        <th>Description</th>
        <th style="text-align:center;width:12mm">Qty</th>
        <th style="text-align:right;width:28mm">Unit Price</th>
        <th style="text-align:right;width:28mm">Amount</th>
        <th style="text-align:right;width:22mm">Tax</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
    </tbody>
  </table>

  <div class="totals">
    <div class="totals-row">
      <span class="tot-label">Sub Total</span>
      <span class="tot-value">RM ${esc(totals.subTotal)}</span>
    </div>
    <div class="totals-row">
      <span class="tot-label">Sales &amp; Service Tax</span>
      <span class="tot-value">${totals.sst === "0.00" ? "0.00" : `RM ${esc(totals.sst)}`}</span>
    </div>
    <div class="totals-row grand">
      <span class="tot-label">Total</span>
      <span class="tot-value">RM ${esc(totals.total)}</span>
    </div>
  </div>

  <div class="doc-footer">
    <div>This is a computer-generated invoice. No signature required.</div>
    ${footerOrgLine ? `<div>${footerOrgLine}</div>` : ""}
  </div>
</body>
</html>`;
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Build an on-demand expense receipt PDF for an owner's pass-through expenses.
 *
 * Returns null when there are no qualifying expense rows for the given scope —
 * the HTTP route should respond 404 in that case.
 *
 * PURE READ: no audit, no money mutation, no storage write.
 */
export async function buildOwnerLedgerReceiptPdf(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  month: string,
  apartmentId: string | null,
): Promise<Uint8Array | null> {
  const model = await buildOwnerLedgerReceiptModel(ctx, ownerPartyId, month, apartmentId);
  if (!model) return null;

  // Fetch the owner_statement template (same docType as the portrait statement) so
  // the letterhead (logo/org name/reg+tax IDs/contact) stays in sync when the admin
  // edits the Document Templates settings.  On failure (org not found, etc.) we fall
  // back to null — the receipt still renders, just without a letterhead.
  //
  // tolerateLogoFailure: true — this on-demand invoice is a PURE READ that is
  // never persisted or portal-visible (see file header), so a transient
  // logo-signing hiccup should degrade to a logoless letterhead rather than
  // fail the whole download. This is an explicit opt-in: getTemplateForOrgDocType
  // defaults to throwing on a logo failure so the callers that DO persist/email
  // their PDF (owner statement regenerate, reservation customer-sign, etc.)
  // keep failing loudly. The outer try/catch here remains as a broader safety
  // net for any OTHER failure (e.g. org not found).
  let template: ResolvedTemplate | null = null;
  try {
    template = await getTemplateForOrgDocType(ctx.orgId, "owner_statement", {
      tolerateLogoFailure: true,
    });
  } catch {
    // Non-fatal — the receipt still renders; we just omit the letterhead band.
  }

  // Inject the resolved template into the model header for the renderer
  const modelWithTemplate: ReceiptModel = {
    ...model,
    header: { ...model.header, template },
  };

  const buf = await htmlToPdf(renderOwnerLedgerReceiptHtml(modelWithTemplate, template));
  return new Uint8Array(buf);
}

/**
 * Compose receipt + attached bills into one PDF.
 *
 * Builds the itemized expense receipt (via buildOwnerLedgerReceiptPdf) then appends
 * the proof-pack PDF (via buildProofPackPdf) using the existing encryption-resilient
 * mergePdfs helper.  Returns null when there are no qualifying expense rows (same
 * contract as buildOwnerLedgerReceiptPdf).  When there are no attached bills the
 * receipt is returned unchanged (mergePdfs returns the base when the append list is empty).
 *
 * PURE READ: no audit, no money mutation, no storage write.
 */
export async function buildReceiptWithBillsPdf(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  month: string,
  apartmentId: string | null,
): Promise<Uint8Array | null> {
  const receipt = await buildOwnerLedgerReceiptPdf(ctx, ownerPartyId, month, apartmentId);
  if (!receipt) return null;
  const bills = await buildProofPackPdf(ctx, ownerPartyId, month, apartmentId);
  const merged = await mergePdfs(Buffer.from(receipt), bills ? [Buffer.from(bills)] : []);
  return new Uint8Array(merged);
}
