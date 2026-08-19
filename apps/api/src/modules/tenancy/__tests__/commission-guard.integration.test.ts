/**
 * Integration tests for assertCommissionWritable — the commission write-lock.
 *
 * The unit suite mocks Prisma, so it proves the ARITHMETIC but not the
 * PREDICATES: a wrong `where` clause passes every one of those cases. These
 * tests run the real queries, and scenario 1 is the regression pin for the
 * originally reported bug (a draft invoice freezing the columns forever).
 *
 * Hits a real local Postgres. Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://postgres:postgres@localhost:5432/kaenproperties?schema=public" \
 *     npx vitest run commission-guard.integration
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { CASH_PAYMENT_STATUS } from "@kason/shared";
import { assertCommissionWritable } from "../commission-guard";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // This suite writes real Payment/Charge rows. Refuse anything but the local
  // dev DB, even by accident (money-critical read path).
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`commission-guard.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const ORG = "99990009-0009-4009-8009-000000000001";
const ORG_OTHER = "99990009-0009-4009-8009-0000000000f1";
const ADMIN_USER = "99990009-0009-4009-8009-000000000002";
const OWNER_PARTY = "99990009-0009-4009-8009-000000000003";
const PROPERTY = "99990009-0009-4009-8009-000000000004";
const APARTMENT = "99990009-0009-4009-8009-000000000005";
const UNIT = "99990009-0009-4009-8009-000000000006";
const TENANT_PARTY = "99990009-0009-4009-8009-000000000007";
const TENANCY = "99990009-0009-4009-8009-000000000008";
const CHARGE_RENT = "99990009-0009-4009-8009-000000000009";
const PAYMENT = "99990009-0009-4009-8009-00000000000a";
const ALLOCATION = "99990009-0009-4009-8009-00000000000b";

// Cross-org fixtures — a fully paid tenancy in ANOTHER org, proving the guard's
// reads are org-scoped and one org's cash can never lock another's fields.
const OTHER_PARTY = "99990009-0009-4009-8009-0000000000f2";
const OTHER_PROPERTY = "99990009-0009-4009-8009-0000000000f3";
const OTHER_APARTMENT = "99990009-0009-4009-8009-0000000000f4";
const OTHER_UNIT = "99990009-0009-4009-8009-0000000000f5";
const OTHER_TENANCY = "99990009-0009-4009-8009-0000000000f6";
const OTHER_CHARGE = "99990009-0009-4009-8009-0000000000f7";
const OTHER_PAYMENT = "99990009-0009-4009-8009-0000000000f8";
const OTHER_ALLOCATION = "99990009-0009-4009-8009-0000000000f9";

const SESSION = { role: "admin", orgId: ORG };
const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

async function cleanup() {
  const db = getDb();
  const orgs = [ORG, ORG_OTHER];
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.payment.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.invoice.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.charge.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.tenancy.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.listing.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.apartment.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.property.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.party.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.user.deleteMany({ where: { organizationId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
}

function orgData(id: string, slug: string) {
  return {
    id,
    name: `Commission Guard Org ${slug}`,
    slug,
    status: "active",
    defaultCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    locale: "en-MY",
    subscriptionPlan: "free",
  };
}

/** A tenancy with one `rent` charge, in `org`. No payment yet. */
async function seedTenancyWithRentCharge(args: {
  org: string;
  party: string;
  property: string;
  apartment: string;
  unit: string;
  tenancy: string;
  charge: string;
  code: string;
}) {
  const db = getDb();
  await db.party.create({
    data: { id: args.party, organizationId: args.org, displayName: "Party", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: args.property,
      organizationId: args.org,
      name: "Prop",
      propertyCode: `PC-${args.code}`,
      propertyType: "condominium",
      addressLine1: "1 Test Street",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: args.apartment,
      organizationId: args.org,
      propertyId: args.property,
      unitCode: "A-01-01",
      listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: args.unit,
      organizationId: args.org,
      apartmentId: args.apartment,
      listingType: "Whole Unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      ownerPartyId: args.party,
      currency: "MYR",
      visibilityMode: "PUBLIC",
      hiddenFromPartyIds: [],
      readyNow: false,
    },
  });
  await db.tenancy.create({
    data: {
      id: args.tenancy,
      organizationId: args.org,
      propertyId: args.property,
      unitId: args.unit,
      tenantPartyId: args.party,
      tenancyCode: args.code,
      status: "active",
      billingStatus: "active",
      startDate: D(2026, 7, 1),
      monthlyRentAmount: "2200.00",
      firstMonthIsCommission: false,
      commissionSstBearer: "owner",
    },
  });
  await db.charge.create({
    data: {
      id: args.charge,
      organizationId: args.org,
      chargeNumber: `CH-${args.code}`,
      tenancyId: args.tenancy,
      partyId: args.party,
      chargeType: "rent",
      status: "posted",
      dueDate: D(2026, 7, 1),
      amount: "2200.00",
      currency: "MYR",
      outstandingAmount: "2200.00",
    },
  });
}

