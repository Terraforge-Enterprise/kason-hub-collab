/**
 * Integration tests for the draft catch-up hook (draft-catchup.hook.ts) — a
 * tenancy created AFTER a period's auto-draft run must be brought level with its
 * cohort, and ONLY with its cohort. Hits a real LOCAL Postgres. Skipped by
 * default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="<local>" \
 *     npx vitest run src/modules/billing/__tests__/draft-catchup.integration.test.ts
 *
 * Mirrors the auto-draft integration harness: fixed-UUID seed (disjoint from
 * every other integration test's constants) + org-scoped deleteMany cleanup.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { runAutoDraftInvoices } from "../auto-draft.service";
import { draftCatchupForTenancy, draftCatchupForUnit } from "../draft-catchup.hook";
import { postMonthlyRentForTenancy } from "../post-monthly-rent";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from every other integration test's constants.
const ORG = "dc000000-0000-4000-8000-0000000000a1";
const USER = "dc000000-0000-4000-8000-0000000000a2";
const OP_PARTY = "dc000000-0000-4000-8000-0000000000a3";
const TENANT_1 = "dc000000-0000-4000-8000-0000000000a4";
const TENANT_2 = "dc000000-0000-4000-8000-0000000000a5";
const PROPERTY = "dc000000-0000-4000-8000-0000000000a6";
const APARTMENT = "dc000000-0000-4000-8000-0000000000a7";
const UNIT_1 = "dc000000-0000-4000-8000-0000000000a8";
const UNIT_2 = "dc000000-0000-4000-8000-0000000000a9";
const TENANCY_1 = "dc000000-0000-4000-8000-0000000000b1";
// First 8 chars MUST differ from TENANCY_1's: tenantInvoiceNumber() keys the
// invoice number on tenancyId.slice(0, 8), so a shared prefix collides two
// tenancies' TR numbers within one period (never happens with real random ids).
const TENANCY_2 = "dcff0000-0000-4000-8000-0000000000b2";

// The cohort period a run covers, and a `now` inside that same month — the
// hook's window is "current month onward", resolved from this now.
const PERIOD = "2026-06";
const NOW = new Date("2026-06-10T04:00:00.000Z");
// A period AFTER the current month. The cohort-coverage rule (a completed run
// AND ≥1 tenant_rental Invoice) governs only these: the CURRENT month is always
// in scope, so a coverage test pinned to it would be testing the other rule.
const FUTURE_PERIOD = "2026-07";

const RUN_CTX = { orgId: ORG, actorUserId: USER, actorRole: "admin" as const, triggeredBy: "system:auto-draft" };
const HOOK_CTX = { orgId: ORG, userId: USER, role: "admin" };

async function seedBase(opts: { configActive?: boolean } = {}) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "DC Int Org", slug: "dc-int-org", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OP_PARTY, organizationId: ORG, displayName: "DC Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "dc-int-operator@example.com", fullName: "DC Operator",
      status: "active", role: "admin", userType: "operator", partyId: OP_PARTY,
    },
  });
  await db.party.create({
    data: { id: TENANT_1, organizationId: ORG, displayName: "DC Tenant 1", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_2, organizationId: ORG, displayName: "DC Tenant 2", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "DC Int Property", propertyCode: "DC-INT-P1",
      propertyType: "apartment", addressLine1: "1 Test St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "DC-1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: { id: UNIT_1, organizationId: ORG, apartmentId: APARTMENT, listingType: "room-a", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" },
  });
  await db.listing.create({
    data: { id: UNIT_2, organizationId: ORG, apartmentId: APARTMENT, listingType: "room-b", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" },
  });
  // The cohort tenancy that exists BEFORE the run.
  await db.tenancy.create({
    data: {
      id: TENANCY_1, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT_1, tenantPartyId: TENANT_1,
      tenancyCode: "DC-INT-T1", status: "active", billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1200.00",
    },
  });
  await db.draftConfig.create({
    data: {
      organizationId: ORG, runDayOfMonth: 1, includeRent: true, includeElectricity: false,
      includeMgmtFee: false, includeCleaning: false, isActive: opts.configActive ?? true,
    },
  });
}

/** The late tenancy — created only AFTER a test has run the period's cohort. */
async function createLateTenancy(startDate = new Date("2026-06-01T00:00:00.000Z")) {
  await getDb().tenancy.create({
    data: {
      id: TENANCY_2, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT_2, tenantPartyId: TENANT_2,
      tenancyCode: "DC-INT-T2", status: "active", billingStatus: "current",
      startDate, monthlyRentAmount: "1500.00",
    },
  });
}

