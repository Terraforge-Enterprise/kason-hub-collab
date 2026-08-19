/**
 * runFreezeOwnerStatementsCron — month-end owner-statement freeze cron (Task 6).
 * Integration test against a real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * BEHAVIOR INVENTORY (RED before the cron exists → GREEN after):
 *   - flag ON: freezes the JUST-ENDED month (now 2026-07-01 → "2026-06") for every
 *     owner with ACTIVE ledger activity — the COMBINED scope (apartmentId null) AND
 *     each distinct per-unit apartmentId; frozen ≥ 1, ranOrgs ≥ 1.
 *   - idempotent: a second run creates NO new OwnerStatementPeriod rows (re-run no-op).
 *   - flag OFF: returns {ranOrgs:0,frozen:0,skipped:0} and touches NOTHING (the guard
 *     returns BEFORE getDb() — mirrors auto-draft-invoices.ts).
 *   - resilient (Deliverable B, serial): a freeze that THROWS for one owner is counted
 *     in `skipped` and NEVER aborts the batch — the other owners still freeze.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/cron/__tests__/freeze-owner-statements.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "@kason/db";

// The poisoned owner whose freeze the mock below forces to throw — proves the cron's
// per-freeze try/catch isolates ONE failure (skipped++) without aborting the batch.
const POISON_OWNER = "7a160000-0000-4000-8000-0000000000f1";

// A whole ORG whose resolveSystemActor throws — proves the cron's per-ORG try/catch
// isolates one org's org-level failure (skipped++) without aborting the whole sweep.
// (Created only inside the org-level test so the other tests never sweep it.)
const BAD_ORG = "7a160000-0000-4000-8000-000000000005";

// An owner whose COMBINED freeze (apartmentId null) throws but whose PER-UNIT freeze
// would succeed — proves the combined-scope invariant: a combined-freeze failure must
// SKIP that owner's per-unit freezes, never leaving a per-unit frozen without its
// combined sibling (the orphan the guard/reconciliation, both combined-scope, cannot see).
const COMBINED_POISON_OWNER = "7a160000-0000-4000-8000-0000000000f3";

// Stub the two EXTERNAL leaf deps of the freeze's post-commit PDF step so nothing
// here needs a real browser or a real Storage write. The cron seed below creates NO
// owner_statement Invoice, so the PDF step no-ops anyway; these are defensive.
vi.mock("../../lib/document-templates/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/document-templates/pdf")>();
  return { ...actual, htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub\n")) };
});
vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return { ...actual, putObject: vi.fn(async () => undefined) };
});
// Delegate to the REAL freeze for every scope EXCEPT the poisoned owner (whose freeze
// throws). The happy-path owner therefore exercises the genuine freeze through the
// cron; only POISON_OWNER simulates a failure.
vi.mock("../../modules/owner-billing/owner-statement-period.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/owner-billing/owner-statement-period.service")>();
  return {
    ...actual,
    freezeStatementPeriod: vi.fn(
      async (
        ctx: Parameters<typeof actual.freezeStatementPeriod>[0],
        scope: Parameters<typeof actual.freezeStatementPeriod>[1],
      ) => {
        if (scope.ownerPartyId === POISON_OWNER) {
          throw new Error("simulated freeze failure (POISON_OWNER)");
        }
        // COMBINED_POISON_OWNER: only the COMBINED scope (apartmentId null/empty) throws;
        // its per-unit freeze delegates to the real freeze and WOULD succeed — so a cron
        // that ignored the invariant would orphan the per-unit period.
        if (scope.ownerPartyId === COMBINED_POISON_OWNER && !scope.apartmentId) {
          throw new Error("simulated COMBINED freeze failure (COMBINED_POISON_OWNER)");
        }
        return actual.freezeStatementPeriod(ctx, scope);
      },
    ),
  };
});
// Delegate to the REAL resolveSystemActor for every org EXCEPT BAD_ORG, whose
// resolution THROWS. This simulates a transient DB/infra failure in the per-ORG body
// (resolveSystemActor / owner-enumeration) — the failure mode the per-org try/catch
// must isolate so it can't abort the whole month-end sweep.
vi.mock("../../modules/billing/auto-draft.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../modules/billing/auto-draft.repository")>();
  return {
    ...actual,
    resolveSystemActor: vi.fn(async (orgId: string) => {
      if (orgId === BAD_ORG) {
        throw new Error("simulated org-level failure (BAD_ORG resolveSystemActor)");
      }
      return actual.resolveSystemActor(orgId);
    }),
  };
});

import { runFreezeOwnerStatementsCron } from "../freeze-owner-statements";
import { freezeStatementPeriod } from "../../modules/owner-billing/owner-statement-period.service";
import { resolveSystemActor } from "../../modules/billing/auto-draft.repository";

const FLAG = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";

// ── Safety guard — never run against a non-local DB ─────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix 7a16; unused by any other suite) ───────────────
const ORG = "7a160000-0000-4000-8000-000000000001";
const GOOD_OWNER = "7a160000-0000-4000-8000-000000000002";
const PROPERTY = "7a160000-0000-4000-8000-000000000003";
const ADMIN = "7a160000-0000-4000-8000-000000000004"; // User(role=admin) → resolveSystemActor
const APT_A = "7a160000-0000-4000-8000-0000000000a1";
const L_A = "7a160000-0000-4000-8000-0000000000a2";
const APT_P = "7a160000-0000-4000-8000-0000000000f2"; // poison owner's per-unit apartment
const APT_CP = "7a160000-0000-4000-8000-0000000000f4"; // combined-poison owner's per-unit apt
const L_CP = "7a160000-0000-4000-8000-0000000000f5"; // combined-poison owner's listing

const JUNE_FIRST = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01 (the just-ended month)
const JULY_1 = new Date(Date.UTC(2026, 6, 1)); // now → endedMonth "2026-06"
const JUNE_M = "2026-06";

async function insertEntry(o: {
  ownerPartyId: string;
  apartmentId: string;
  amount: string;
  transactionDate: Date;
}) {
  return getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: o.ownerPartyId,
      propertyId: PROPERTY,
      apartmentId: o.apartmentId,
      statementMonth: JUNE_FIRST,
      transactionDate: o.transactionDate,
      direction: "income",
      category: "rental_income",
      amount: o.amount,
      sstAmount: null,
      paidBy: "kaen",
      paymentStatus: "paid",
      taxCategory: "not_applicable",
      includeInPayout: false,
      attachmentKeys: [],
      sourceType: "manual",
      status: "active",
      createdById: ADMIN,
      updatedById: ADMIN,
    },
  });
}

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
  // The org-level-failure test's disposable second org (no children).
  await db.organization.deleteMany({ where: { id: BAD_ORG } });
}

let priorFlag: string | undefined;

dn("runFreezeOwnerStatementsCron (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();

    await db.organization.create({
      data: {
        id: ORG,
        name: "7A16 Freeze Cron Org",
        slug: "7a16-freeze-cron-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    // The admin User resolveSystemActor picks up (earliest-created admin in the org).
    await db.user.create({
      data: {
        id: ADMIN,
        organizationId: ORG,
        email: "freeze-cron-admin@example.com",
        fullName: "Freeze Cron Admin",
        status: "active",
        role: "admin",
      },
    });
    await db.party.create({
      data: { id: GOOD_OWNER, organizationId: ORG, displayName: "Good Owner", partyType: "individual", status: "active" },
    });
    await db.party.create({
      data: { id: POISON_OWNER, organizationId: ORG, displayName: "Poison Owner", partyType: "individual", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: "Freeze Cron Property",
        propertyCode: "7A16-P1",
        propertyType: "apartment",
        addressLine1: "1 Cron St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT_A, organizationId: ORG, propertyId: PROPERTY, unitCode: "A-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L_A,
        organizationId: ORG,
        apartmentId: APT_A,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: GOOD_OWNER,
      },
    });

    // Good owner — two settled June income rows on APT_A (opening 0, net 2300).
    await insertEntry({ ownerPartyId: GOOD_OWNER, apartmentId: APT_A, amount: "1500.00", transactionDate: new Date(Date.UTC(2026, 5, 3)) });
    await insertEntry({ ownerPartyId: GOOD_OWNER, apartmentId: APT_A, amount: "800.00", transactionDate: new Date(Date.UTC(2026, 5, 5)) });
    // Poison owner — June activity so the cron ATTEMPTS a freeze for it (combined +
    // per-unit); the mock forces those freezes to throw.
    await insertEntry({ ownerPartyId: POISON_OWNER, apartmentId: APT_P, amount: "999.00", transactionDate: new Date(Date.UTC(2026, 5, 7)) });

    // Combined-poison owner — a real per-unit (APT_CP) that WOULD freeze successfully,
    // but whose COMBINED freeze the mock forces to throw. Full seed (party/apt/listing/
    // June entry) so the per-unit freeze genuinely succeeds when attempted; the invariant
    // fix is what must stop it from being attempted after the combined freeze fails.
    await db.party.create({
      data: { id: COMBINED_POISON_OWNER, organizationId: ORG, displayName: "Combined Poison Owner", partyType: "individual", status: "active" },
    });
    await db.apartment.create({
      data: { id: APT_CP, organizationId: ORG, propertyId: PROPERTY, unitCode: "CP-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L_CP, organizationId: ORG, apartmentId: APT_CP, listingType: "whole",
        occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: COMBINED_POISON_OWNER,
      },
    });
    await insertEntry({ ownerPartyId: COMBINED_POISON_OWNER, apartmentId: APT_CP, amount: "500.00", transactionDate: new Date(Date.UTC(2026, 5, 9)) });
  });

  afterAll(cleanup);

  beforeEach(async () => {
    priorFlag = process.env[FLAG];
    process.env[FLAG] = "1";
    vi.clearAllMocks();
    await getDb().ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
  });

  afterEach(() => {
    if (priorFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = priorFlag;
  });

  const goodPeriodCount = () =>
    getDb().ownerStatementPeriod.count({
      where: { organizationId: ORG, ownerPartyId: GOOD_OWNER, periodMonth: JUNE_FIRST },
    });

  it("freezes the just-ended month (June) — combined + per-unit — for an owner with activity", async () => {
    const r = await runFreezeOwnerStatementsCron(JULY_1);

    expect(r.ranOrgs).toBeGreaterThanOrEqual(1);
    expect(r.frozen).toBeGreaterThanOrEqual(2); // good owner: combined + APT_A per-unit

    // Combined (apartmentId null) frozen period for the good owner.
    const combined = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: GOOD_OWNER, apartmentId: null, periodMonth: JUNE_FIRST },
    });
    expect(combined).not.toBeNull();
    expect(combined!.status).toBe("frozen");
    expect(combined!.idempotencyKey).toBe(`ownerstmt:${GOOD_OWNER}:${JUNE_M}`);
    expect(combined!.closingBalanceC).toBe(230000); // 1500 + 800

    // Per-unit (apartmentId APT_A) frozen period for the good owner.
    const perUnit = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: GOOD_OWNER, apartmentId: APT_A, periodMonth: JUNE_FIRST },
    });
    expect(perUnit).not.toBeNull();
    expect(perUnit!.idempotencyKey).toBe(`ownerstmt:${GOOD_OWNER}:${JUNE_M}:${APT_A}`);
  });

  it("is idempotent — a second run creates no new OwnerStatementPeriod rows", async () => {
    await runFreezeOwnerStatementsCron(JULY_1);
    const afterFirst = await goodPeriodCount();
    expect(afterFirst).toBe(2); // combined + per-unit

    await runFreezeOwnerStatementsCron(JULY_1);
    const afterSecond = await goodPeriodCount();
    expect(afterSecond).toBe(afterFirst); // no duplicates — re-run is a no-op
  });

  it("flag OFF → returns {ranOrgs:0,frozen:0,skipped:0} and freezes nothing", async () => {
    delete process.env[FLAG];

    const r = await runFreezeOwnerStatementsCron(JULY_1);
    // Task 2 (auto-issue) extended the return shape with issued/issueFailed, and the
    // 2026-08-01 month-end pipeline added approved/approveFailed/syncBlocked. ALL are
    // 0 on this branch: the flag guard returns before ANY per-scope work — before the
    // auto-issue, before the auto-approve, and before the sync-failure gate ever
    // queries AuditLog.
    expect(r).toEqual({
      ranOrgs: 0, frozen: 0, skipped: 0, issued: 0, issueFailed: 0,
      approved: 0, approveFailed: 0, syncBlocked: 0,
    });

    // The real freeze was never invoked and no period rows were written.
    expect(vi.mocked(freezeStatementPeriod)).not.toHaveBeenCalled();
    expect(await goodPeriodCount()).toBe(0);
  });

  it("resilient — a freeze that throws for one owner is skipped, not aborted (the rest freeze)", async () => {
    const r = await runFreezeOwnerStatementsCron(JULY_1);

    // Poison owner: combined + per-unit both threw → skipped ≥ 2. The good owner still froze.
    expect(r.skipped).toBeGreaterThanOrEqual(2);
    expect(r.frozen).toBeGreaterThanOrEqual(2);
    // The good owner's periods exist despite the poison owner failing (batch not aborted).
    expect(await goodPeriodCount()).toBe(2);
    // The cron ATTEMPTED a freeze for the poison owner (proving it did not stop early).
    const attemptedPoison = vi
      .mocked(freezeStatementPeriod)
      .mock.calls.some(([, scope]) => scope.ownerPartyId === POISON_OWNER);
    expect(attemptedPoison).toBe(true);
  });

  it("resilient at ORG level — an org whose resolveSystemActor throws is skipped, not aborted (later orgs still freeze)", async () => {
    // Add a SECOND org whose resolveSystemActor THROWS (mock above). With the per-org
    // body unwrapped, that throw propagates out of `for (const org of orgs)` and rejects
    // the whole sweep — so `await` here throws (RED) and the good org never freezes.
    // Wrapped, the bad org is caught (skipped++), the sweep continues, the good org freezes.
    await getDb().organization.create({
      data: {
        id: BAD_ORG,
        name: "7A16 Freeze Cron Bad Org",
        slug: "7a16-freeze-cron-bad-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    try {
      // RED: unwrapped code rejects here (the bad org's throw aborts the sweep).
      const r = await runFreezeOwnerStatementsCron(JULY_1);

      // The good org still froze despite the other org's org-level failure — order-independent:
      // wrapped code attempts every org, so the good org's periods exist regardless of sweep order.
      expect(await goodPeriodCount()).toBe(2); // combined + per-unit
      // The failing org is counted in `skipped` (org-level skip), never silently dropped.
      expect(r.skipped).toBeGreaterThanOrEqual(1);
      // Proof the cron actually reached (and continued past) the failing org.
      const attemptedBadOrg = vi
        .mocked(resolveSystemActor)
        .mock.calls.some(([orgId]) => orgId === BAD_ORG);
      expect(attemptedBadOrg).toBe(true);
    } finally {
      await getDb().organization.deleteMany({ where: { id: BAD_ORG } });
    }
  });

  it("prevention — a combined-freeze failure skips that owner's per-unit freezes (no orphan); other owners still freeze", async () => {
    const r = await runFreezeOwnerStatementsCron(JULY_1);

    // The combined-poison owner's COMBINED freeze threw → it is NOT frozen.
    const cpCombined = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: COMBINED_POISON_OWNER, apartmentId: null, periodMonth: JUNE_FIRST },
    });
    expect(cpCombined).toBeNull();

    // INVARIANT (the fix): with the combined freeze failed, the owner's per-unit period
    // must NOT be frozen — never a per-unit frozen without its combined sibling. Under the
    // old code the per-unit freeze still ran and SUCCEEDED, orphaning the per-unit period.
    const cpPerUnit = await getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: COMBINED_POISON_OWNER, apartmentId: APT_CP, periodMonth: JUNE_FIRST },
    });
    expect(cpPerUnit).toBeNull();

    // Per-owner isolation preserved: the good owner still froze combined + per-unit.
    expect(await goodPeriodCount()).toBe(2);

    // Pin the SKIP behavior directly (robust to the cron's whole-DB org sweep, which makes
    // the aggregate `skipped` count depend on unrelated orgs — hence `>=`): the per-unit
    // freeze for the combined-poison owner was NEVER ATTEMPTED after its combined failed.
    // Under the old code it was attempted (and succeeded), orphaning the per-unit period.
    const attemptedCpPerUnit = vi
      .mocked(freezeStatementPeriod)
      .mock.calls.some(([, scope]) => scope.ownerPartyId === COMBINED_POISON_OWNER && scope.apartmentId === APT_CP);
    expect(attemptedCpPerUnit).toBe(false);
    // The cron DID attempt the combined freeze (proving it reached this owner, then skipped
    // the per-unit because the combined threw — not that it never processed the owner).
    const attemptedCpCombined = vi
      .mocked(freezeStatementPeriod)
      .mock.calls.some(([, scope]) => scope.ownerPartyId === COMBINED_POISON_OWNER && !scope.apartmentId);
    expect(attemptedCpCombined).toBe(true);

    // The combined-poison owner still contributes to `skipped` (combined + its skipped
    // per-unit), never silently dropped (aggregate is whole-DB, so a lower-bound check).
    expect(r.skipped).toBeGreaterThanOrEqual(2);
  });
});
