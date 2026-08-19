/**
 * The month-end owner-statement pipeline (2026-08-01) — integration test against a
 * real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *
 * Covers the three pieces that turned "a freeze cron" into "the whole month-end
 * pipeline", after the manual Issue/Approve/Send buttons were removed from the UI:
 *
 *   1. AUTO-APPROVE (freeze cron). An auto-issued statement lands as `draft`, and
 *      draft reaches nobody — the owner portal excludes it and sendStatementService
 *      refuses it. So the cron now approves each auto-issued combined statement,
 *      which also renders Invoice.pdfKey. Without this the send cron below has
 *      literally nothing to send.
 *
 *   2. SYNC-FAILURE GATE (freeze cron) — pre-enablement blocker #1.
 *      generateStatementService's post-commit owner-ledger sync SWALLOWS its errors.
 *      Before the gate, auto-issue → sync → freeze ran in ONE iteration, so a
 *      transient sync failure froze an OVER-STATED payout permanently (freezing is
 *      terminal; a frozen month refuses rebuild). The gate withholds the freeze for
 *      any owner whose sync failed during the run. Exercised END-TO-END by making
 *      the real sync throw, so the real hook writes the real `owner_ledger.sync_failed`
 *      AuditLog marker that the real gate then reads — no stubbing of the gate itself.
 *
 *   3. SEND CRON (send-owner-statements.ts). Threshold scheduling in the ORG'S OWN
 *      timezone: due once local time passes (ownerStatementSendDay,
 *      ownerStatementSendHour) of the month AFTER the billing month, and STAYS due,
 *      so a missed run sends late rather than dropping the month.
 *
 * Fixture month choice (2026-03): the crons sweep EVERY organization in the DB, not
 * just this suite's, and this is a shared local Postgres. 2026-05/06/07 already carry
 * ambient rows from other suites and real dev data. 2026-03 is chosen to be
 * ambient-clean so the returned counters are driven ONLY by this suite's seed. If
 * this ever flakes, re-check for ambient OwnerLedgerEntry / Invoice rows in 2026-03
 * across the WHOLE DB, not just this suite's org.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   cd apps/api && RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/cron/__tests__/owner-statement-month-end-pipeline.integration.test.ts --no-coverage
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "@kason/db";

// Stub the EXTERNAL leaf deps of the PDF step (mirrors the sibling freeze suites) so
// pdfKey assertions are deterministic — no real Chromium and no real Storage write.
vi.mock("../../lib/document-templates/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/document-templates/pdf")>();
  return { ...actual, htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub\n")) };
});
vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return {
    ...actual,
    putObject: vi.fn(async () => undefined),
    createSignedDownloadUrl: vi.fn(async () => "https://example.test/signed.pdf"),
  };
});

// The owner-ledger sync is mocked ONLY so test 2 can make it throw on demand. Every
// other test keeps the real implementation via the passthrough default, so the
// auto-approve and send paths run against real ledger behaviour.
const syncShouldThrow = { value: false };
vi.mock("../../modules/owner-ledger/owner-ledger.sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/owner-ledger/owner-ledger.sync")>();
  return {
    ...actual,
    syncMonthService: vi.fn(async (...args: Parameters<typeof actual.syncMonthService>) => {
      if (syncShouldThrow.value) throw new Error("simulated transient owner-ledger sync failure");
      return actual.syncMonthService(...args);
    }),
  };
});

import { runFreezeOwnerStatementsCron } from "../freeze-owner-statements";
import { runSendOwnerStatementsCron } from "../send-owner-statements";

const LIVE_LEDGER_FLAG = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";
const AUTO_ISSUE_FLAG = "ENABLE_OWNER_STATEMENT_AUTO_ISSUE";
const AUTO_SEND_FLAG = "ENABLE_OWNER_STATEMENT_AUTO_SEND";
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

// ── Fixed disjoint UUIDs (prefix a152; unused by any other suite) ───────────────
const ORG = "a1520000-0000-4000-8000-000000000001";
const OWNER = "a1520000-0000-4000-8000-000000000002";
const PROPERTY = "a1520000-0000-4000-8000-000000000003";
const ADMIN = "a1520000-0000-4000-8000-000000000004";
const APT = "a1520000-0000-4000-8000-0000000000a1";
const L_A = "a1520000-0000-4000-8000-0000000000a2";
const TENANT = "a1520000-0000-4000-8000-0000000000a3";
const TENANCY = "a1520000-0000-4000-8000-0000000000a4";

const MARCH_FIRST = new Date(Date.UTC(2026, 2, 1)); // billing month 2026-03
/** now → endedMonth "2026-03". 09:00 UTC = 17:00 MYT, past a 09:00 local send hour. */
const APRIL_3_MYT_AFTERNOON = new Date(Date.UTC(2026, 3, 3, 9, 0, 0));
/** Same month, BEFORE a sendDay of 3 in MYT. */
const APRIL_1_MYT = new Date(Date.UTC(2026, 3, 1, 2, 0, 0));

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
let priorAutoSend: string | undefined;
let priorOwnerBilling: string | undefined;