/**
 * A tenancy that occupies the FUTURE period only — it must not overlap the
 * current month, or the always-draft-the-current-month rule would fire and the
 * cohort-coverage assertion would be testing the wrong thing.
 */
async function createFuturePeriodTenancy() {
  await createLateTenancy(new Date("2026-07-01T00:00:00.000Z"));
}

/** Delete everything in FK-safe order (AuditLog before User — Restrict FK). */
async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG] };
  await db.chargeEvent.deleteMany({ where: { organizationId: orgs } });
  await db.charge.deleteMany({ where: { organizationId: orgs } });
  await db.invoice.deleteMany({ where: { organizationId: orgs } });
  await db.invoiceDraftRun.deleteMany({ where: { organizationId: orgs } });
  await db.draftConfig.deleteMany({ where: { organizationId: orgs } });
  await db.tenancy.deleteMany({ where: { organizationId: orgs } });
  await db.listing.deleteMany({ where: { organizationId: orgs } });
  await db.apartment.deleteMany({ where: { organizationId: orgs } });
  await db.property.deleteMany({ where: { organizationId: orgs } });
  await db.auditLog.deleteMany({ where: { organizationId: orgs } });
  await db.user.deleteMany({ where: { organizationId: orgs } });
  await db.partyRole.deleteMany({ where: { organizationId: orgs } });
  await db.party.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

const FLAG = "ENABLE_PHASE2_AUTODRAFT";
let savedFlag: string | undefined;

