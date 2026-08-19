/**
 * Integration tests for the SST-sibling fold in `listCharges` — the endpoint behind
 * BOTH the portal Charges page and Billing → Invoices tab.
 *
 * Skipped by default — only run against a LOCAL postgres instance:
 *   RUN_INTEGRATION=1 npm test -w @kason/api -- charges-list-sst-fold
 *
 * The pay screen was folded first, which left the two lists disagreeing with it: the
 * same expense read RM 0.54 on the pay screen and RM 0.50 + RM 0.04 here.
 *
 * The wrinkle this endpoint has and the pay screen does not: it carries per-charge
 * CN/DN columns. `createChargeAdjustmentService` mirrors every note onto the `-SST`
 * sibling, so the sibling holds its own share of the credit. Fold the pair without
 * merging those and the Total column understates the credit note while Balance shows
 * the merged figure — the row stops satisfying `adjusted = amount + DN − CN`.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listCharges } from "../portal.charges.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing non-local DB host: ${host}`);
  }
}

// Stable UUIDs for this suite (cl = charges-list), distinct from every other org.
const ORG = "c1f00000-0000-4000-8000-000000000001";
const PARTY = "c1f00000-0000-4000-8000-000000000002";
const USER_ID = "c1f00000-0000-4000-8000-000000000003";
const SERIES = "c1f00000-0000-4000-8000-000000000004";
const IV = "c1f00000-0000-4000-8000-000000000005";
const CN = "c1f00000-0000-4000-8000-000000000006";

const C_BASE = "c1f00000-0000-4000-8000-000000000010";
const C_SST = "c1f00000-0000-4000-8000-000000000011";
const C_RENT = "c1f00000-0000-4000-8000-000000000012";

const session = { partyId: PARTY, orgId: ORG };

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * UAT IVTEN-0002 line 7, verbatim. Base RM 1.00 @ 8% → sibling RM 0.08. A credit note
 * of RM 0.50 on the base, mirrored as RM 0.04 onto the sibling, leaves:
 *   base   adjusted 0.50, outstanding 0.50
 *   sibling adjusted 0.04, outstanding 0.04
 * so the FOLDED row must read amount 1.08, credit 0.54, adjusted 0.54, balance 0.54.
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "CL-Org", slug: "cl-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER_ID, organizationId: ORG, email: "cl@example.test",
      fullName: "CL Operator", status: "active", role: "manager", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, partyType: "individual", displayName: "TEST1", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "IVTEN", prefix: "IVTEN", padding: 4 },
  });

  const chargeBase = {
    organizationId: ORG, partyId: PARTY, currency: "MYR", status: "posted",
    postedAt: new Date("2026-08-01"), dueDate: new Date("2026-08-01"),
  };
  await db.charge.createMany({
    data: [
      { id: C_RENT, ...chargeBase, chargeNumber: "TR-202608-cl", chargeType: "rent", description: "Monthly rent", amount: 1.94, outstandingAmount: 1.94 },
      { id: C_BASE, ...chargeBase, chargeNumber: "GRIDEXP-202608-cl", chargeType: "expense", description: "test ten exp sst", amount: 1, outstandingAmount: 0.5 },
      { id: C_SST, ...chargeBase, chargeNumber: "GRIDEXP-202608-cl-SST", chargeType: "expense", description: "test ten exp sst — SST 8%", amount: 0.08, outstandingAmount: 0.04, parentChargeId: C_BASE },
    ],
  });

  await db.billingDocument.create({
    data: {
      id: IV, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-0002",
      seriesId: SERIES, issuedById: USER_ID, counterpartyType: "tenant", partyId: PARTY,
      issuedAt: new Date("2026-08-17"), subtotal: 2.94, sstAmount: 0.08, total: 3.02,
    },
  });
  await db.billingDocumentLine.createMany({
    data: [
      { documentId: IV, chargeId: C_RENT, description: "Monthly rent", amount: 1.94, isTax: false },
      { documentId: IV, chargeId: C_BASE, description: "test ten exp sst", amount: 1, sstRate: 8, sstAmount: 0.08, isTax: false },
      { documentId: IV, chargeId: C_SST, description: "test ten exp sst — SST 8%", amount: 0.08, isTax: true },
    ],
  });

  // The credit note, mirrored onto the sibling exactly as charge-adjustment.service
  // writes it: a line against the base AND a line against its `-SST` sibling.
  await db.billingDocument.create({
    data: {
      id: CN, organizationId: ORG, docType: "credit_note", documentNumber: "CN-0003",
      seriesId: SERIES, issuedById: USER_ID, counterpartyType: "tenant", partyId: PARTY,
      issuedAt: new Date("2026-08-17"), originalDocumentId: IV,
      subtotal: 0.5, sstAmount: 0.04, total: 0.54,
    },
  });
  await db.billingDocumentLine.createMany({
    data: [
      { documentId: CN, chargeId: C_BASE, description: "Credit — test ten exp sst", amount: 0.5, isTax: false },
      { documentId: CN, chargeId: C_SST, description: "Credit — SST 8%", amount: 0.04, isTax: true },
    ],
  });
}

dn("listCharges — SST sibling fold", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterEach(async () => {
    await cleanup();
  });

  it("shows ONE row for the SST-bearing expense, agreeing with the pay screen", async () => {
    const result = await listCharges(session, 1, 20);
    const numbers = result.data.map((r) => r.chargeNumber);

    expect(numbers).toContain("GRIDEXP-202608-cl");
    // THE DEFECT: the Charges page and Invoices tab still listed this separately
    // after the pay screen had been folded.
    expect(numbers).not.toContain("GRIDEXP-202608-cl-SST");
    expect(result.data).toHaveLength(2); // rent + the folded expense
    expect(result.pagination.total).toBe(2);
  });

  it("merges the sibling's share of the CREDIT NOTE, so the row still foots", async () => {
    const result = await listCharges(session, 1, 20);
    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-cl")!;

    expect(row.amount).toBe(1.08);
    expect(row.creditNoteTotal).toBe(0.54);
    expect(row.debitNoteTotal).toBe(0);
    expect(row.adjustedAmount).toBe(0.54);
    expect(row.outstandingAmount).toBe(0.54);
    // The invariant a reader checks by hand — and the one that breaks if the
    // sibling's mirrored 0.04 of credit is dropped on the floor.
    expect(row.adjustedAmount).toBeCloseTo(row.amount + row.debitNoteTotal - row.creditNoteTotal, 10);
  });

  it("shows the bill number, not the internal chargeNumber", async () => {
    const result = await listCharges(session, 1, 20);
    const row = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-cl")!;
    // The CN is deliberately NOT the reference — pointing a tenant at the document
    // that REDUCED their charge is worse than showing nothing.
    expect(row.documentNumber).toBe("IVTEN-0002");
  });

  it("leaves an unrelated charge untouched", async () => {
    const result = await listCharges(session, 1, 20);
    const rent = result.data.find((r) => r.chargeNumber === "TR-202608-cl")!;

    expect(rent.amount).toBe(1.94);
    expect(rent.creditNoteTotal).toBe(0);
    expect(rent.adjustedAmount).toBe(1.94);
    expect(rent.outstandingAmount).toBe(1.94);
  });

  it("never splits the pair across a page boundary", async () => {
    const p1 = await listCharges(session, 1, 1);
    const p2 = await listCharges(session, 2, 1);

    const all = [...p1.data, ...p2.data].map((r) => r.chargeNumber);
    expect(all).not.toContain("GRIDEXP-202608-cl-SST");
    expect(all.sort()).toEqual(["GRIDEXP-202608-cl", "TR-202608-cl"]);
    expect(p1.pagination.totalPages).toBe(2);
  });

  it("keeps an ORPHAN tax charge visible when its base is not tenant-visible", async () => {
    const db = getDb();
    // Drop the base out of the visible set entirely; its tax sibling still owes.
    await db.charge.update({ where: { id: C_BASE }, data: { status: "draft" } });

    const result = await listCharges(session, 1, 20);
    const numbers = result.data.map((r) => r.chargeNumber);

    expect(numbers).not.toContain("GRIDEXP-202608-cl"); // draft: not tenant-visible
    // Hiding this would hide RM 0.04 the tenant still owes.
    expect(numbers).toContain("GRIDEXP-202608-cl-SST");
    const orphan = result.data.find((r) => r.chargeNumber === "GRIDEXP-202608-cl-SST")!;
    expect(orphan.outstandingAmount).toBe(0.04);
  });
});
