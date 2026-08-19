// owner-statement-pdf.ts — the Yannie 5-section owner-statement PDF body
// renderer. Pure function: structured YannieSections in → HTML body string out
// (no <html>/<head>/<body> wrapper), consumed by renderToHtml() in
// apps/api/src/lib/document-templates/render.ts. HTML-escaped interpolation + RM
// formatting throughout. The statement is a CLEAN 5-section summary — supporting
// bills/receipts live separately (per-expense bills + proof pack), never
// embedded or appended here.

import type { YannieSections } from "./owner-statement-sections";

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRM(value: string): string {
  // `value` is already a canonical decimal string (RM) produced upstream by the
  // cent primitives. Parse once for the en-MY thousands grouping; the leading
  // "-" on a negative net remittance is preserved by toLocaleString.
  const n = Number(value);
  if (Number.isNaN(n)) return `RM ${esc(value)}`;
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Yannie 5-Section PDF renderer (Task 2b-2) ────────────────────────────────

/**
 * Renders the 5-section Yannie owner statement as an HTML body string.
 * Pure function: YannieSections in → HTML string out. No I/O.
 *
 * Sections (in order):
 *  1. Header — property, owner, bank (account number already masked by assembler)
 *  2. Occupancy & Deposit — per-unit occupancy snapshot
 *  3. Payout Summary — totals block with net payout to owner
 *  4. Income Breakdown — per-unit income rows with mgmt fee / SST columns
 *  5. Expenses Breakdown — per-expense rows
 *
 * The statement is a CLEAN summary: it embeds/appends NO receipts or bills —
 * supporting evidence lives in the per-expense bills + the separate proof pack.
 */
export function buildYanniePdfHtml(sections: YannieSections): string {
  const { header, occupancy, payoutSummary, incomeBreakdown, expenseBreakdown } = sections;

  // ── Section 1: Header ────────────────────────────────────────────────────────
  const section1 = `
    <section>
      <h3>Owner Statement</h3>
      <table class="info-grid">
        <tbody>
          <tr>
            <td class="label">Owner</td>
            <td class="value">${esc(header.ownerName)}</td>
            <td class="label">Report Month</td>
            <td class="value">${esc(header.reportMonth)}</td>
          </tr>
          <tr>
            <td class="label">Property</td>
            <td class="value">${esc(header.propertyName)}</td>
            <td class="label">Bank</td>
            <td class="value">${esc(header.bankName ?? "—")}</td>
          </tr>
          <tr>
            <td class="label">Account Holder</td>
            <td class="value">${esc(header.accountHolder ?? "—")}</td>
            <td class="label">Account No.</td>
            <td class="value">${esc(header.accountNumberMasked ?? "—")}</td>
          </tr>
        </tbody>
      </table>
    </section>`;

  // ── Section 2: Occupancy & Deposit ───────────────────────────────────────────
  const occupancyRowsHtml = occupancy.rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.unitCode)}</td>
          <td>${esc(row.tenantName ?? "—")}</td>
          <td>${esc(row.tenancyStart ?? "—")}</td>
          <td>${esc(row.tenancyEnd ?? "—")}</td>
          <td class="num">${esc(formatRM(row.monthlyRental))}</td>
          <td class="num">${row.depositMonths != null ? esc(String(row.depositMonths)) : "—"}</td>
          <td class="num">${esc(formatRM(row.depositAmount))}</td>
          <td>${row.isVacant ? "Vacant" : "Occupied"}</td>
        </tr>`,
    )
    .join("");

  const section2 = `
    <section>
      <h3>Occupancy &amp; Deposit</h3>
      <table class="items">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Tenant</th>
            <th>Start</th>
            <th>End</th>
            <th class="num">Monthly Rental</th>
            <th class="num">Deposit (Mths)</th>
            <th class="num">Deposit Amt</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${occupancyRowsHtml}</tbody>
      </table>
      <p class="sst-note">Occupied: ${esc(String(occupancy.occupiedCount))} | Vacant: ${esc(String(occupancy.vacantCount))} | Total Monthly Rental: ${esc(formatRM(occupancy.totalMonthlyRental))}</p>
    </section>`;

  // ── Section 3: Payout Summary ─────────────────────────────────────────────────
  const summaryLinesHtml = payoutSummary.lines
    .map(
      (line) => `
        <tr class="${line.isTotal ? "net-row" : line.isNonIncome ? "non-income-row" : ""}">
          <td class="label">${esc(line.label)}</td>
          <td class="num value">${esc(formatRM(line.amount))}</td>
        </tr>`,
    )
    .join("");

  const section3 = `
    <section class="totals-section">
      <h3>Payout Summary</h3>
      <table class="totals-grid">
        <tbody>${summaryLinesHtml}</tbody>
      </table>
    </section>`;

  // ── Section 4: Income Breakdown ───────────────────────────────────────────────
  const incomeRowsHtml = incomeBreakdown.rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.unitCode)}</td>
          <td>${esc(row.tenantName ?? "—")}</td>
          <td>${esc(row.incomeType)}${
            // WHICH utility the line is. Several rows carry the same incomeType, so
            // without this the PDF lists indistinguishable "Shared Utility" lines.
            row.detail ? `<div class="pob">${esc(row.detail)}</div>` : ""
          }</td>
          <td>${esc(row.billingPeriod)}</td>
          <td class="num">${esc(formatRM(row.chargedAmount ?? row.amount))}</td>
          <td class="num">${esc(formatRM(row.mgmtFee))}</td>
          <td class="num">${esc(formatRM(row.mgmtFeeSst))}</td>
          <td>${esc(row.paymentStatus)}${row.paymentStatus !== "paid" && row.chargedAmount && row.chargedAmount !== row.amount ? ` (collected ${esc(formatRM(row.amount))})` : ""}${
            // An INFORMATIONAL row is not earnings and is outside Total Income, but its
            // amount still prints in the Amount column — on a money document that reads
            // as income unless the page says otherwise. The web statement has always
            // carried this note; the PDF did not, so a letting-commission month printed
            // a rent figure the owner never received with nothing marking it.
            //
            // The two kinds mean OPPOSITE things about the payout, so the copy branches:
            // letting commission never reaches the owner, whereas the partition aircond
            // spread already did (as Aircond Fee minus the master TNB expense) and is
            // listed only to explain where the difference came from.
            row.isInformational
              ? `<div class="pob">${row.incomeType === "Extra Electricity" ? "Already included in your payout" : "Retained by KAEN — not part of payout"}</div>`
              : ""
          }</td>
        </tr>`,
    )
    .join("");

  const section4 = `
    <section>
      <h3>Income Breakdown</h3>
      <table class="items">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Tenant</th>
            <th>Type</th>
            <th>Period</th>
            <th class="num">Amount (RM)</th>
            <th class="num">Mgmt Fee (RM)</th>
            <th class="num">SST (RM)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${incomeRowsHtml}</tbody>
      </table>
      <p class="sst-note">Total Income: ${esc(formatRM(incomeBreakdown.totalIncome))} | Total Mgmt Fee (incl. SST): ${esc(formatRM(incomeBreakdown.totalMgmtFee))}</p>${
        // Tenant utilities KAEN collected and forwarded to suppliers. Stated
        // explicitly so the PDF cannot be read as owing the owner this money — it is
        // excluded from Total Income and from the payout, matching the web statement.
        Number(incomeBreakdown.passThroughIncome ?? 0) > 0
          ? `\n      <p class="sst-note">Tenant utilities collected &amp; paid to suppliers (not part of your payout): ${esc(formatRM(incomeBreakdown.passThroughIncome))}</p>`
          : ""
      }
    </section>`;

  // ── Section 5: Expenses Breakdown ────────────────────────────────────────────
  const expenseRowsHtml = expenseBreakdown.rows
    .map((row) => {
      // Task 9: subtle "Paid on behalf — <payee>[ · ref X][ · DATE]" note beside the
      // description when KAEN settled this expense on the owner's behalf.
      const paidOnBehalf = row.payeeName
        ? `<div class="pob">Paid on behalf — ${esc(row.payeeName)}${
            row.paidOnBehalfRef ? ` · ref ${esc(row.paidOnBehalfRef)}` : ""
          }${row.paidOnBehalfDate ? ` · ${esc(row.paidOnBehalfDate)}` : ""}</div>`
        : "";
      // The credit/debit notes behind the Amount + SST columns. §5 prints the
      // ADJUSTED figure, so without this the PDF documented a RM 1.00 owner expense
      // as RM 0.50 and named nothing the owner could check that against. §4 has
      // carried the same sentence beside the income line it moved since 2026-08-07.
      const adjustmentNote = row.adjustmentNote
        ? `<div class="pob">${esc(row.adjustmentNote)}</div>`
        : "";
      return `
        <tr>
          <td>${esc(row.category)}</td>
          <td>${esc(row.description ?? "—")}${adjustmentNote}${paidOnBehalf}</td>
          <td class="num">${esc(formatRM(row.amount))}</td>
          <td class="num">${esc(formatRM(row.sstAmount))}</td>
          <td>${esc(row.paymentStatus)}</td>
        </tr>`;
    })
    .join("");

  const section5 = `
    <section>
      <h3>Expenses Breakdown</h3>
      <table class="items">
        <thead>
          <tr>
            <th>Category</th>
            <th>Description</th>
            <th class="num">Amount (RM)</th>
            <th class="num">SST (RM)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${expenseRowsHtml}</tbody>
      </table>
      <p class="sst-note">Total Expenses: ${esc(formatRM(expenseBreakdown.totalExpenses))}</p>
    </section>`;

  return `
    ${section1}
    ${section2}
    ${section3}
    ${section4}
    ${section5}

    <style>
      /* ── shared grid / table styles ── */
      .info-grid { width: 100%; border-collapse: collapse; margin-top: 1mm; }
      .info-grid td { padding: 1.2mm 0; font-size: 10pt; vertical-align: top; }
      .info-grid td.label { width: 16%; color: #4b5563; font-weight: 600; }
      .info-grid td.value { width: 34%; color: #111827; }

      .items { width: 100%; border-collapse: collapse; margin-top: 2mm; table-layout: auto; }
      .items th, .items td {
        padding: 1.4mm 1.5mm; font-size: 9.5pt; border-bottom: 1px solid #e5e7eb;
        text-align: left; vertical-align: top;
      }
      .items th {
        background: #f9fafb; color: #4b5563; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.2pt; font-size: 8pt;
      }
      .items td.num, .items th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .items tbody tr { page-break-inside: avoid; }

      .sst-note { margin-top: 2mm; font-size: 8.5pt; color: #6b7280; font-style: italic; }
      /* Task 9: paid-on-behalf sub-line under an expense description. */
      .pob { margin-top: 0.6mm; font-size: 8pt; color: #6b7280; font-style: italic; }

      /* ── payout summary ── */
      .totals-grid { width: 80mm; margin-left: auto; border-collapse: collapse; margin-top: 1mm; }
      .totals-grid td { padding: 1.2mm 0; font-size: 10pt; }
      .totals-grid td.label { color: #4b5563; }
      .totals-grid td.value { text-align: right; font-variant-numeric: tabular-nums; }
      .totals-grid tr.net-row td {
        border-top: 1.5px solid #111827; font-weight: 700; padding-top: 2mm;
        text-transform: uppercase; letter-spacing: 0.4pt;
      }
      .totals-grid tr.net-row td.value { color: #c9a44b; }
      .totals-grid tr.non-income-row td { color: #6b7280; font-style: italic; }

      section { margin-bottom: 6mm; }
      h3 { font-size: 11pt; color: #111827; margin: 0 0 2mm 0; border-bottom: 1px solid #d1d5db; padding-bottom: 1mm; }
    </style>
  `;
}