dn("draftCatchupForTenancy / draftCatchupForUnit (integration)", () => {
  beforeEach(async () => {
    savedFlag = process.env[FLAG];
    process.env[FLAG] = "true";
    await cleanup();
  });
  afterAll(async () => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    if (RUN) await cleanup();
  });

  it("drafts a late tenancy into an already-run period, idempotently, through the run's own keys", async () => {
    await seedBase();
    const run = await runAutoDraftInvoices(RUN_CTX, PERIOD);
    expect(run.status).toBe("completed");
    expect(run.draftsCreated).toBe(1); // the cohort: TENANCY_1

    await createLateTenancy();
    const first = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(first.drafted).toEqual([PERIOD]);

    const db = getDb();
    const inv = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
      include: { charges: true },
    });
    expect(inv).not.toBeNull();
    expect(inv!.status).toBe("draft");
    expect(inv!.invoiceType).toBe("tenant_rental");
    expect(Number(inv!.totalAmount)).toBe(1500);
    // The rent charge is a DRAFT — invisible and unpayable in the tenant portal
    // until an admin approves the invoice (the human money-gate stays).
    expect(inv!.charges).toHaveLength(1);
    expect(inv!.charges[0].status).toBe("draft");
    expect(inv!.charges[0].chargeNumber).toBe(`RENT-202606-${TENANCY_2}`);

    // The audit row names the catch-up as the trigger, not the run.
    const audit = await db.auditLog.findFirst({
      where: { organizationId: ORG, action: "billing.invoice.draft_created", entityId: inv!.id },
    });
    expect((audit?.meta as { triggeredBy?: string })?.triggeredBy).toBe("system:draft-catchup");

    // Replay: nothing new, nothing duplicated.
    const second = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(second.drafted).toEqual([]);
    const count = await db.invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } });
    expect(count).toBe(1);
  });

  it("drafts the CURRENT month even when no run has EVER happened", async () => {
    // THE fix. Under advance billing the run day drafts NEXT month, so the month
    // an admin is standing in is never a cohort — requiring one meant a tenant
    // assigned mid-month was billed nothing for that month by any surface, while
    // the schedule cheerfully drafted them the month after.
    await seedBase();
    await createLateTenancy();

    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);

    expect(res.drafted).toEqual([PERIOD]);
    const inv = await getDb().invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
      select: { status: true, totalAmount: true },
    });
    expect(inv?.status).toBe("draft"); // still behind the human approval gate
    expect(Number(inv!.totalAmount)).toBe(1500); // occupies the whole month
    // No run was invented to justify it.
    expect(await getDb().invoiceDraftRun.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("PRORATES a mid-month move-in in the current month", async () => {
    // The money assertion behind "it might be middle of AUG, but anyway".
    await seedBase();
    await createLateTenancy(new Date("2026-06-12T00:00:00.000Z"));

    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);

    expect(res.drafted).toEqual([PERIOD]);
    const inv = await getDb().invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
      select: { totalAmount: true },
    });
    // 12 Jun–30 Jun inclusive = 19 of 30 days: 1500 × 19/30 = 950.00.
    expect(Number(inv!.totalAmount)).toBe(950);
  });

  it("re-running the catch-up adds nothing — the current-month draft is idempotent too", async () => {
    await seedBase();
    await createLateTenancy();
    await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);

    const second = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);

    expect(second.drafted).toEqual([]);
    expect(await getDb().invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } })).toBe(1);
  });

  it("does NOT draft a future period no run has covered (the run stays that month's scheduler)", async () => {
    await seedBase();
    await createFuturePeriodTenancy(); // occupies July only, not the current month
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([]);
    const count = await getDb().invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } });
    expect(count).toBe(0);
  });

  it("ignores completed FUTURE-period runs that drafted nothing because the config was inactive", async () => {
    await seedBase({ configActive: false });
    // Writes a completed InvoiceDraftRun that drafted zero rent invoices.
    const run = await runAutoDraftInvoices(RUN_CTX, FUTURE_PERIOD);
    expect(run.draftsCreated).toBe(0);

    await getDb().draftConfig.update({ where: { organizationId: ORG }, data: { isActive: true } });
    await createFuturePeriodTenancy();
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([]);
  });

  it("ignores a completed FUTURE-period run that drafted no RENT because includeRent was off", async () => {
    // The subtler twin of the test above, and the reason coverage is proven by a
    // tenant_rental Invoice rather than by the run row: a run with includeRent
    // off completes normally with errorText null, and InvoiceDraftRun keeps no
    // toggle history. Counting it as coverage would make a late tenancy the ONLY
    // tenant with a rent draft that month, in an org that bills rent by hand.
    await seedBase();
    const db = getDb();
    await db.draftConfig.update({ where: { organizationId: ORG }, data: { includeRent: false } });
    const run = await runAutoDraftInvoices(RUN_CTX, FUTURE_PERIOD);
    expect(run.status).toBe("completed");
    expect(run.errorText).toBeNull();
    expect(await db.invoice.count({ where: { organizationId: ORG, invoiceType: "tenant_rental" } })).toBe(0);

    // Toggle rent back on, then create the late tenancy.
    await db.draftConfig.update({ where: { organizationId: ORG }, data: { includeRent: true } });
    await createFuturePeriodTenancy();
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([]);
    expect(await db.invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } })).toBe(0);
  });

  it("includeRent OFF still suppresses the current month entirely", async () => {
    // The org-level opt-out is the ONE gate the always-draft-the-current-month
    // rule must not walk through: an org that bills rent by hand must not get an
    // automatic draft just because a tenancy was created.
    await seedBase();
    await getDb().draftConfig.update({ where: { organizationId: ORG }, data: { includeRent: false } });
    await createLateTenancy();

    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);

    expect(res.drafted).toEqual([]);
    expect(await getDb().invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } })).toBe(0);
  });

  it("never drafts a month BEFORE the current one (backdated drafting stays manual)", async () => {
    // A past month can sit inside a frozen owner-statement period, so it stays an
    // explicit POST /billing/draft-runs by a human. The current month still drafts.
    await seedBase();
    const run = await runAutoDraftInvoices(RUN_CTX, "2026-05");
    expect(run.status).toBe("completed");

    await createLateTenancy();
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW); // NOW is in June

    expect(res.drafted).toEqual([PERIOD]); // June only
    expect(res.drafted).not.toContain("2026-05");
    const may = await getDb().invoice.count({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:2026-05` },
    });
    expect(may).toBe(0);
  });

  it("skips a tenancy with no billable days in the covered period (amount prorates to 0)", async () => {
    await seedBase();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);
    // Starts in July — occupies zero days of the June cohort period.
    await getDb().tenancy.create({
      data: {
        id: TENANCY_2, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT_2, tenantPartyId: TENANT_2,
        tenancyCode: "DC-INT-T2", status: "active", billingStatus: "current",
        startDate: new Date("2026-07-01T00:00:00.000Z"), monthlyRentAmount: "1500.00",
      },
    });
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([]);
    const count = await getDb().invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } });
    expect(count).toBe(0);
  });

  it("still drafts an interactive tenancy when the scheduled auto-draft flag is off", async () => {
    await seedBase();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);
    await createLateTenancy();
    process.env.ENABLE_PHASE2_AUTODRAFT = "false";
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([PERIOD]);
    const count = await getDb().invoice.count({ where: { organizationId: ORG, tenancyId: TENANCY_2 } });
    expect(count).toBe(1);
  });

  it("draftCatchupForUnit resolves the unit's active tenancy and catches it up", async () => {
    await seedBase();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);
    await createLateTenancy();
    const res = await draftCatchupForUnit(HOOK_CTX, UNIT_2, NOW);
    expect(res.drafted).toEqual([PERIOD]);
    const inv = await getDb().invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
    });
    expect(inv?.status).toBe("draft");
  });

  it("never double-bills when the grid/meter path already posted this month's rent", async () => {
    // The cross-lane invariant, and the "is this month already billed?" check.
    // The bills-grid "Post charges" flow mints a POSTED rent Charge directly
    // (postMonthlyRentForTenancy) WITHOUT an auto-draft Invoice, so the
    // invoice-level idempotency key cannot see it. The drafter therefore also
    // check-firsts the rent chargeNumber `RENT-{YYYYMM}-{tenancyId}` and skips
    // cleanly. It used to discover this by hitting the Charge unique instead —
    // correct money, reached through a P2002 that rolled back an interactive
    // transaction and had to be classified as benign by every caller.
    await seedBase();
    await createLateTenancy();

    const db = getDb();
    const firstOfMonth = new Date(Date.UTC(2026, 5, 1));
    const posted = await db.$transaction((tx) =>
      postMonthlyRentForTenancy(tx, ORG, TENANCY_2, firstOfMonth, USER),
    );
    expect(posted.created).toBe(true);

    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([]); // nothing drafted — the rent already exists

    // Exactly ONE rent charge for the month, still the grid's posted one.
    const charges = await db.charge.findMany({
      where: { organizationId: ORG, chargeNumber: `RENT-202606-${TENANCY_2}` },
      select: { id: true, status: true },
    });
    expect(charges).toHaveLength(1);
    expect(charges[0].status).toBe("posted");
    expect(charges[0].id).toBe(posted.chargeId);

    // And the rolled-back draft left no orphan invoice behind.
    const invoices = await db.invoice.count({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
    });
    expect(invoices).toBe(0);
  });

  it("a mid-month handover RE-PRORATES the outgoing draft instead of over-drafting the unit", async () => {
    // Was a pinned REPRO: the outgoing tenancy's FULL-month draft was a snapshot
    // taken before the handover was known, and nothing re-prorated it when the
    // tenancy was ended early. The incoming prorated draft was itself correct, so
    // the unit-month's drafted rent came to RM1840 on a RM1200 unit. This is that
    // REPRO flipped: the stale half is now brought level with the facts.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);

    const outgoing = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { id: true, totalAmount: true },
    });
    expect(Number(outgoing!.totalAmount)).toBe(1200); // full month, RM1200

    // Handover on the 15th: TENANCY_1 ends, TENANCY_2 takes the SAME unit.
    const handover = new Date(Date.UTC(2026, 5, 15));
    await db.tenancy.update({ where: { id: TENANCY_1 }, data: { status: "ended", endDate: handover } });
    await db.tenancy.create({
      data: {
        id: TENANCY_2, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT_1, tenantPartyId: TENANT_2,
        tenancyCode: "DC-INT-T2", status: "active", billingStatus: "current",
        startDate: handover, monthlyRentAmount: "1200.00",
      },
    });

    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);
    expect(res.drafted).toEqual([PERIOD]);

    const incoming = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
      select: { totalAmount: true },
    });
    const corrected = await db.invoice.findFirst({ where: { id: outgoing!.id }, select: { totalAmount: true } });

    // The outgoing draft is now prorated to 1–15 June = 15 of 30 days.
    expect(Number(corrected!.totalAmount)).toBe(600);
    // The incoming draft is prorated to 15–30 June = 16 of 30 days.
    expect(Number(incoming!.totalAmount)).toBe(640);
    // Was RM1840 on a RM1200 unit; now RM1240.
    const unitMonthTotal = Number(corrected!.totalAmount) + Number(incoming!.totalAmount);
    expect(unitMonthTotal).toBe(1240);
    // The residual RM40 is ONE handover day billed to both tenants, not a bug in
    // this hook: computeProratedRent counts both window endpoints inclusively, so
    // a tenancy ending on the 15th and one starting on the 15th each occupy it.
    // That convention is repo-wide (occupiedDaysInPeriod agrees) and is left
    // alone deliberately — changing it would re-price every prorated rent.
    expect(unitMonthTotal - 1200).toBe(1200 / 30); // exactly one day: RM40

    // The correction is auditable, and it moved the CHARGE, not just the header.
    const rentCharge = await db.charge.findFirst({
      where: { organizationId: ORG, chargeNumber: `RENT-202606-${TENANCY_1}` },
      select: { amount: true, outstandingAmount: true, status: true },
    });
    expect(Number(rentCharge!.amount)).toBe(600);
    expect(Number(rentCharge!.outstandingAmount)).toBe(600);
    expect(rentCharge!.status).toBe("draft");
    const audit = await db.auditLog.count({
      where: { organizationId: ORG, action: "billing.invoice.draft_reprorated" },
    });
    expect(audit).toBe(1);
  });

  it("the manual RUN re-prorates a handover too — Generate is not a second route to the over-draft", async () => {
    // The run bills by period OVERLAP, so a handover month selects BOTH
    // tenancies: the incoming one is drafted, the outgoing one is skipped
    // because its (stale, full-month) draft already exists. Clicking Generate
    // after a handover therefore used to reproduce the same over-drafted
    // unit-month the catch-up hook closes — with no tenancy write to trigger it.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD); // TENANCY_1 drafted a full RM1200

    // Handover on the 15th, written DIRECTLY (no creator hook fires).
    const handover = new Date(Date.UTC(2026, 5, 15));
    await db.tenancy.update({ where: { id: TENANCY_1 }, data: { status: "ended", endDate: handover } });
    await db.tenancy.create({
      data: {
        id: TENANCY_2, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT_1, tenantPartyId: TENANT_2,
        tenancyCode: "DC-INT-T2", status: "active", billingStatus: "current",
        startDate: handover, monthlyRentAmount: "1200.00",
      },
    });

    const second = await runAutoDraftInvoices(RUN_CTX, PERIOD);
    expect(second.status).toBe("completed");
    expect(second.draftsCreated).toBe(1); // only the incoming tenancy
    expect(second.draftsSkipped).toBe(1); // the outgoing draft already existed

    const outgoing = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { totalAmount: true },
    });
    const incoming = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_2}:${PERIOD}` },
      select: { totalAmount: true },
    });
    expect(Number(outgoing!.totalAmount)).toBe(600); // re-prorated by the run itself
    expect(Number(incoming!.totalAmount)).toBe(640);
  });

  it("NEVER rewrites a draft that has already been approved — that is a credit note, not a silent edit", async () => {
    // The hard boundary on re-proration. Once the outgoing invoice is approved its
    // charges are live receivables (and, with billing docs on, documented), so a
    // quiet amount rewrite would change money a tenant has already been shown.
    // It is reported instead.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);

    const outgoing = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { id: true },
    });
    await db.invoice.update({ where: { id: outgoing!.id }, data: { status: "approved" } });

    const handover = new Date(Date.UTC(2026, 5, 15));
    await db.tenancy.update({ where: { id: TENANCY_1 }, data: { status: "ended", endDate: handover } });
    await db.tenancy.create({
      data: {
        id: TENANCY_2, organizationId: ORG, propertyId: PROPERTY, unitId: UNIT_1, tenantPartyId: TENANT_2,
        tenancyCode: "DC-INT-T2", status: "active", billingStatus: "current",
        startDate: handover, monthlyRentAmount: "1200.00",
      },
    });

    await draftCatchupForTenancy(HOOK_CTX, TENANCY_2, NOW);

    const untouched = await db.invoice.findFirst({ where: { id: outgoing!.id }, select: { totalAmount: true } });
    expect(Number(untouched!.totalAmount)).toBe(1200); // live money, left alone
    // …but the uncorrectable staleness is durably recorded for a human.
    const flagged = await db.auditLog.count({
      where: { organizationId: ORG, action: "billing.invoice.stale_rent_uncorrectable" },
    });
    expect(flagged).toBe(1);
  });

  it("the VACATE path corrects too — ending the last tenancy is what makes the draft stale", async () => {
    // Inventory → Edit unit → occupancyStatus vacant is how an admin records a
    // move-out, and syncOccupancyTenancy's not-occupied branch ends the tenancy.
    // draftCatchupForUnit used to key off `status: "active"` tenancies, which is
    // EMPTY right after that write — so the one path that creates the staleness
    // was the only path that never corrected it.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD); // TENANCY_1: full RM1200

    await db.tenancy.update({
      where: { id: TENANCY_1 },
      data: { status: "ended", endDate: new Date(Date.UTC(2026, 5, 15)) },
    });

    const res = await draftCatchupForUnit(HOOK_CTX, UNIT_1, NOW);

    expect(res.drafted).toEqual([]); // nothing to draft — the unit is empty
    const corrected = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { totalAmount: true },
    });
    expect(Number(corrected!.totalAmount)).toBe(600); // 15 of 30 days
  });

  it("corrects a PAST month, so a move-out recorded after the calendar rolls over is not permanent", async () => {
    // The drafting scope deliberately never reaches back (frozen owner-statement
    // periods). Correction must, because the event that invalidates a draft
    // routinely lands in a later month than the draft itself: a 15-Aug move-out
    // keyed in on 2 Sep left the August pair at RM1840 forever.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD); // June, full RM1200

    await db.tenancy.update({
      where: { id: TENANCY_1 },
      data: { status: "ended", endDate: new Date(Date.UTC(2026, 5, 15)) },
    });

    // "now" is JULY — June is a past month and is not in the drafting scope.
    const laterNow = new Date("2026-07-02T04:00:00.000Z");
    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_1, laterNow);

    expect(res.drafted).toEqual([]); // did not draft the past month
    const corrected = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { totalAmount: true },
    });
    expect(Number(corrected!.totalAmount)).toBe(600); // …but did correct it
  });

  it("a tenancy that no longer occupies the month at all is corrected to 0, not left at a full month", async () => {
    // Moving a move-in date OUT of a drafted month used to hit a `resolves_to_zero`
    // branch that reported and returned, leaving the full month standing —
    // RM1200 owed by someone who was never there.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);

    await db.tenancy.update({
      where: { id: TENANCY_1 },
      data: { startDate: new Date(Date.UTC(2026, 6, 1)) }, // now starts in JULY
    });

    await draftCatchupForTenancy(HOOK_CTX, TENANCY_1, NOW);

    const corrected = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { totalAmount: true },
    });
    expect(Number(corrected!.totalAmount)).toBe(0);
  });

  it("a tenancy demoted to `draft` status has its month zeroed, not left billed", async () => {
    // `draft` is the one status meaning "this agreement is not real". The
    // billable-status gate used to return BEFORE the correction ran, so the
    // money it should never have been billed just stayed.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);

    await db.tenancy.update({ where: { id: TENANCY_1 }, data: { status: "draft" } });

    const res = await draftCatchupForTenancy(HOOK_CTX, TENANCY_1, NOW);

    expect(res.drafted).toEqual([]); // never drafts a non-billable tenancy
    const corrected = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { totalAmount: true },
    });
    expect(Number(corrected!.totalAmount)).toBe(0);
  });

  it("corrects the rent line by its chargeNumber, leaving an attached extra charge alone", async () => {
    // The rent line used to be picked with an unordered findFirst over
    // chargeType in (rent, letting_commission). attachChargeService lets an
    // editor attach ANY unlinked charge to a draft invoice — including a second
    // `rent` row — so Postgres physical order decided which amount got
    // overwritten. Matching the drafter's deterministic chargeNumber is exact.
    await seedBase();
    const db = getDb();
    await runAutoDraftInvoices(RUN_CTX, PERIOD);
    const inv = await db.invoice.findFirst({
      where: { organizationId: ORG, idempotencyKey: `draft:${TENANCY_1}:${PERIOD}` },
      select: { id: true },
    });

    const extra = await db.charge.create({
      data: {
        organizationId: ORG, chargeNumber: `ARREARS-202606-${TENANCY_1}`, tenancyId: TENANCY_1,
        unitId: UNIT_1, partyId: TENANT_1, chargeType: "rent", status: "draft",
        description: "Arrears carried forward", dueDate: new Date(Date.UTC(2026, 5, 1)),
        amount: "300.00", currency: "MYR", outstandingAmount: "300.00",
        billingMonth: new Date(Date.UTC(2026, 5, 1)), attachmentKeys: [], invoiceId: inv!.id,
      },
      select: { id: true },
    });

    await db.tenancy.update({
      where: { id: TENANCY_1 },
      data: { status: "ended", endDate: new Date(Date.UTC(2026, 5, 15)) },
    });
    await draftCatchupForTenancy(HOOK_CTX, TENANCY_1, NOW);

    const rent = await db.charge.findFirst({
      where: { organizationId: ORG, chargeNumber: `RENT-202606-${TENANCY_1}` },
      select: { amount: true },
    });
    const arrears = await db.charge.findFirst({ where: { id: extra.id }, select: { amount: true } });
    expect(Number(rent!.amount)).toBe(600); // the rent line moved
    expect(Number(arrears!.amount)).toBe(300); // the attached line did NOT
  });

  it("never throws on a nonexistent tenancy or unit", async () => {
    await seedBase();
    const t = await draftCatchupForTenancy(HOOK_CTX, "dc000000-0000-4000-8000-0000000000ff", NOW);
    expect(t.drafted).toEqual([]);
    const u = await draftCatchupForUnit(HOOK_CTX, "dc000000-0000-4000-8000-0000000000fe", NOW);
    expect(u.drafted).toEqual([]);
  });
});
