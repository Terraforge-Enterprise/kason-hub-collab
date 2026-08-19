/**
 * Integration tests for the SST-sibling fold in `listPayableCharges`.
 *
 * Skipped by default — only run against a LOCAL postgres instance:
 *   RUN_INTEGRATION=1 npm test -w @kason/api -- payable-charges-sst-fold
 *
 * ─── The defect ──────────────────────────────────────────────────────────────
 *
 * Reproduces UAT IVTEN-0002 verbatim. An SST-bearing grid expense is TWO Charges
 * (base RM 0.50 + a sibling whose amount IS the RM 0.04 tax), and both are payable,
 * so the tenant's pay screen listed them as two separate overdue bills:
 *
 *     test ten exp sst                    RM 0.50   OVERDUE
 *     test ten exp sst — SST 8%           RM 0.04   OVERDUE
 *
 * while the invoice they had just been sent showed ONE line of RM 0.54. The two
 * were also independently tickable, so a tenant who read the second row as a
 * duplicate could pay RM 0.50 and leave the document four sen short of settled.
 *
 * The pure fold is unit-tested in @kason/shared (fold-payable-tax-siblings.test.ts).
 * What is verified HERE is the part only a database can answer: that `isTax` is
 * sourced from the document line rather than guessed, that a generic
 * `parentChargeId` (correction lineage) is NOT mistaken for a tax sibling, that
 * pagination counts display rows, and that an orphan tax charge stays visible.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listPayableCharges } from "../portal.payments.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing non-local DB host: ${host}`);
  }
}

// Stable UUIDs for this suite (sf = sst-fold), distinct from every other org so
// serial integration teardown can never collide.
const ORG = "5f000000-0000-4000-8000-000000000001";
const PARTY = "5f000000-0000-4000-8000-000000000002";
const USER_ID = "5f000000-0000-4000-8000-000000000003";
const SERIES = "5f000000-0000-4000-8000-000000000004";
const DOC = "5f000000-0000-4000-8000-000000000005";

const C_RENT = "5f000000-0000-4000-8000-000000000010";
const C_EXP_BASE = "5f000000-0000-4000-8000-000000000011";
const C_EXP_SST = "5f000000-0000-4000-8000-000000000012";
const C_ORPHAN_SST = "5f000000-0000-4000-8000-000000000013";
const C_PAID_BASE = "5f000000-0000-4000-8000-000000000014";
const C_ORIGINAL = "5f000000-0000-4000-8000-000000000015";
const C_REPLACEMENT = "5f000000-0000-4000-8000-000000000016";

const session = { partyId: PARTY, orgId: ORG };

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { documentId: DOC } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "SF-Org", slug: "sf-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER_ID, organizationId: ORG, email: "sf@example.test",
      fullName: "SF Operator", status: "active", role: "manager", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, partyType: "individual", displayName: "TEST1", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4 },
  });

  const chargeBase = {
    organizationId: ORG,
    partyId: PARTY,
    currency: "MYR",
    status: "posted",
    dueDate: new Date("2026-08-01"),
  };

  await db.charge.createMany({
    data: [
      { id: C_RENT, ...chargeBase, chargeNumber: "TR-202608-sf", chargeType: "rent", description: "Monthly rent", amount: 1.94, outstandingAmount: 1.94 },
      // The reported pair: base + its SST sibling, exactly as mintExpenseChargesTx
      // writes them (sibling carries parentChargeId → base, sstRate "0").
      { id: C_EXP_BASE, ...chargeBase, chargeNumber: "GRIDEXP-202608-sf", chargeType: "expense", description: "test ten exp sst", amount: 0.5, outstandingAmount: 0.5 },
      { id: C_EXP_SST, ...chargeBase, chargeNumber: "GRIDEXP-202608-sf-SST", chargeType: "expense", description: "test ten exp sst — SST 8%", amount: 0.04, outstandingAmount: 0.04, parentChargeId: C_EXP_BASE },
      // ORPHAN tax charge: its base is fully PAID, so absent from the payable set.
      // Must stay visible — see SAFETY in fold-payable-tax-siblings.ts. This is a
      // real production shape: the base was settled by an earlier payment that
      // never covered the tax.
      { id: C_PAID_BASE, ...chargeBase, status: "paid", chargeNumber: "GRIDEXP-202608-orphan", chargeType: "expense", description: "Billed elsewhere", amount: 1, outstandingAmount: 0 },
      { id: C_ORPHAN_SST, ...chargeBase, chargeNumber: "GRIDEXP-202608-orphan-SST", chargeType: "expense", description: "Billed elsewhere — SST 8%", amount: 0.08, outstandingAmount: 0.08, parentChargeId: C_PAID_BASE },
      // NOT a tax sibling: correction lineage. `correction-replace.service.ts`
      // points an RPL- charge at the charge it supersedes via the SAME
      // parentChargeId column, and folding on that link alone would merge a
      // replacement into the charge it replaced.
      { id: C_ORIGINAL, ...chargeBase, chargeNumber: "CHG-sf-orig", chargeType: "rental", description: "Original", amount: 2, outstandingAmount: 2 },
      { id: C_REPLACEMENT, ...chargeBase, chargeNumber: "RPL-sf-0001", chargeType: "rental", description: "Replacement for typo", amount: 3, outstandingAmount: 3, parentChargeId: C_ORIGINAL },
    ],
  });

  // The document that makes C_EXP_SST and C_ORPHAN_SST TAX charges. Only an
  // `isTax` line does — nothing infers it from the chargeNumber.
  await db.billingDocument.create({
    data: {
      id: DOC, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-0002",
      seriesId: SERIES, issuedById: USER_ID, counterpartyType: "tenant", partyId: PARTY,
      subtotal: 2.44, sstAmount: 0.04, total: 2.48,
    },
  });
  await db.billingDocumentLine.createMany({
    data: [
      { documentId: DOC, chargeId: C_EXP_BASE, description: "test ten exp sst", amount: 0.5, sstRate: 8, sstAmount: 0.04, isTax: false },
      { documentId: DOC, chargeId: C_EXP_SST, description: "test ten exp sst — SST 8%", amount: 0.04, isTax: true },
      { documentId: DOC, chargeId: C_PAID_BASE, description: "Billed elsewhere", amount: 1, sstRate: 8, sstAmount: 0.08, isTax: false },
      { documentId: DOC, chargeId: C_ORPHAN_SST, description: "Billed elsewhere — SST 8%", amount: 0.08, isTax: true },
      { documentId: DOC, chargeId: C_RENT, description: "Monthly rent", amount: 1.94, isTax: false },
      { documentId: DOC, chargeId: C_ORIGINAL, description: "Original", amount: 2, isTax: false },
      { documentId: DOC, chargeId: C_REPLACEMENT, description: "Replacement for typo", amount: 3, isTax: false },
    ],
  });
}

dn("listPayableCharges — SST sibling fold", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("shows ONE row of RM 0.54 for the SST-bearing expense, not two bills", async () => {
    const result = await listPayableCharges(session, 1, 50);

    const numbers = result.data.map((r) => r.chargeNumber);
    expect(numbers).toContain("GRIDEXP-202608-sf");
    // THE DEFECT: this row used to appear on the tenant's pay screen.
    expect(numbers).not.toContain("GRIDEXP-202608-sf-SST");

    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-sf")!;
    expect(row.outstandingAmount).toBe(0.54);
    expect(row.amount).toBe(0.54);
    expect(row.description).toBe("test ten exp sst");
  });

  it("carries both charge ids as components so the payment still allocates to each", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-sf")!;

    expect(row.components).toEqual([
      { chargeId: C_EXP_BASE, outstandingAmount: 0.5 },
      { chargeId: C_EXP_SST, outstandingAmount: 0.04 },
    ]);
  });

  it("does NOT change the total the tenant owes — only the row count", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const cents = result.data.reduce((c, r) => c + Math.round(r.outstandingAmount * 100), 0);
    // 1.94 rent + 0.54 folded expense + 0.08 orphan SST + 2.00 original + 3.00 replacement
    expect(cents).toBe(756);
  });

  it("keeps an ORPHAN tax charge visible as its own row", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const orphan = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-orphan-SST");

    // Its base is paid and therefore not payable, so there is no row to fold into.
    // Hiding it would hide RM 0.08 the tenant still owes — a charge they cannot see
    // is one they never pay.
    expect(orphan).toBeDefined();
    expect(orphan!.outstandingAmount).toBe(0.08);
    expect(orphan!.components).toEqual([{ chargeId: C_ORPHAN_SST, outstandingAmount: 0.08 }]);
  });

  it("does NOT fold a correction REPLACEMENT charge into the charge it supersedes", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const numbers = result.data.map((r) => r.chargeNumber);

    // Both must remain their own payable rows: parentChargeId is a generic
    // lineage link, and only an `isTax` document line marks a tax sibling.
    expect(numbers).toContain("CHG-sf-orig");
    expect(numbers).toContain("RPL-sf-0001");
    const original = result.data.find((r) => r.chargeNumber === "CHG-sf-orig")!;
    expect(original.outstandingAmount).toBe(2);
    expect(original.components).toEqual([{ chargeId: C_ORIGINAL, outstandingAmount: 2 }]);
  });

  it("counts DISPLAY rows in pagination, not raw charges", async () => {
    const result = await listPayableCharges(session, 1, 50);

    // 7 charges exist, 6 payable (the orphan's base is paid); one of those 6 is a
    // foldable SST sibling, so 5 display rows.
    expect(await getDb().charge.count({ where: { organizationId: ORG, partyId: PARTY } })).toBe(7);
    expect(result.data).toHaveLength(5);
    expect(result.pagination.total).toBe(5);
    expect(result.pagination.totalPages).toBe(1);
  });

  it("never splits a folded pair across a page boundary", async () => {
    // The base sorts into page 1 and its sibling would have sorted into page 2 —
    // the case that would have shown a bare '— SST 8%' row on its own page.
    const page1 = await listPayableCharges(session, 1, 2);
    const page2 = await listPayableCharges(session, 2, 2);
    const page3 = await listPayableCharges(session, 3, 2);

    const all = [...page1.data, ...page2.data, ...page3.data];
    expect(all.map((r) => r.chargeNumber)).not.toContain("GRIDEXP-202608-sf-SST");
    // Every payable charge is settled by exactly one display row across all pages.
    const settled = all.flatMap((r) => r.components.map((k) => k.chargeId));
    expect(new Set(settled).size).toBe(settled.length);
    expect(settled).toHaveLength(6);
    expect(settled).toContain(C_EXP_SST);
  });

  // ─── tenant-facing reference ───────────────────────────────────────────────

  it("returns the BILL number, never the internal chargeNumber", async () => {
    const result = await listPayableCharges(session, 1, 50);
    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-sf")!;

    // THE LEAK: the pay screen rendered `invoiceNumber ?? chargeNumber`, and grid
    // mints never set Charge.invoiceId, so tenants saw the internal id.
    expect(row.invoiceNumber).toBeNull();
    expect(row.documentNumber).toBe("IVTEN-0002");
  });

  it("leaves documentNumber null for a charge on no bill, rather than inventing one", async () => {
    const db = getDb();
    const docLess = "5f000000-0000-4000-8000-000000000020";
    await db.charge.create({
      data: {
        id: docLess, organizationId: ORG, partyId: PARTY, currency: "MYR", status: "posted",
        dueDate: new Date("2026-08-01"), chargeNumber: "GRIDEXP-202608-docless",
        chargeType: "expense", description: "Not yet billed", amount: 0.3, outstandingAmount: 0.3,
      },
    });

    const result = await listPayableCharges(session, 1, 50);
    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-docless")!;
    expect(row.documentNumber).toBeNull();
  });

  it("marks the folded row pending when only the SST half carries a claim", async () => {
    const db = getDb();
    const payment = await db.payment.create({
      data: {
        organizationId: ORG, partyId: PARTY, paymentNumber: "PMT-sf-0001",
        paymentType: "incoming", paymentMethod: "bank_transfer",
        // Exactly BLOCKS_FURTHER_PAYMENT_WHERE's first arm: a manual slip awaiting
        // a human, no gateway involved.
        status: "pending_approval", gatewayStatus: null,
        amount: 0.04, currency: "MYR", receivedAt: new Date("2026-08-10"),
      },
      select: { id: true },
    });
    await db.paymentAllocation.create({
      data: {
        organizationId: ORG, paymentId: payment.id, chargeId: C_EXP_SST,
        allocatedAmount: 0.04, allocatedAt: new Date("2026-08-10"),
      },
    });

    const result = await listPayableCharges(session, 1, 50);
    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-sf")!;
    // Without OR-ing across components the merged row would render freely payable
    // and the tenant would be invited to pay the 0.04 twice — which the validator
    // then refuses for the WHOLE basket (CHARGE_PENDING_VERIFICATION).
    expect(row.pendingVerification).toBe(true);

    await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
    await db.payment.deleteMany({ where: { organizationId: ORG } });
  });
});
