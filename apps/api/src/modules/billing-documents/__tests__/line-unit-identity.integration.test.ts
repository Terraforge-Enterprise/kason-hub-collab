/**
 * Per-line unit identity on billing documents — real LOCAL Postgres
 * (opt-in RUN_INTEGRATION=1).
 *
 * Why: a COMBINED owner statement (apartmentId NULL) mints one IVOWN document
 * carrying one management-fee line per unit. Those lines all read
 * "Management fee" and the document-level unitCode is null, so the reader
 * cannot tell which line belongs to which unit. The unit IS reachable —
 * line.chargeId → Charge.unitId → Unit.apartment.unitCode — it just never
 * reached the DTO.
 *
 * Proves: every charge-backed line exposes `unitCode`; a partitioned room
 * appends its listingType so two rooms in one apartment stay distinct; a
 * charge-less or unit-less line yields null rather than throwing; and NO money
 * field moves.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/line-unit-identity.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { getBillingDocumentDetail } from "../repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix c4; unused by any other suite)
const ORG = "c4000000-0000-4000-8000-000000000001";
const USER = "c4000000-0000-4000-8000-000000000002";
const OWNER = "c4000000-0000-4000-8000-000000000003";
const CAT = "c4000000-0000-4000-8000-000000000004";
const SERIES = "c4000000-0000-4000-8000-000000000005";
const PROPERTY = "c4000000-0000-4000-8000-000000000006";
// Two WHOLE apartments (distinct unitCodes) + one PARTITIONED apartment with
// two rooms — the case a bare unitCode cannot disambiguate on its own.
const APT_A = "c4000000-0000-4000-8000-000000000010";
const APT_B = "c4000000-0000-4000-8000-000000000011";
const APT_P = "c4000000-0000-4000-8000-000000000012";
const UNIT_A = "c4000000-0000-4000-8000-000000000020";
const UNIT_B = "c4000000-0000-4000-8000-000000000021";
const UNIT_P1 = "c4000000-0000-4000-8000-000000000022";
const UNIT_P2 = "c4000000-0000-4000-8000-000000000023";
const CHG_A = "c4000000-0000-4000-8000-000000000030";
const CHG_B = "c4000000-0000-4000-8000-000000000031";
const CHG_P1 = "c4000000-0000-4000-8000-000000000032";
const CHG_P2 = "c4000000-0000-4000-8000-000000000033";
const CHG_NOUNIT = "c4000000-0000-4000-8000-000000000034";
const DOC = "c4000000-0000-4000-8000-000000000040";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  // NB: the Prisma model is `Listing`, mapped to the "Unit" table.
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "Line Unit Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "lineunit@test.local", passwordHash: "x", role: "admin",
      fullName: "Line Unit Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "Line Unit Owner", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "management_fee", name: "Management fee",
      family: "collect_from_landlord", docType: "invoice", seriesId: SERIES,
      defaultSstRate: 8, eInvoiceEligible: false, ledgerCategory: "management_fee",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "Kason Test Residences", propertyCode: "KTR",
      propertyType: "condominium", addressLine1: "1 Test Road", city: "Kuala Lumpur",
      country: "MY", status: "active", publishStatus: "unpublished",
    },
  });
  for (const [id, unitCode, listingMode] of [
    [APT_A, "A-01-01", "WHOLE"],
    [APT_B, "A-01-02", "WHOLE"],
    [APT_P, "B-02-07", "PARTITIONED"],
  ] as const) {
    await db.apartment.create({
      data: { id, organizationId: ORG, propertyId: PROPERTY, unitCode, listingMode },
    });
  }
  for (const [id, apartmentId, listingType] of [
    [UNIT_A, APT_A, "Whole Unit"],
    [UNIT_B, APT_B, "Whole Unit"],
    [UNIT_P1, APT_P, "Master Room"],
    [UNIT_P2, APT_P, "Middle Room"],
  ] as const) {
    await db.listing.create({
      data: {
        id, organizationId: ORG, apartmentId, listingType,
        occupancyStatus: "occupied", listingStatus: "unlisted", currency: "MYR",
      },
    });
  }
  // One charge per unit + one deliberately unit-less charge (B4).
  for (const [id, unitId, amount] of [
    [CHG_A, UNIT_A, "220.00"],
    [CHG_B, UNIT_B, "220.00"],
    [CHG_P1, UNIT_P1, "150.00"],
    [CHG_P2, UNIT_P2, "150.00"],
    [CHG_NOUNIT, null, "90.00"],
  ] as const) {
    await db.charge.create({
      data: {
        id, organizationId: ORG, chargeNumber: `OSC-${id.slice(-4)}`, unitId,
        partyId: OWNER, chargeType: "management_fee", status: "posted",
        dueDate: new Date("2026-09-01"), billingMonth: new Date("2026-09-01"),
        amount, outstandingAmount: amount, currency: "MYR", attachmentKeys: [],
      },
    });
  }
  // The combined statement's IVOWN document: apartmentId NULL (covers all units),
  // one management-fee line per charge, plus a charge-less line (B3).
  await db.billingDocument.create({
    data: {
      id: DOC, organizationId: ORG, docType: "invoice",
      documentNumber: "IVOWN-9001", seriesId: SERIES, status: "issued",
      issuedById: USER, counterpartyType: "owner", partyId: OWNER,
      billingMonth: new Date("2026-09-01"),
      subtotal: "830.00", sstAmount: "66.40", total: "896.40",
      issuedAt: new Date("2026-09-02T00:00:00.000Z"),
      lines: {
        create: [
          { chargeId: CHG_A, categoryId: CAT, description: "Management fee", amount: "220.00", sstRate: 8, sstAmount: "17.60" },
          { chargeId: CHG_B, categoryId: CAT, description: "Management fee", amount: "220.00", sstRate: 8, sstAmount: "17.60" },
          { chargeId: CHG_P1, categoryId: CAT, description: "Management fee", amount: "150.00", sstRate: 8, sstAmount: "12.00" },
          { chargeId: CHG_P2, categoryId: CAT, description: "Management fee", amount: "150.00", sstRate: 8, sstAmount: "12.00" },
          { chargeId: CHG_NOUNIT, categoryId: CAT, description: "Management fee", amount: "90.00", sstRate: 8, sstAmount: "7.20" },
          { chargeId: null, categoryId: null, description: "Overpayment credit", amount: "30.00", sstRate: 0, sstAmount: "0" },
        ],
      },
    },
  });
}

dn("getBillingDocumentDetail — per-line unit identity", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("resolves each charge-backed line's unit code from its charge", async () => {
    const detail = await getBillingDocumentDetail(ORG, DOC);
    expect(detail).not.toBeNull();
    const byCharge = new Map(detail!.lines.map((l) => [l.chargeId, l.unitCode]));
    expect(byCharge.get(CHG_A)).toBe("A-01-01");
    expect(byCharge.get(CHG_B)).toBe("A-01-02");
  });

  it("disambiguates two rooms inside one PARTITIONED apartment by listingType", async () => {
    const detail = await getBillingDocumentDetail(ORG, DOC);
    const byCharge = new Map(detail!.lines.map((l) => [l.chargeId, l.unitCode]));
    // Both rooms live in apartment B-02-07 — a bare unitCode would render them
    // identically, which is the very bug this feature fixes.
    expect(byCharge.get(CHG_P1)).toBe("B-02-07 · Master Room");
    expect(byCharge.get(CHG_P2)).toBe("B-02-07 · Middle Room");
    expect(byCharge.get(CHG_P1)).not.toBe(byCharge.get(CHG_P2));
  });

  it("yields null — never throws — for a charge-less line and a unit-less charge", async () => {
    const detail = await getBillingDocumentDetail(ORG, DOC);
    // R12a overpayment-CN line: no charge at all.
    const chargeless = detail!.lines.find((l) => l.chargeId === null);
    expect(chargeless).toBeDefined();
    expect(chargeless!.unitCode).toBeNull();
    // A charge that exists but carries no unitId.
    const unitless = detail!.lines.find((l) => l.chargeId === CHG_NOUNIT);
    expect(unitless).toBeDefined();
    expect(unitless!.unitCode).toBeNull();
    // The field is always present (never undefined) on every line, so the
    // renderers can branch on null alone.
    for (const l of detail!.lines) expect(l.unitCode).not.toBeUndefined();
  });

  it("moves no money — amounts, SST, paid and outstanding are untouched", async () => {
    const detail = await getBillingDocumentDetail(ORG, DOC);
    const a = detail!.lines.find((l) => l.chargeId === CHG_A)!;
    expect(a.amount).toBe("220.00");
    expect(a.originalAmount).toBe("220.00");
    expect(a.adjustedAmount).toBe("220.00");
    expect(a.sstAmount).toBe("17.60");
    expect(a.sstRate).toBe("8");
    expect(a.paid).toBe("0.00");
    expect(a.outstanding).toBe("220.00");
    // Document-level money is likewise unchanged by a display-only field.
    expect(detail!.subtotal).toBe("830.00");
    expect(detail!.total).toBe("896.40");
    expect(detail!.balance).toBe("830.00");
  });
});