/** Seed the ledger row that drives owner-enumeration + the freeze balance. */
async function seedLedgerRow() {
  await getDb().ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROPERTY,
      apartmentId: APT,
      statementMonth: MARCH_FIRST,
      transactionDate: new Date(Date.UTC(2026, 2, 3)),
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
}

const findCombinedInvoice = () =>
  getDb().invoice.findFirst({
    where: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: null,
      invoiceType: "owner_statement",
      periodMonth: MARCH_FIRST,
      status: { not: "void" },
    },
  });

dn("owner-statement month-end pipeline (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    const db = getDb();

    await db.organization.create({
      data: {
        id: ORG,
        name: "A152 Pipeline Org",
        slug: "a152-pipeline-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
        // Explicit rather than relying on the column defaults, so the scheduling
        // assertions below stay true even if the defaults are ever retuned.
        ownerStatementSendDay: 3,
        ownerStatementSendHour: 9,
      },
    });
    await db.user.create({
      data: {
        id: ADMIN,
        organizationId: ORG,
        email: "a152-admin@example.com",
        fullName: "A152 Admin",
        status: "active",
        role: "admin",
      },
    });
    await db.party.create({
      data: { id: OWNER, organizationId: ORG, displayName: "A152 Owner", partyType: "individual", status: "active" },
    });
    await db.partyRole.create({
      data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
    });
    await db.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: "A152 Property",
        propertyCode: "A152-P1",
        propertyType: "apartment",
        addressLine1: "1 Pipeline St",
        city: "KL",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: { id: APT, organizationId: ORG, propertyId: PROPERTY, unitCode: "PL-1", listingMode: "WHOLE" },
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
      data: { id: TENANT, organizationId: ORG, displayName: "A152 Tenant", partyType: "individual", status: "active" },
    });
    await db.tenancy.create({
      data: {
        id: TENANCY,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitId: L_A,
        tenantPartyId: TENANT,
        tenancyCode: "T-PL-1",
        status: "active",
        billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        monthlyRentAmount: "1500.00",
      },
    });

    const { createFeeConfigService } = await import("../../modules/owner-billing/owner-billing.service");
    const cfg = await createFeeConfigService(
      { orgId: ORG, actorUserId: ADMIN, actorRole: "admin" },
      { ownerPartyId: OWNER, feeType: "percent", feeValue: "10", sstPercent: "8", isActive: true },
    );
    if (!cfg.ok) throw new Error(`seed: createFeeConfigService failed: ${JSON.stringify(cfg)}`);
  });

  afterAll(cleanup);

  beforeEach(async () => {
    priorLiveLedger = process.env[LIVE_LEDGER_FLAG];
    priorAutoIssue = process.env[AUTO_ISSUE_FLAG];
    priorAutoSend = process.env[AUTO_SEND_FLAG];
    priorOwnerBilling = process.env[OWNER_BILLING_FLAG];
    process.env[LIVE_LEDGER_FLAG] = "1";
    process.env[OWNER_BILLING_FLAG] = "1";
    syncShouldThrow.value = false;
    vi.clearAllMocks();

    const db = getDb();
    await db.ownerStatementPeriod.deleteMany({ where: { organizationId: ORG } });
    await db.charge.deleteMany({ where: { organizationId: ORG } });
    await db.invoice.deleteMany({ where: { organizationId: ORG } });
    await db.auditLog.deleteMany({ where: { organizationId: ORG } });
    await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
    await seedLedgerRow();
  });

  afterEach(() => {
    syncShouldThrow.value = false;
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore(LIVE_LEDGER_FLAG, priorLiveLedger);
    restore(AUTO_ISSUE_FLAG, priorAutoIssue);
    restore(AUTO_SEND_FLAG, priorAutoSend);
    restore(OWNER_BILLING_FLAG, priorOwnerBilling);
  });

  // ── 1. Auto-approve ─────────────────────────────────────────────────────────

  it("auto-issues AND auto-approves the combined statement, rendering its pdfKey", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";

    const r = await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    expect(r.issued).toBe(1);
    expect(r.approved).toBe(1);
    expect(r.approveFailed).toBe(0);

    const inv = await findCombinedInvoice();
    // `approved` + a pdfKey is EXACTLY the precondition sendStatementService demands.
    // A draft here would mean nothing can ever be sent and the owner portal (which
    // excludes draft) shows the owner nothing.
    expect(inv?.status).toBe("approved");
    expect(inv?.pdfKey).toBeTruthy();
  });

  it("auto-approve is idempotent — a second run does not fail on the already-approved statement", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";

    await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);
    const second = await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    // The re-run finds the statement already approved. approveStatementService
    // answers 409 STATEMENT_NOT_APPROVABLE, which is the expected steady state and
    // must NOT be counted as a failure.
    expect(second.approveFailed).toBe(0);
    expect(second.approved).toBe(0);
    expect(await getDb().invoice.count({
      where: { organizationId: ORG, invoiceType: "owner_statement", status: { not: "void" } },
    })).toBe(1);
  });

  // ── 2. Sync-failure gate (pre-enablement blocker #1) ────────────────────────

  it("withholds the freeze when the owner-ledger sync fails during the run", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";
    syncShouldThrow.value = true;

    const r = await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    // The real hook swallowed the throw and wrote a real drift marker...
    const markers = await getDb().auditLog.count({
      where: { organizationId: ORG, action: "owner_ledger.sync_failed" },
    });
    expect(markers).toBeGreaterThan(0);

    // ...and the real gate read it and refused to freeze. THE point of the test:
    // an over-stated payout is never made immutable.
    expect(r.syncBlocked).toBeGreaterThan(0);
    expect(r.frozen).toBe(0);
    expect(await getDb().ownerStatementPeriod.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("freezes normally once the transient sync failure clears (the withheld month self-heals)", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";

    syncShouldThrow.value = true;
    const blocked = await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);
    expect(blocked.frozen).toBe(0);

    // Next run, sync healthy. The marker from the previous run is OLDER than this
    // run's watermark, so it must not wedge the freeze forever.
    syncShouldThrow.value = false;
    const healed = await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    expect(healed.syncBlocked).toBe(0);
    expect(healed.frozen).toBeGreaterThan(0);
    expect(await getDb().ownerStatementPeriod.count({ where: { organizationId: ORG } })).toBeGreaterThan(0);
  });

  // ── 3. Send cron ────────────────────────────────────────────────────────────

  it("flag OFF → hard no-op, nothing is sent", async () => {
    delete process.env[AUTO_SEND_FLAG];
    process.env[AUTO_ISSUE_FLAG] = "1";
    await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    const r = await runSendOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    expect(r).toEqual({ ranOrgs: 0, sent: 0, skipped: 0, sendFailed: 0, notDue: 0 });
    expect((await findCombinedInvoice())?.status).toBe("approved");
  });

  it("sends the approved statement once the org's LOCAL send moment has passed", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";
    process.env[AUTO_SEND_FLAG] = "1";
    await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    const r = await runSendOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    expect(r.sent).toBe(1);
    expect(r.sendFailed).toBe(0);
    expect((await findCombinedInvoice())?.status).toBe("sent");
  });

  it("does NOT send before the org's local send day", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";
    process.env[AUTO_SEND_FLAG] = "1";
    await runFreezeOwnerStatementsCron(APRIL_1_MYT);

    // 2026-04-01 02:00 UTC = 10:00 MYT on the 1st — before a sendDay of 3.
    const r = await runSendOwnerStatementsCron(APRIL_1_MYT);

    expect(r.notDue).toBeGreaterThan(0);
    expect(r.sent).toBe(0);
    expect((await findCombinedInvoice())?.status).toBe("approved");
  });

  it("stays due after the send day — a missed run sends late rather than losing the month", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";
    process.env[AUTO_SEND_FLAG] = "1";
    await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    // The 3rd was missed entirely; this is the 19th. The month must still go out —
    // an exact-day match would have silently dropped it.
    const late = new Date(Date.UTC(2026, 3, 19, 9, 0, 0));
    const r = await runSendOwnerStatementsCron(late);

    expect(r.sent).toBe(1);
    expect((await findCombinedInvoice())?.status).toBe("sent");
  });

  it("is idempotent — re-running after a send does not re-send", async () => {
    process.env[AUTO_ISSUE_FLAG] = "1";
    process.env[AUTO_SEND_FLAG] = "1";
    await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    const first = await runSendOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);
    const second = await runSendOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    expect(first.sent).toBe(1);
    // Already `sent` ⇒ filtered out by the candidate query, not re-transitioned.
    expect(second.sent).toBe(0);
    expect(second.sendFailed).toBe(0);
  });

  it("never sends a still-open month (guards against a replayed `now`)", async () => {
    process.env[AUTO_SEND_FLAG] = "1";

    // endedMonth(now) here is the CURRENT real month, which has not ended.
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 15, 9, 0, 0));
    const r = await runSendOwnerStatementsCron(nextMonth);

    expect(r).toEqual({ ranOrgs: 0, sent: 0, skipped: 0, sendFailed: 0, notDue: 0 });
  });

  it("does not send a DRAFT statement — approval is the precondition", async () => {
    process.env[AUTO_SEND_FLAG] = "1";
    // Auto-issue OFF ⇒ no statement is minted or approved at all.
    delete process.env[AUTO_ISSUE_FLAG];
    await runFreezeOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    const r = await runSendOwnerStatementsCron(APRIL_3_MYT_AFTERNOON);

    expect(r.sent).toBe(0);
    expect(r.sendFailed).toBe(0);
  });
});