/** Allocate `amount` to `chargeId` from a payment in `status`. */
async function seedPayment(args: {
  org: string;
  party: string;
  payment: string;
  allocation: string;
  charge: string;
  amount: string;
  status: string;
  number: string;
}) {
  const db = getDb();
  await db.payment.create({
    data: {
      id: args.payment,
      organizationId: args.org,
      paymentNumber: args.number,
      partyId: args.party,
      paymentType: "rent",
      paymentMethod: "bank_transfer",
      status: args.status,
      amount: args.amount,
      currency: "MYR",
      receivedAt: D(2026, 7, 5),
    },
  });
  await db.paymentAllocation.create({
    data: {
      id: args.allocation,
      organizationId: args.org,
      paymentId: args.payment,
      chargeId: args.charge,
      allocatedAmount: args.amount,
      allocatedAt: D(2026, 7, 5),
    },
  });
}

dn("assertCommissionWritable — real Prisma predicates", () => {
  beforeEach(async () => {
    await cleanup();
    const db = getDb();
    await db.organization.create({ data: orgData(ORG, "commission-guard-org") });
    await db.user.create({
      data: {
        id: ADMIN_USER,
        organizationId: ORG,
        email: "admin@commission-guard.test",
        fullName: "Guard Admin",
        passwordHash: "x",
        status: "active",
        role: "admin",
        userType: "operator",
      },
    });
    await seedTenancyWithRentCharge({
      org: ORG, party: TENANT_PARTY, property: PROPERTY, apartment: APARTMENT,
      unit: UNIT, tenancy: TENANCY, charge: CHARGE_RENT, code: "TEN-INT-0001",
    });
    // OWNER_PARTY exists only so the fixture set mirrors production shape.
    await db.party.create({
      data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner Co", partyType: "agent", status: "active" },
    });
  });

  // 1 — the reported bug. A draft invoice used to freeze these columns forever.
  it("a DRAFT invoice does not lock the commission fields", async () => {
    const db = getDb();
    await db.invoice.create({
      data: {
        organizationId: ORG,
        invoiceNumber: "INV-DRAFT-1",
        partyId: TENANT_PARTY,
        tenancyId: TENANCY,
        invoiceType: "tenant_rental",
        status: "draft",
        invoiceDate: D(2026, 7, 1),
        totalAmount: "2200.00",
      },
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });
  });

  // 2 — voiding used to be unable to release the lock, since void rows counted.
  it("a VOID invoice does not lock the commission fields", async () => {
    const db = getDb();
    await db.invoice.create({
      data: {
        organizationId: ORG,
        invoiceNumber: "INV-VOID-1",
        partyId: TENANT_PARTY,
        tenancyId: TENANCY,
        invoiceType: "tenant_rental",
        status: "void",
        invoiceDate: D(2026, 7, 1),
        totalAmount: "2200.00",
      },
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });
  });

  // 3 — received cash DOES lock.
  it("a settled payment locks the commission fields", async () => {
    await seedPayment({
      org: ORG, party: TENANT_PARTY, payment: PAYMENT, allocation: ALLOCATION,
      charge: CHARGE_RENT, amount: "500.00", status: CASH_PAYMENT_STATUS, number: "PMT-1",
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toMatchObject({
      ok: false,
      status: 409,
      code: "COMMISSION_FIELDS_LOCKED",
    });
  });

  // 4 — the whole reason CASH_ALLOCATION_WHERE exists. Portal FPX mints an
  // allocation at INITIATE; the money never arrived, so it must not lock.
  it("an allocation whose payment never settled does NOT lock", async () => {
    await seedPayment({
      org: ORG, party: TENANT_PARTY, payment: PAYMENT, allocation: ALLOCATION,
      charge: CHARGE_RENT, amount: "500.00", status: "pending", number: "PMT-PENDING",
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });
  });

  // 5 — non-monotonic by design: reversing the payment re-opens the fields.
  it("a fully reversed payment re-opens the commission fields", async () => {
    const db = getDb();
    await seedPayment({
      org: ORG, party: TENANT_PARTY, payment: PAYMENT, allocation: ALLOCATION,
      charge: CHARGE_RENT, amount: "500.00", status: CASH_PAYMENT_STATUS, number: "PMT-2",
    });
    // Locked first — proves the reversal is what changes the answer.
    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toMatchObject({ status: 409 });

    await db.paymentAllocationReversal.create({
      data: {
        organizationId: ORG,
        originalAllocationId: ALLOCATION,
        amount: "500.00",
        reason: "correction",
        reversedById: ADMIN_USER,
        idempotencyKey: "rev-int-1",
      },
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });
  });

  // 6 — a partial reversal leaving real money behind must still lock.
  it("a partial reversal leaving net cash above the threshold still locks", async () => {
    const db = getDb();
    await seedPayment({
      org: ORG, party: TENANT_PARTY, payment: PAYMENT, allocation: ALLOCATION,
      charge: CHARGE_RENT, amount: "500.00", status: CASH_PAYMENT_STATUS, number: "PMT-3",
    });
    await db.paymentAllocationReversal.create({
      data: {
        organizationId: ORG,
        originalAllocationId: ALLOCATION,
        amount: "495.00",
        reason: "partial correction",
        reversedById: ADMIN_USER,
        idempotencyKey: "rev-int-2",
      },
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toMatchObject({ status: 409 });
  });

  // 7 — another org's cash must never lock this org's tenancy.
  it("cash in another organization does not lock this tenancy", async () => {
    const db = getDb();
    await db.organization.create({ data: orgData(ORG_OTHER, "commission-guard-org-other") });
    await seedTenancyWithRentCharge({
      org: ORG_OTHER, party: OTHER_PARTY, property: OTHER_PROPERTY, apartment: OTHER_APARTMENT,
      unit: OTHER_UNIT, tenancy: OTHER_TENANCY, charge: OTHER_CHARGE, code: "TEN-INT-0002",
    });
    await seedPayment({
      org: ORG_OTHER, party: OTHER_PARTY, payment: OTHER_PAYMENT, allocation: OTHER_ALLOCATION,
      charge: OTHER_CHARGE, amount: "9999.00", status: CASH_PAYMENT_STATUS, number: "PMT-OTHER",
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });
  });

  // 8 — a deposit-only charge is not commission economics and must not lock.
  it("a paid non-rent charge does not lock", async () => {
    const db = getDb();
    const depositCharge = "99990009-0009-4009-8009-0000000000c1";
    await db.charge.create({
      data: {
        id: depositCharge,
        organizationId: ORG,
        chargeNumber: "CH-DEP-1",
        tenancyId: TENANCY,
        partyId: TENANT_PARTY,
        chargeType: "security_deposit",
        status: "posted",
        dueDate: D(2026, 7, 1),
        amount: "4400.00",
        currency: "MYR",
        outstandingAmount: "4400.00",
      },
    });
    await seedPayment({
      org: ORG, party: TENANT_PARTY, payment: PAYMENT, allocation: ALLOCATION,
      charge: depositCharge, amount: "4400.00", status: CASH_PAYMENT_STATUS, number: "PMT-DEP",
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });
  });

  // 9 — R4. The guard decides IF the columns may change; it must never rewrite
  // an already-minted charge. monthlyChargeType() reads the flags at MINT time,
  // so a charge posted as `rent` before the flag flipped stays `rent`, and
  // regenerating it is re-Bill's job, not this guard's.
  it("evaluating the guard rewrites no charge rows", async () => {
    const db = getDb();
    const before = await db.charge.findUniqueOrThrow({
      where: { id: CHARGE_RENT },
      select: { chargeType: true, status: true, amount: true },
    });

    expect(await assertCommissionWritable(SESSION, true, TENANCY)).toEqual({ ok: true });

    const after = await db.charge.findUniqueOrThrow({
      where: { id: CHARGE_RENT },
      select: { chargeType: true, status: true, amount: true },
    });
    expect(after).toEqual(before);
    expect(after.chargeType).toBe("rent");
  });
});
