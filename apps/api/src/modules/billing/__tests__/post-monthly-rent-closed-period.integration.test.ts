/**
 * R1 (enablement blocker) — closed-period write guard wired into the UNIFIED RENT
 * post helper (`postMonthlyRentForTenancy`), end-to-end (integration, RUN_INTEGRATION=1).
 *
 * MONEY: a month's rent posted for an owner-assigned unit is owner INCOME for that
 * unit's owner — attributed per-unit via `Listing.ownerPartyId` for the bill's period
 * month, surfaced by the POST-COMMIT owner-ledger sync. If that owner-statement month
 * is FROZEN, the sync's void-only forward-reversal silently DROPS the owner income, so
 * the owner-impacting rent charge MUST be rejected AT CREATION, in-tx, before the rent
 * `tx.charge.create`. This proves the shared `assertPeriodOpen` guard now does exactly
 * that at this money-write source, while leaving open months + the flag-off path
 * byte-identical, and never blocking an owner-less unit (guard no-ops, nothing to freeze).
 *
 * Run: from apps/api
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.claude/worktrees/owner-statement-closed-period-integrity/.env; set +a
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     npx vitest run src/modules/billing/__tests__/post-monthly-rent-closed-period.integration.test.ts --no-coverage
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { postMonthlyRentForTenancy } from "../post-monthly-rent";
import { rentChargeNumber } from "../auto-draft.repository";
import { ClosedPeriodError } from "../../owner-ledger/closed-period";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const LEDGER = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

// Dedicated fixture ids (prefix d417 — unused by any other suite).
const ORG = "d4170000-0000-4000-8000-000000000001";
const USER = "d4170000-0000-4000-8000-000000000002";
const PROP = "d4170000-0000-4000-8000-000000000003";
const APT = "d4170000-0000-4000-8000-000000000004";
const ROOM = "d4170000-0000-4000-8000-000000000005";
const OWNER = "d4170000-0000-4000-8000-000000000006";
const TENANT = "d4170000-0000-4000-8000-000000000007";
const TEN = "d4170000-0000-4000-8000-000000000008";
const OTHER_OWNER = "d4170000-0000-4000-8000-000000000009";

// The rent's billing month + its first-of-month (UTC) OwnerStatementPeriod key.
const RENT_MONTH = new Date(Date.UTC(2026, 5, 1)); // 2026-06

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** Org + property + apartment + owner/tenant parties + an owner-assigned unit +
 *  one active, full-month tenancy (start 2026-01-01, no move-out ⇒ full June rent).
 *  `withOwner: false` seeds an owner-LESS unit (Listing.ownerPartyId null) so the
 *  guard has no owner to freeze — proving it never blocks an owner-less rent. */
async function seed(opts: { withOwner?: boolean; startDate?: string } = {}) {
  const withOwner = opts.withOwner ?? true;
  const startDate = opts.startDate ?? "2026-01-01";
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "D417", slug: "d417", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "d417@example.test", fullName: "D417 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-D417", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-D417", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: withOwner ? OWNER : null } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT, tenancyCode: "T-D417", status: "active", billingStatus: "current", startDate: new Date(startDate), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

async function seedFrozenPeriod(opts: { month?: Date; ownerPartyId?: string } = {}) {
  const month = opts.month ?? RENT_MONTH;
  const ownerPartyId = opts.ownerPartyId ?? OWNER;
  await getDb().ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId,
      apartmentId: null, // combined scope = the freeze unit
      periodMonth: month,
      status: "frozen",
      idempotencyKey: `ownerstmt:${ownerPartyId}:${month.toISOString().slice(0, 7)}`,
      sourceMaxUpdatedAt: new Date(),
    },
  });
}

// Seed a cron-style DRAFT rent Charge carrying the EXACT dedup chargeNumber the
// helper will look for (RENT-<compactMonth>-<tenancyId>) — reproduces the auto-draft
// cron having drafted this month's rent first. invoiceId is left null (nullable).
async function seedDraftRent() {
  await getDb().charge.create({
    data: {
      organizationId: ORG, chargeNumber: rentChargeNumber("2026-06", TEN), tenancyId: TEN,
      unitId: ROOM, partyId: TENANT, chargeType: "rent", status: "draft", description: "Monthly rent",
      dueDate: RENT_MONTH, amount: "1000.00", currency: "MYR", outstandingAmount: "1000.00",
      attachmentKeys: [], billingMonth: RENT_MONTH,
    },
  });
}

// Post the tenancy's June rent inside a single interactive tx (the helper is
// tx-scoped; the meter/tracker caller invokes it the same way).
const postRent = () =>
  getDb().$transaction((tx) => postMonthlyRentForTenancy(tx, ORG, TEN, RENT_MONTH, USER));

const rentChargeCount = () =>
  getDb().charge.count({ where: { organizationId: ORG, chargeType: "rent" } });
const totalChargeCount = () => getDb().charge.count({ where: { organizationId: ORG } });

function setLedgerFlag(on: boolean) {
  if (on) process.env[LEDGER] = "1";
  else delete process.env[LEDGER];
}

