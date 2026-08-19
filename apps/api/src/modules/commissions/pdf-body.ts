// Builds the body HTML (no <html>/<head>/<body> wrapper) consumed by
// renderToHtml() in apps/api/src/lib/document-templates/render.ts. Mirrors
// the typography conventions used by the reservation form: uppercase
// section headings, thin dividers, tabular-nums for amounts, per-row
// page-break-inside:avoid.

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRM(n: number): string {
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateISO(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function pct(v: number | null): string {
  return v == null ? "-" : `${v}%`;
}

function dash(s: string | null | undefined): string {
  return s && s.length > 0 ? s : "-";
}

function num(v: number | null): string {
  return v == null ? "-" : String(v);
}

type ClaimItem = {
  condoName: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  salesDate: string;
  moveInDate: string;
  moveOutDate: string | null;
  monthlyRental: number;
  tenancyChargesByAgent: number;
  tenancyChargesByKaen: number;
  numberOfPax: number | null;
  agentTierPercentage: number | null;
  commissionPercentage: number;
  nettPayout: number;
};

export type CommissionClaimPdfData = {
  claimNumber: string;
  submittedAt: string | null;
  approvedAt: string | null;
  agentName: string;
  bankAccountHolder: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  totalNettPayout: number;
  items: ClaimItem[];
};

export function buildCommissionClaimBodyHtml(data: CommissionClaimPdfData): string {
  const itemsRows = data.items
    .map(
      (it, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(dash(it.condoName))}</td>
          <td>${esc(dash(it.unitCode))}</td>
          <td>${esc(dash(it.roomType))}</td>
          <td>${esc(dash(it.tenantName))}</td>
          <td>${formatDateISO(it.salesDate)}</td>
          <td>${formatDateISO(it.moveInDate)}</td>
          <td class="num">${formatRM(it.monthlyRental)}</td>
          <td class="num">${formatRM(it.tenancyChargesByAgent)}</td>
          <td class="num">${formatRM(it.tenancyChargesByKaen)}</td>
          <td class="num">${num(it.numberOfPax)}</td>
          <td class="num">${pct(it.agentTierPercentage)}</td>
          <td class="num">${pct(it.commissionPercentage)}</td>
          <td class="num">${formatRM(it.nettPayout)}</td>
        </tr>`,
    )
    .join("");

  return `
    <section>
      <h3>Agent Information</h3>
      <table class="info-grid">
        <tbody>
          <tr>
            <td class="label">Agent Name</td>
            <td class="value">${esc(dash(data.agentName))}</td>
            <td class="label">Bank Name</td>
            <td class="value">${esc(dash(data.bankName))}</td>
          </tr>
          <tr>
            <td class="label">Submission Date</td>
            <td class="value">${formatDateISO(data.submittedAt)}</td>
            <td class="label">Account Holder</td>
            <td class="value">${esc(dash(data.bankAccountHolder))}</td>
          </tr>
          <tr>
            <td class="label">Approval Date</td>
            <td class="value">${formatDateISO(data.approvedAt)}</td>
            <td class="label">Account Number</td>
            <td class="value">${esc(dash(data.bankAccountNumber))}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3>Line Items</h3>
      <table class="items">
        <thead>
          <tr>
            <th>No.</th>
            <th>Condo</th>
            <th>Unit</th>
            <th>Room</th>
            <th>Tenant</th>
            <th>Sales Date</th>
            <th>Move-in</th>
            <th class="num">Rental (RM)</th>
            <th class="num">Agent Charges (RM)</th>
            <th class="num">KAEN Charges (RM)</th>
            <th class="num">Pax</th>
            <th class="num">Agent Tier %</th>
            <th class="num">Commission %</th>
            <th class="num">Nett Payout (RM)</th>
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
        <tfoot>
          <tr class="totals">
            <td colspan="13" class="totals-label">Total Nett Payout</td>
            <td class="num totals-value">${formatRM(data.totalNettPayout)}</td>
          </tr>
        </tfoot>
      </table>
    </section>

    <style>
      /* Landscape A4 — the 14-column Line Items table doesn't fit in portrait
         even at small font sizes. Letterhead and Agent Information also
         render in landscape (single source of truth for orientation).
         Overrides render.ts's @page rule because puppeteer is configured
         with preferCSSPageSize:true. */
      @page { size: A4 landscape; margin: 14mm 14mm 18mm 14mm }

      .info-grid { width: 100%; border-collapse: collapse; margin-top: 1mm; }
      .info-grid td { padding: 1.2mm 0; font-size: 10pt; vertical-align: top; }
      .info-grid td.label { width: 16%; color: #4b5563; font-weight: 600; }
      .info-grid td.value { width: 34%; color: #111827; }

      .items { width: 100%; border-collapse: collapse; margin-top: 2mm; table-layout: auto; }
      .items th, .items td {
        padding: 1.2mm 1.5mm; font-size: 8pt; border-bottom: 1px solid #e5e7eb;
        text-align: left; vertical-align: top;
      }
      .items th {
        background: #f9fafb; color: #4b5563; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.2pt; font-size: 7pt;
        white-space: normal;
      }
      .items td.num, .items th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .items tbody tr { page-break-inside: avoid; }
      .items tfoot .totals td { border-top: 1.5px solid #111827; font-weight: 700; }
      .items tfoot .totals .totals-label { text-align: right; text-transform: uppercase; letter-spacing: 0.4pt; }
      .items tfoot .totals .totals-value { color: #c9a44b; }
    </style>
  `;
}
