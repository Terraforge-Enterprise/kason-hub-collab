// E2E fixture seed for the Owner-Billing (M6) Puppeteer suite.
// Run:  npx tsx scripts/seed-e2e-owner-billing.ts   (from the repo root)
//
// Creates a deterministic owner-statement fixture in the SAME org the e2e logins
// use (resolved via admin@kaenproperties.com). It builds REAL owner_statement
// Invoices for TWO different owners so the suite can prove the cross-owner 404
// contract WITHOUT generating anything through the admin path (the generate path
// needs collected rent + an active fee config; this seed sidesteps that and just
// plants finished statements the UI reads).
//
//   Owner A = razak@gmail.com           (portal session.partyId = Razak's party)
//     ├─ DRAFT  statement E2E-OB-DRAFT-<ym>  — for the ADMIN flow (open detail,
//     │    Add cleaning, Add line, regenerate/download). Lines: management_fee
//     │    (+SST) + tnb. No pdfKey (admin regenerates it).
//     └─ SENT   statement E2E-OB-SENT-<ym>   — for the PORTAL detail flow. Lines:
//          management_fee (+SST) + water + wifi. Has a pdfKey so the portal
//          "Download PDF" is enabled and the detail Sheet renders net remittance.
//
//   Owner B = meiling.tan@hotmail.com   (a DIFFERENT owner party)
//     └─ SENT   statement E2E-OB-OTHER-<ym> — Owner A must get 404 fetching this
//          id via the owner portal (GET /portal-api/statements/:id). The suite
//          reads its id from this seed's stdout (printed as OTHER_STATEMENT_ID=).
//
// IDEMPOTENT + ADDITIVE: every Invoice is upserted on (organizationId,
// invoiceNumber); its Charges are upserted on (organizationId, chargeNumber).
// Re-runs never duplicate and NEVER delete or modify anything this script did not
// create.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const rawUrl = process.env.DATABASE_URL ?? "";
// Airtight localhost guard: parse the URL and check the actual hostname.
let dbHost = "";
try {
  dbHost = new URL(rawUrl).hostname;
} catch {
  // unparseable URL → empty hostname fails the check below
}
if (dbHost !== "localhost" && dbHost !== "127.0.0.1") {
  console.error(
    "REFUSING TO RUN: DATABASE_URL host is not local postgres:",
    rawUrl.replace(/:[^:@/]*@/, ":****@"),
  );
  process.exit(1);
}

const adapter = new PrismaPg({
  connectionString: rawUrl.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, ""),
  ssl: false,
});
const prisma = new PrismaClient({ adapter });

// Deterministic billing period for every fixture statement: a fixed past month so
// re-runs (and a fresh seed) always target the same period.
const YM = "2026-05"; // YYYY-MM
const FIRST_OF_MONTH = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01 UTC

interface LineDef {
  chargeType: string;
  description: string;
  amount: string; // 2dp money string
}

/** Money string → 2dp number. */
function n(v: string): number {
  return Number(v);
}

/**
 * Upsert one owner_statement Invoice + its non-void line Charges. The Invoice
 * total is Σ(line amounts) + sstAmount; sstAmount is supplied (the fee SST). All
 * keys are deterministic so re-runs are pure upserts. Returns the Invoice id.
 */
async function upsertStatement(opts: {
  orgId: string;
  ownerPartyId: string;
  invoiceNumber: string;
  status: string;
  sstAmount: string;
  pdfKey: string | null;
  lines: LineDef[];
}): Promise<string> {
  const { orgId, ownerPartyId, invoiceNumber, status, sstAmount, pdfKey, lines } = opts;
  const lineTotal = lines.reduce((sum, l) => sum + n(l.amount), 0);
  const totalAmount = (lineTotal + n(sstAmount)).toFixed(2);

  const invoice = await prisma.invoice.upsert({
    where: { organizationId_invoiceNumber: { organizationId: orgId, invoiceNumber } },
    update: {
      status,
      totalAmount,
      sstAmount,
      pdfKey,
    },
    create: {
      organizationId: orgId,
      invoiceNumber,
      // Invoice.partyId is required (bill-to). For an owner statement the bill-to
      // party IS the owner.
      partyId: ownerPartyId,
      ownerPartyId,
      invoiceType: "owner_statement",
      status,
      invoiceDate: FIRST_OF_MONTH,
      periodMonth: FIRST_OF_MONTH,
      totalAmount,
      sstAmount,
      currency: "MYR",
      pdfKey,
    },
    select: { id: true },
  });

  // Upsert each line Charge on (organizationId, chargeNumber). chargeNumber is
  // deterministic: "<invoiceNumber>-L<idx>".
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const chargeNumber = `${invoiceNumber}-L${i + 1}`;
    await prisma.charge.upsert({
      where: { organizationId_chargeNumber: { organizationId: orgId, chargeNumber } },
      update: {
        amount: line.amount,
        outstandingAmount: line.amount,
        description: line.description,
        chargeType: line.chargeType,
        status: "draft",
        invoiceId: invoice.id,
      },
      create: {
        organizationId: orgId,
        chargeNumber,
        partyId: ownerPartyId,
        chargeType: line.chargeType,
        status: "draft",
        description: line.description,
        dueDate: FIRST_OF_MONTH,
        amount: line.amount,
        currency: "MYR",
        outstandingAmount: line.amount,
        billingMonth: FIRST_OF_MONTH,
        invoiceId: invoice.id,
      },
    });
  }

  return invoice.id;
}

