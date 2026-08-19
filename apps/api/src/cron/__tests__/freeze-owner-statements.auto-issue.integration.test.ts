/**
 * runFreezeOwnerStatementsCron — Task 2 auto-issue (month-close auto-mint owner
 * statements). Integration test against a real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Task 2 extends the freeze cron so that, when ENABLE_OWNER_STATEMENT_AUTO_ISSUE is
 * ON, the owner's COMBINED scope is auto-ISSUED — generateStatementService mints the
 * statement Invoice + mgmt/cleaning Charges — immediately BEFORE that scope is frozen,
 * so the freeze's post-commit PDF-attach step finds the fresh Invoice.
 * generateStatementService is idempotent (existing non-void statement ⇒ returned
 * as-is), so a second cron run never duplicates the Invoice.
 *
 * COMBINED-SCOPE ONLY (post-panel-review fix, 2026-07-24): auto-issue never attempts a
 * per-unit scope. The original combined+per-unit design was deterministically broken:
 * a per-unit statement is a strict subset of the combined one, so its
 * generateStatementService call would find every charge already minted by the combined
 * call and return an empty 0.00 Invoice — and because assertPeriodOpen
 * (owner-ledger/assert-period-open.ts) checks ONLY the combined-scope
 * (apartmentId: null) OwnerStatementPeriod for {owner, month}, and the combined freeze
 * commits before any per-unit scope is reached, that call would ALSO deterministically
 * throw ClosedPeriodError on EVERY per-unit scope, EVERY run — an issueFailed++ +
 * console.error flood (~1000 lines/run in prod) with no diagnostic value. Dropping the
 * per-unit attempt loses nothing: the per-unit FREEZE still snapshots the ledger
 * correctly from the already-synced combined ledger (unchanged, still exercised below).
 *
 * Auto-issue is also gated to a STRICTLY-PAST billing month (checked against the REAL
 * wall clock, not the injected `now` param — see freeze-owner-statements.ts). Not
 * separately exercised here: this suite's fixed MAY_FIRST/JUNE_1 fixture is already
 * strictly past relative to any real run date this suite executes on.
 *
 * Fixture month choice (2026-05, NOT 2026-06/07): the cron sweeps EVERY organization
 * in the DB, not just this suite's own — and this is a real (opt-in, local-only)
 * Postgres, not a per-test-isolated one. At the time this fixture was chosen, every
 * OTHER OwnerLedgerEntry row anywhere in the local dev DB was dated 2026-06 or 2026-07
 * (including a real, non-fixture org with an already-FROZEN 2026-06 combined period —
 * its generateStatementService call would deterministically ClosedPeriodError forever,
 * independent of anything this file tests). 2026-05 has zero ambient rows anywhere,
 * so result.issued/result.issueFailed below are driven ENTIRELY by this suite's own
 * seed — no other org can contribute noise. If this ever flakes, re-check for ambient
 * OwnerLedgerEntry rows in 2026-05 across the whole DB, not just this suite's org.
 *
 * BEHAVIOR INVENTORY (RED before Task 2 exists → GREEN after; RE-PINNED post-fix):
 *   - flag ON: auto-mints a NON-VOID combined owner-statement Invoice for {owner,
 *     month} where NONE existed before the run; result.issued === 1 (combined only);
 *     result.issueFailed === 0 (no per-unit attempt ⇒ no ClosedPeriodError); the frozen
 *     combined OwnerStatementPeriod carries a pdfKey (PDF attached from the fresh
 *     Invoice — htmlToPdf/putObject are mocked so this is deterministic, no real
 *     Chromium/browser needed). The per-unit scope still FREEZES (unchanged) with no
 *     Invoice / pdfKey of its own (generate was never attempted for it).
 *   - flag OFF: byte-identical parity — no owner-statement Invoice is minted at all
 *     (freeze-only, exactly pre-Task-2); the period still freezes; pdfKey stays null
 *     (no Invoice for the PDF step to find, exactly as today).
 *   - idempotent: running the cron TWICE (flag ON) mints exactly ONE non-void combined
 *     statement for {owner, month} — no duplicate.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/cron/__tests__/freeze-owner-statements.auto-issue.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "@kason/db";

// Stub the two EXTERNAL leaf deps of the freeze's post-commit PDF step (mirrors
// freeze-owner-statements.integration.test.ts) so pdfKey assertions are deterministic
// — no real Chromium/browser or real Storage write needed either way.
vi.mock("../../lib/document-templates/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/document-templates/pdf")>();
  return { ...actual, htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub\n")) };
});
vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return { ...actual, putObject: vi.fn(async () => undefined) };
});

import { runFreezeOwnerStatementsCron } from "../freeze-owner-statements";

const LIVE_LEDGER_FLAG = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";
const AUTO_ISSUE_FLAG = "ENABLE_OWNER_STATEMENT_AUTO_ISSUE";
const OWNER_BILLING_FLAG = "ENABLE_PHASE2_OWNER_BILLING";

// ── Safety guard — never run against a non-local DB ─────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixed disjoint UUIDs (prefix a151; unused by any other suite) ───────────────
const ORG = "a1510000-0000-4000-8000-000000000001";
const OWNER = "a1510000-0000-4000-8000-000000000002";
const PROPERTY = "a1510000-0000-4000-8000-000000000003";
const ADMIN = "a1510000-0000-4000-8000-000000000004";
const APT = "a1510000-0000-4000-8000-0000000000a1";
const L_A = "a1510000-0000-4000-8000-0000000000a2";
const TENANT = "a1510000-0000-4000-8000-0000000000a3";
const TENANCY = "a1510000-0000-4000-8000-0000000000a4";

const MAY_FIRST = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01 (the just-ended month; deliberately ambient-clean — see file header)
const JUNE_1 = new Date(Date.UTC(2026, 5, 1)); // now → endedMonth "2026-05"

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

let priorLiveLedger: string | undefined;
let priorAutoIssue: string | undefined;
let priorOwnerBilling: string | undefined;

dn("runFreezeOwnerStatementsCron — Task 2 auto-issue (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();

    await db.organization.create({
      data: {
        id: ORG,
        name: "A151 Auto-Issue Org",
        slug: "a151-auto-issue-org",
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
        email: "a151-admin@example.com",
        fullName: "A151 Admin",
        status: "active",
        role: "admin",
      },
    });
    await db.party.create({
      data: { id: OWNER, organizationId: ORG, displayName: "A151 Owner", partyType: "individual", status: "active" },
    });
    // findOwnerInOrg (generateStatementService's org/ownership gate) requires a
    // PartyRole(roleType:"owner") row, not just the Party.
    await db.partyRole.create({
      data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: "A151 Property",
        propertyCode: "A151-P1",
        propertyType: "apartment",
        addressLine1: "1 Auto-Issue St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT, organizationId: ORG, propertyId: PROPERTY, unitCode: "AI-1", listingMode: "WHOLE" },
    });
    await db.listing.create({
      data: {
        id: L_A,
        organizationId: ORG,
        apartmentId: APT,
        listingType: "whole",
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER,
      },
    });
    await db.party.create({
      data: { id: TENANT, organizationId: ORG, displayName: "A151 Tenant", partyType: "individual", status: "active" },
    });
    // An active Tenancy is what resolveOwnerUnitsForMonth reads to mark the unit
    // "occupied" (so generateStatementService writes a management_fee line).
    await db.tenancy.create({
      data: {
        id: TENANCY,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitId: L_A,
        tenantPartyId: TENANT,
        tenancyCode: "T-AI-1",
        status: "active",
        billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        monthlyRentAmount: "1500.00",
      },
    });

    // Mgmt-fee + cleaning config, so the auto-issued statement carries real lines
    // (mirrors owner-billing.generate.integration.test.ts's seed).
    const { createFeeConfigService } = await import("../../modules/owner-billing/owner-billing.service");
    const cfgResult = await createFeeConfigService(
      { orgId: ORG, actorUserId: ADMIN, actorRole: "admin" },
      { ownerPartyId: OWNER, feeType: "percent", feeValue: "10", sstPercent: "8", isActive: true },
    );
    if (!cfgResult.ok) throw new Error(`seed: createFeeConfigService failed: ${JSON.stringify(cfgResult)}`);

    // Paid rent ledger entry in the just-ended month — drives BOTH the cron's
    // owner-enumeration (finds this owner needs a freeze) and the freeze's balance.
    await db.ownerLedgerEntry.create({
      data: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        propertyId: PROPERTY,
        apartmentId: APT,
        statementMonth: MAY_FIRST,
        transactionDate: new Date(Date.UTC(2026, 4, 3)),
        direction: "income",
        category: "rental_income",
        amount: "1500.00",
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
  });

  afterAll(cleanup);

  beforeEach(async () => {
    priorLiveLedger = process.env[LIVE_LEDGER_FLAG];
    priorAutoIssue = process.env[AUTO_ISSUE_FLAG];
    priorOwnerBilling = process.env[OWNER_BILLING_FLAG];
    process.env[LIVE_LEDGER_FLAG] = "1";
    process.env[OWNER_BILLING_FLAG] = "1";
    vi.clearAllMocks();
    await getDb().ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
    await getDb().charge.deleteMany({ where: { organizationId: ORG } });
    await getDb().invoice.deleteMany({ where: { organizationId: ORG } });
  });

  afterEach(() => {
    if (priorLiveLedger === undefined) delete process.env[LIVE_LEDGER_FLAG];
    else process.env[LIVE_LEDGER_FLAG] = priorLiveLedger;
    if (priorAutoIssue === undefined) delete process.env[AUTO_ISSUE_FLAG];
    else process.env[AUTO_ISSUE_FLAG] = priorAutoIssue;
    if (priorOwnerBilling === undefined) delete process.env[OWNER_BILLING_FLAG];
    else process.env[OWNER_BILLING_FLAG] = priorOwnerBilling;
  });

  const findCombinedInvoice = () =>
    getDb().invoice.findFirst({
      where: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        invoiceType: "owner_statement",
        periodMonth: MAY_FIRST,
        status: { not: "void" },
      },
    });
  const findPerUnitInvoice = () =>
    getDb().invoice.findFirst({
      where: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: APT,
        invoiceType: "owner_statement",
        periodMonth: MAY_FIRST,
        status: { not: "void" },
      },
    });
  const findCombinedPeriod = () =>
    getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER, apartmentId: null, periodMonth: MAY_FIRST },
    });
  const findPerUnitPeriod = () =>
    getDb().ownerStatementPeriod.findFirst({
      where: { organizationId: ORG, ownerPartyId: OWNER, apartmentId: APT, periodMonth: MAY_FIRST },
    });

  it("flag ON: auto-mints a non-void combined owner-statement Invoice with NO pre-existing statement, and freezes it with a pdfKey attached", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";

    // Precondition — nothing minted yet.
    expect(await findCombinedInvoice()).toBeNull();

    const result = await runFreezeOwnerStatementsCron(JUNE_1);

    // The core auto-issue proof: a NON-VOID owner-statement Invoice now exists for
    // {owner, month} where none existed before the run.
    const combinedInvoice = await findCombinedInvoice();
    expect(combinedInvoice).not.toBeNull();
    expect(combinedInvoice!.status).not.toBe("void");
    // Combined-only (post-fix): this owner has one combined scope + one per-unit scope
    // (seeded via the APT ledger row) — issued counts ONLY the combined generate call.
    expect(result.issued).toBe(1);

    // The frozen combined period carries a pdfKey — the freeze's post-commit PDF
    // step found the freshly-minted Invoice (htmlToPdf/putObject mocked above, so
    // this is deterministic and does not depend on a real Chromium being installed).
    const combinedPeriod = await findCombinedPeriod();
    expect(combinedPeriod).not.toBeNull();
    expect(combinedPeriod!.status).toBe("frozen");
    expect(combinedPeriod!.pdfKey).not.toBeNull();

    // COMBINED-SCOPE ONLY (see file header): the per-unit scope is never attempted for
    // auto-issue, so there is no ClosedPeriodError and no issueFailed flood —
    // issueFailed must be exactly 0. The per-unit period still FREEZES on its own
    // (unchanged; generate was never in its path), with no Invoice ever attempted.
    expect(result.issueFailed).toBe(0);
    const perUnitPeriod = await findPerUnitPeriod();
    expect(perUnitPeriod).not.toBeNull();
    expect(perUnitPeriod!.status).toBe("frozen"); // still freezes — freeze path is unchanged
    expect(await findPerUnitInvoice()).toBeNull(); // ...and no Invoice was ever attempted for it
  });

  it("flag OFF: parity — no owner-statement Invoice is minted at all, but the period still freezes (byte-identical to pre-Task-2)", async () => {
    delete process.env[AUTO_ISSUE_FLAG];

    const result = await runFreezeOwnerStatementsCron(JUNE_1);

    expect(await findCombinedInvoice()).toBeNull();
    expect(await findPerUnitInvoice()).toBeNull();
    expect(result.issued).toBe(0);
    expect(result.issueFailed).toBe(0);

    const combinedPeriod = await findCombinedPeriod();
    expect(combinedPeriod).not.toBeNull();
    expect(combinedPeriod!.status).toBe("frozen");
    // No Invoice existed at freeze time → the PDF step no-ops (pdfKey stays null),
    // exactly as it does today for every owner with no manually-issued statement.
    expect(combinedPeriod!.pdfKey).toBeNull();
  });

  it("idempotent: running the cron TWICE (flag ON) mints exactly ONE non-void combined statement for {owner, month} — no duplicate", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";

    const first = await runFreezeOwnerStatementsCron(JUNE_1);
    const firstInvoice = await findCombinedInvoice();
    expect(firstInvoice).not.toBeNull();
    expect(first.issued).toBeGreaterThanOrEqual(1);

    const second = await runFreezeOwnerStatementsCron(JUNE_1);

    // Idempotent: generateStatementService returns the SAME existing invoice on the
    // second run (ok:true, status 200) — still counted as `issued` (a statement now
    // exists at freeze time either way), but no NEW row is created.
    expect(second.issued).toBeGreaterThanOrEqual(1);

    const combinedCount = await getDb().invoice.count({
      where: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        apartmentId: null,
        invoiceType: "owner_statement",
        periodMonth: MAY_FIRST,
        status: { not: "void" },
      },
    });
    expect(combinedCount).toBe(1);

    const secondInvoice = await findCombinedInvoice();
    expect(secondInvoice!.id).toBe(firstInvoice!.id); // same row, not a duplicate
  });
});
