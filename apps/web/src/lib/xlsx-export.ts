import ExcelJS from "exceljs";

// Must match the on-disk template at apps/web/public/templates/
// The template's layout is load-bearing: changing cell addresses here without
// updating the xlsx file (or vice versa) will silently produce broken exports.
const TEMPLATE_URL = "/templates/commission-claim-template.xlsx";
const SHEET_NAME = "New Template";

// Template layout — see docs/templates/commission-claim-template.xlsx
//   A8:N8  (merged)     title banner
//   E13                 Submission Date
//   E14                 Agent Name
//   N13                 Bank Account Owner Name
//   N14                 Bank Name
//   N15                 Bank Account Number
//   Row 18              Column headers (already in template)
//   Row 19+             Data rows
//
// Row layout (14 cols, A..N):
//   A No.  B Condo  C Unit No.  D Room  E Tenant name
//   F Sales Date  G Move in Date  H Monthly Rental
//   I TenancyChargesByAgent  J TenancyChargesByKAEN  K Pax
//   L AgentTier(%)  M Commission(%)  N Nett Payout (formula)
export type ClaimExportItem = {
  condoName: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  salesDate: string;           // ISO
  moveInDate: string;          // ISO
  monthlyRental: number;
  tenancyChargesByAgent: number;
  tenancyChargesByKaen: number;
  numberOfPax: number | null;
  agentTierPercentage: number | null;
  commissionPercentage: number;
  nettPayout: number;
};

export type ClaimExportHeader = {
  claimNumber: string;
  submittedAt: string | null;  // ISO
  agentName: string;
  bankAccountHolder: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  items: ClaimExportItem[];
};

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function exportClaimAsKaenTemplate(claim: ClaimExportHeader): Promise<void> {
  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error(`Failed to load template: ${res.status}`);
  const buf = await res.arrayBuffer();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets[0];
  if (!ws) throw new Error("Template worksheet missing");

  // Header block
  ws.getCell("E13").value = toDate(claim.submittedAt);
  ws.getCell("E14").value = claim.agentName;
  ws.getCell("N13").value = claim.bankAccountHolder ?? "";
  ws.getCell("N14").value = claim.bankName ?? "";
  ws.getCell("N15").value = claim.bankAccountNumber ?? "";

  // Data rows — start at row 19
  claim.items.forEach((it, i) => {
    const r = 19 + i;
    ws.getCell(`A${r}`).value = i + 1;
    ws.getCell(`B${r}`).value = it.condoName;
    ws.getCell(`C${r}`).value = it.unitCode;
    ws.getCell(`D${r}`).value = it.roomType;
    ws.getCell(`E${r}`).value = it.tenantName;
    ws.getCell(`F${r}`).value = toDate(it.salesDate);
    ws.getCell(`G${r}`).value = toDate(it.moveInDate);
    ws.getCell(`H${r}`).value = it.monthlyRental;
    ws.getCell(`I${r}`).value = it.tenancyChargesByAgent;
    ws.getCell(`J${r}`).value = it.tenancyChargesByKaen;
    ws.getCell(`K${r}`).value = it.numberOfPax;
    ws.getCell(`L${r}`).value = it.agentTierPercentage;
    ws.getCell(`M${r}`).value = it.commissionPercentage;
    // Keep the canonical KAEN formula per row so auditors see the same thing
    // they'd see in the paper template. Store the backend's computed value as
    // the cached result — Excel will re-evaluate if the user edits inputs.
    ws.getCell(`N${r}`).value = {
      formula: `(H${r}-(K${r}*50))*((L${r}*M${r}/100)/100)+((I${r}-J${r}))`,
      result: it.nettPayout,
    };
  });

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${claim.claimNumber}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