async function ownerPartyIdFor(email: string): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { email, userType: "owner" },
    select: { partyId: true },
  });
  if (!user?.partyId) {
    console.error(`Owner portal user ${email} (userType=owner) not found or has no partyId — run the main seed first (packages/db/prisma/seed.ts).`);
    process.exit(1);
  }
  return user.partyId;
}

async function main() {
  const admin = await prisma.user.findFirst({
    where: { email: "admin@kaenproperties.com" },
    select: { organizationId: true },
  });
  if (!admin) {
    console.error("admin@kaenproperties.com not found — run the main seed first (packages/db/prisma/seed.ts).");
    process.exit(1);
  }
  const orgId = admin.organizationId;
  console.log(`Org: ${orgId}`);

  // Resolve the two owner parties the same way the portal session does
  // (User.partyId for userType=owner) so the seeded statements line up exactly
  // with each owner's portal scope.
  const ownerA = await ownerPartyIdFor("razak@gmail.com");
  const ownerB = await ownerPartyIdFor("meiling.tan@hotmail.com");
  console.log(`Owner A (razak): ${ownerA}`);
  console.log(`Owner B (meiling): ${ownerB}`);

  // ── Owner A — DRAFT statement for the ADMIN flow ──────────────────────────
  const draftId = await upsertStatement({
    orgId,
    ownerPartyId: ownerA,
    invoiceNumber: `E2E-OB-DRAFT-${YM}`,
    status: "draft",
    sstAmount: "10.80", // 10.8% SST on a RM 100 management fee
    pdfKey: null, // admin regenerates the PDF in the flow
    lines: [
      { chargeType: "management_fee", description: "Management fee (May)", amount: "100.00" },
      { chargeType: "tnb", description: "TNB electricity (May)", amount: "180.00" },
    ],
  });
  console.log(`Owner A DRAFT statement: ${draftId}`);

  // ── Owner A — SENT statement for the PORTAL detail flow ───────────────────
  const sentId = await upsertStatement({
    orgId,
    ownerPartyId: ownerA,
    invoiceNumber: `E2E-OB-SENT-${YM}`,
    status: "sent",
    sstAmount: "10.80",
    // A pdfKey so the portal "Download PDF" is ENABLED (DOWNLOADABLE_STATUSES has
    // "sent"). The key need not resolve to a real object for the suite — the
    // suite asserts the button is enabled + clickable, not the signed bytes.
    pdfKey: `owner-statements/${ownerA}/${YM.replace("-", "")}-e2e.pdf`,
    lines: [
      { chargeType: "management_fee", description: "Management fee (May)", amount: "100.00" },
      { chargeType: "water", description: "Water (May)", amount: "45.00" },
      { chargeType: "wifi", description: "WiFi (May)", amount: "89.00" },
    ],
  });
  console.log(`Owner A SENT statement: ${sentId}`);

  // ── Owner B — SENT statement for the CROSS-OWNER 404 contract ─────────────
  const otherId = await upsertStatement({
    orgId,
    ownerPartyId: ownerB,
    invoiceNumber: `E2E-OB-OTHER-${YM}`,
    status: "sent",
    sstAmount: "21.60",
    pdfKey: `owner-statements/${ownerB}/${YM.replace("-", "")}-e2e.pdf`,
    lines: [
      { chargeType: "management_fee", description: "Management fee (May)", amount: "200.00" },
      { chargeType: "insurance", description: "Insurance (May)", amount: "60.00" },
    ],
  });
  console.log(`Owner B SENT statement: ${otherId}`);

  // The suite reads these from stdout — Owner A logs into the portal, opens
  // SENT_STATEMENT_ID's detail, and asserts OTHER_STATEMENT_ID 404s (not his).
  console.log(`SENT_STATEMENT_ID=${sentId}`);
  console.log(`DRAFT_STATEMENT_ID=${draftId}`);
  console.log(`OTHER_STATEMENT_ID=${otherId}`);
  console.log("E2E owner-billing fixture ready.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