dn("postMonthlyRentForTenancy — closed-period guard (integration)", () => {
  let savedLedger: string | undefined;
  beforeAll(() => {
    savedLedger = process.env[LEDGER];
  });
  afterAll(() => {
    if (savedLedger === undefined) delete process.env[LEDGER];
    else process.env[LEDGER] = savedLedger;
  });
  beforeEach(async () => {
    await cleanup();
    setLedgerFlag(true); // default flag ON; the flag-off test overrides + restores
  });
  afterEach(async () => {
    await cleanup();
  });

  it("RT1: open owner-month + flag ON → rent posts normally (created:true); one rent charge", async () => {
    await seed();
    // No frozen period seeded ⇒ the owner-month is open.
    const r = await postRent();
    expect(r.created).toBe(true);
    expect(await rentChargeCount()).toBe(1);
  });

  it("RT2: frozen owner-month + flag ON → rent post rejected (ClosedPeriodError); zero charges persisted", async () => {
    await seed();
    await seedFrozenPeriod();
    // The guard throws ClosedPeriodError inside the tx → the whole $transaction
    // rolls back → no rent charge (nor its charge events) is persisted.
    await expect(postRent()).rejects.toBeInstanceOf(ClosedPeriodError);
    expect(await totalChargeCount()).toBe(0);
  });

  it("RT3: flag OFF into a frozen owner-month → rent still posts (byte-identical)", async () => {
    await seed();
    await seedFrozenPeriod();
    setLedgerFlag(false); // guard no-ops when the live-ledger flag is dark
    try {
      const r = await postRent();
      expect(r.created).toBe(true);
      expect(await rentChargeCount()).toBe(1);
    } finally {
      setLedgerFlag(true);
    }
  });

  it("RT4: owner-less unit (Listing.ownerPartyId null) + flag ON → rent still posts (guard has no owner to freeze)", async () => {
    await seed({ withOwner: false });
    // No owner ⇒ no OwnerStatementPeriod can gate this rent; the guard skips.
    const r = await postRent();
    expect(r.created).toBe(true);
    expect(await rentChargeCount()).toBe(1);
  });

  it("RT5: cron DRAFT rent + frozen owner-month + flag ON → existing draft flips draft→posted, NO throw (create-only scope)", async () => {
    await seed();
    await seedFrozenPeriod();
    await seedDraftRent();
    // The helper takes the existing-row (draft) branch and flips draft→posted; it
    // NEVER reaches the create-branch guard, so a frozen month does not block the flip.
    // This LOCKS the deliberate CREATE-only scope: the sole caller (meter/service.ts)
    // already pre-guards the whole posting at apartment level before this flip is reached.
    const r = await postRent();
    expect(r.created).toBe(false); // reconciled the existing draft, did not create
    expect(await totalChargeCount()).toBe(1);
    const ch = await getDb().charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "rent" } });
    expect(ch.status).toBe("posted");
  });

  it("RT6: zero-amount month (tenancy starts after it) + frozen + flag ON → no throw, created:false (guard sits AFTER the zero-amount return)", async () => {
    await seed({ startDate: "2026-08-01" }); // June is entirely before the tenancy start ⇒ RM0 rent
    await seedFrozenPeriod();
    // RM0 rent has no owner impact, so the early return fires BEFORE the guard — a
    // frozen month must NOT reject a month the tenancy does not even occupy.
    const r = await postRent();
    expect(r.created).toBe(false);
    expect(await totalChargeCount()).toBe(0);
  });

  it("RT7: a DIFFERENT month is frozen (May), post June + flag ON → June posts (period is keyed per-month)", async () => {
    await seed();
    await seedFrozenPeriod({ month: new Date(Date.UTC(2026, 4, 1)) }); // freeze MAY, not June
    const r = await postRent(); // posts JUNE
    expect(r.created).toBe(true);
    expect(await rentChargeCount()).toBe(1);
  });

  it("RT8: June frozen for a DIFFERENT owner + flag ON → this unit's rent still posts (period is keyed per-owner)", async () => {
    await seed();
    await getDb().party.create({ data: { id: OTHER_OWNER, organizationId: ORG, displayName: "Other Owner", partyType: "individual", status: "active" } });
    await seedFrozenPeriod({ ownerPartyId: OTHER_OWNER }); // freeze June for OTHER_OWNER, not this unit's OWNER
    const r = await postRent();
    expect(r.created).toBe(true);
    expect(await rentChargeCount()).toBe(1);
  });

  it("RT9: post in OPEN, then freeze, then re-post + flag ON → idempotent no-op (created:false), NO throw (guard gates creation, never a replay of surfaced income)", async () => {
    await seed();
    const first = await postRent(); // OPEN → creates posted rent
    expect(first.created).toBe(true);
    await seedFrozenPeriod(); // the month is now frozen
    const replay = await postRent(); // existing POSTED row ⇒ no-op, must NOT throw
    expect(replay.created).toBe(false);
    expect(await rentChargeCount()).toBe(1);
  });
});
