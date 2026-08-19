/**
 * scripts/heal-desynced-ledger-voids.ts (integration, RUN_INTEGRATION=1)
 *
 * ONE-TIME REMEDIATION (Spec R6) — before Tasks 2-3 in this plan, a shallow
 * void of an OwnerLedgerEntry row derived from a Charge/Invoice/UnitUtilityBill
 * could set status:"void" WITHOUT checking the source's liveness and WITHOUT
 * changing updatedById away from SYNC_ACTOR_ID — a permanent desync (ledger
 * says void, the real charge/invoice/bill is still live). This script heals
 * exactly those bug-victim rows back to status:"active", writing ONLY the
 * status column (never updatedById).
 *
 * NOT to be confused with scripts/sweep-orphaned-ledger-entries.ts, which
 * fixes the OPPOSITE desync (active rows whose source already died, from the
 * pre-reverse-pass era) — a different tool for a different historical bug.
 *
 * Heal predicate — mirrors owner-ledger.sync.ts's reverse pass (~745-816)
 * EXACTLY, inverted (heal iff NO source ref is dead):
 *   status = "void" AND updatedById = SYNC_ACTOR_ID
 *   AND (sourceChargeId      IS NULL OR Charge.status      NOT IN ('void','credited'))
 *   AND (sourceInvoiceId     IS NULL OR Invoice.status     <> 'void')
 *   AND (sourceUtilityBillId IS NULL OR UnitUtilityBill.status <> 'void')
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 DATABASE_URL=<local> ../../node_modules/.bin/vitest run \
 *     src/modules/owner-ledger/__tests__/heal-desynced-ledger-voids.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb, Prisma } from "@kason/db";
import { SYNC_ACTOR_ID } from "../owner-ledger.sync";
import {
  healDesyncedLedgerVoids,
  findVoidedSyncOwnedRows,
  filterHealable,
  applyHeal,
  guardsSatisfied,
} from "../../../../../../scripts/heal-desynced-ledger-voids";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix "a107" — Task 7).
const ORG = "a1070000-0000-4000-8000-000000000001";
const PARTY = "a1070000-0000-4000-8000-000000000002";
const PROPERTY = "a1070000-0000-4000-8000-000000000003";
const APARTMENT = "a1070000-0000-4000-8000-000000000004";

const CHARGE_LIVE = "a1070000-0000-4000-8000-000000000010"; // B1: heals live-charge victim
const CHARGE_LIVE_CHILD = "a1070000-0000-4000-8000-000000000011"; // B3: voided-statement's live child
const CHARGE_DEAD = "a1070000-0000-4000-8000-000000000012"; // B2: leaves dead-charge row
const CHARGE_FOR_DRY_RUN = "a1070000-0000-4000-8000-000000000013"; // B7: dry run
const CHARGE_FOR_RACE = "a1070000-0000-4000-8000-000000000014"; // B8: race guard
const CHARGE_FOR_ADMIN_VOID = "a1070000-0000-4000-8000-000000000015"; // B6: admin-void
const CHARGE_FOR_DELIBERATE = "a1070000-0000-4000-8000-000000000016"; // B9: live charge; its ledger row carries a deliberate-void audit

const INVOICE_VOID = "a1070000-0000-4000-8000-000000000020";

const BILL_LIVE = "a1070000-0000-4000-8000-000000000030"; // B5: heals bill victim
const BILL_DEAD = "a1070000-0000-4000-8000-000000000031"; // B4: leaves dead-bill row

const ROW_CHARGE_VICTIM = "a1070000-0000-4000-8000-000000000101"; // B1
const ROW_DEAD_CHARGE = "a1070000-0000-4000-8000-000000000102"; // B2
const ROW_VOIDED_STATEMENT = "a1070000-0000-4000-8000-000000000103"; // B3
const ROW_DEAD_BILL = "a1070000-0000-4000-8000-000000000104"; // B4
const ROW_BILL_VICTIM = "a1070000-0000-4000-8000-000000000105"; // B5
const ROW_ADMIN_VOID = "a1070000-0000-4000-8000-000000000106"; // B6
const ROW_DRY_RUN = "a1070000-0000-4000-8000-000000000107"; // B7
const ROW_RACE = "a1070000-0000-4000-8000-000000000108"; // B8
const ROW_DELIBERATE_VOID = "a1070000-0000-4000-8000-000000000109"; // B9: healable BUT carries a deliberate-void AuditLog

const ADMIN_USER_ID = "a1070000-0000-4000-8000-0000000000ff"; // a REAL admin actor id (never SYNC_ACTOR_ID) — seeded as the org's admin User
const DELIBERATE_VOID_AUDIT_ID = "a1070000-0000-4000-8000-0000000001fe"; // pre-existing owner_ledger.entry.void audit on ROW_DELIBERATE_VOID

const MONTH_START = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01
const MONTH_START_ALT = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01 (distinct periodMonth for BILL_DEAD)

function chargeData(
  id: string,
  chargeNumber: string,
  overrides: Partial<Prisma.ChargeUncheckedCreateInput> = {},
): Prisma.ChargeUncheckedCreateInput {
  return {
    id,
    organizationId: ORG,
    chargeNumber,
    partyId: PARTY,
    chargeType: "rent",
    status: "posted",
    description: "Heal integration charge",
    dueDate: MONTH_START,
    amount: "100.00",
    currency: "MYR",
    outstandingAmount: "0.00",
    billingMonth: MONTH_START,
    attachmentKeys: [],
    ...overrides,
  } satisfies Prisma.ChargeUncheckedCreateInput;
}

function billData(
  id: string,
  periodMonth: Date,
  overrides: Partial<Prisma.UnitUtilityBillUncheckedCreateInput> = {},
): Prisma.UnitUtilityBillUncheckedCreateInput {
  return {
    id,
    organizationId: ORG,
    apartmentId: APARTMENT,
    periodMonth,
    billingMode: "whole",
    tnbTotal: "50.00",
    status: "charged",
    createdBy: ADMIN_USER_ID,
    ...overrides,
  } satisfies Prisma.UnitUtilityBillUncheckedCreateInput;
}

/** A bug-victim OwnerLedgerEntry row: status="void", sync-owned (updatedById=SYNC_ACTOR_ID). */
function voidSyncRow(
  id: string,
  overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> = {},
): Prisma.OwnerLedgerEntryUncheckedCreateInput {
  return {
    id,
    organizationId: ORG,
    ownerPartyId: PARTY,
    propertyId: PROPERTY,
    apartmentId: APARTMENT,
    statementMonth: MONTH_START,
    transactionDate: MONTH_START,
    direction: "expense",
    category: "other_expense",
    amount: "10.00",
    paidBy: "kaen",
    sourceType: "rent",
    status: "void",
    createdById: SYNC_ACTOR_ID,
    updatedById: SYNC_ACTOR_ID,
    ...overrides,
  } satisfies Prisma.OwnerLedgerEntryUncheckedCreateInput;
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "Heal Voids Org",
      slug: "heal-voids-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // A REAL admin User for the org — resolveSystemActor() finds this to attribute
  // the heal AuditLog (AuditLog.actorUserId is a non-null FK; the sentinel can't).
  await db.user.create({
    data: {
      id: ADMIN_USER_ID,
      organizationId: ORG,
      email: "heal-admin@heal-voids-org.example",
      fullName: "Heal Admin",
      status: "active",
      role: "admin",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "Heal Owner", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Heal Tower",
      propertyCode: "HEAL-P1",
      propertyType: "apartment",
      addressLine1: "1 Heal St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "HEAL-01", listingMode: "WHOLE" },
  });

  // Invoice BEFORE the charge that references it (Charge.invoiceId FK).
  await db.invoice.create({
    data: {
      id: INVOICE_VOID,
      organizationId: ORG,
      invoiceNumber: "OS-HEAL-VOID",
      partyId: PARTY,
      ownerPartyId: PARTY,
      invoiceType: "owner_statement",
      status: "void",
      invoiceDate: new Date(),
      periodMonth: MONTH_START,
      totalAmount: "10.00",
    },
  });

  await db.charge.create({ data: chargeData(CHARGE_LIVE, "HEAL-C-1") });
  await db.charge.create({
    data: chargeData(CHARGE_LIVE_CHILD, "HEAL-C-2", { chargeType: "management_fee", invoiceId: INVOICE_VOID }),
  });
  await db.charge.create({ data: chargeData(CHARGE_DEAD, "HEAL-C-3", { status: "void" }) });
  await db.charge.create({ data: chargeData(CHARGE_FOR_DRY_RUN, "HEAL-C-4") });
  await db.charge.create({ data: chargeData(CHARGE_FOR_RACE, "HEAL-C-5") });
  await db.charge.create({ data: chargeData(CHARGE_FOR_ADMIN_VOID, "HEAL-C-6") });
  await db.charge.create({ data: chargeData(CHARGE_FOR_DELIBERATE, "HEAL-C-7") });

  await db.unitUtilityBill.create({ data: billData(BILL_LIVE, MONTH_START, { status: "charged" }) });
  await db.unitUtilityBill.create({ data: billData(BILL_DEAD, MONTH_START_ALT, { status: "void" }) });

  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_CHARGE_VICTIM, { sourceType: "rent", sourceChargeId: CHARGE_LIVE }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_DEAD_CHARGE, { sourceType: "rent", sourceChargeId: CHARGE_DEAD }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_VOIDED_STATEMENT, {
      sourceType: "statement",
      sourceChargeId: CHARGE_LIVE_CHILD,
      sourceInvoiceId: INVOICE_VOID,
    }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_DEAD_BILL, { sourceType: "utility_tnb", sourceUtilityBillId: BILL_DEAD }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_BILL_VICTIM, { sourceType: "utility_tnb", sourceUtilityBillId: BILL_LIVE }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_ADMIN_VOID, {
      sourceType: "rent",
      sourceChargeId: CHARGE_FOR_ADMIN_VOID,
      updatedById: ADMIN_USER_ID, // a REAL admin void — must never be considered
    }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_DRY_RUN, { sourceType: "rent", sourceChargeId: CHARGE_FOR_DRY_RUN }),
  });
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_RACE, { sourceType: "rent", sourceChargeId: CHARGE_FOR_RACE }),
  });
  // B9: a genuinely healable candidate (live source, sync-owned, void) that ALSO
  // carries a deliberate manual-void AuditLog — the Finding-1 review signal.
  await db.ownerLedgerEntry.create({
    data: voidSyncRow(ROW_DELIBERATE_VOID, { sourceType: "rent", sourceChargeId: CHARGE_FOR_DELIBERATE }),
  });
  await db.auditLog.create({
    data: {
      id: DELIBERATE_VOID_AUDIT_ID,
      organizationId: ORG,
      actorUserId: ADMIN_USER_ID,
      actorRole: "admin",
      action: "owner_ledger.entry.void",
      entityType: "OwnerLedgerEntry",
      entityId: ROW_DELIBERATE_VOID,
      diff: { before: { status: "active" }, after: { status: "void" } } as unknown as Prisma.InputJsonValue,
    },
  });
}

/** Delete everything in FK-safe order (children before parents). */
async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  // AuditLog.actor → User is onDelete: Restrict, so audits MUST go before users.
  await db.auditLog.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

dn("heal-desynced-ledger-voids (integration, Task 7 / R6)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("heals live-charge victim idempotent", async () => {
    const db = getDb();
    const first = await healDesyncedLedgerVoids(db, { dryRun: false });
    expect(first.healedIds).toContain(ROW_CHARGE_VICTIM);

    const healed = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_CHARGE_VICTIM } });
    expect(healed.status).toBe("active");
    expect(healed.updatedById).toBe(SYNC_ACTOR_ID); // never touched

    // Idempotent: the healed row is now "active", so it drops out of the
    // status="void" selector — a second run must heal 0 for it.
    const second = await healDesyncedLedgerVoids(db, { dryRun: false });
    expect(second.healedIds).not.toContain(ROW_CHARGE_VICTIM);
    expect(second.candidateIds).not.toContain(ROW_CHARGE_VICTIM);
  });

  it("leaves dead-charge row", async () => {
    const db = getDb();
    await healDesyncedLedgerVoids(db, { dryRun: false });

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DEAD_CHARGE } });
    expect(row.status).toBe("void"); // a genuinely void source Charge is never resurrected
  });

  it("leaves voided-statement row", async () => {
    const db = getDb();
    // Sanity-check the fixture's premise: the child Charge is LIVE even though
    // its parent Invoice is void (a whole-statement void doesn't touch child
    // charge status) — otherwise this test wouldn't be exercising the AND.
    const childCharge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_LIVE_CHILD } });
    expect(childCharge.status).toBe("posted");

    await healDesyncedLedgerVoids(db, { dryRun: false });

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_VOIDED_STATEMENT } });
    expect(row.status).toBe("void"); // NOT resurrected — the Invoice ref is dead even though the Charge ref is live
  });

  it("leaves dead-bill row", async () => {
    const db = getDb();
    await healDesyncedLedgerVoids(db, { dryRun: false });

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DEAD_BILL } });
    expect(row.status).toBe("void"); // a genuinely void source UnitUtilityBill is never resurrected
  });

  it("heals bill victim", async () => {
    const db = getDb();
    const result = await healDesyncedLedgerVoids(db, { dryRun: false });
    expect(result.healedIds).toContain(ROW_BILL_VICTIM);

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_BILL_VICTIM } });
    expect(row.status).toBe("active");
    expect(row.updatedById).toBe(SYNC_ACTOR_ID);
  });

  it("leaves admin-voided row untouched", async () => {
    const db = getDb();
    // Fixture premise: ROW_ADMIN_VOID's source charge is LIVE — if the actor
    // gate were missing, it would otherwise qualify for healing.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: CHARGE_FOR_ADMIN_VOID } });
    expect(charge.status).toBe("posted");

    const result = await healDesyncedLedgerVoids(db, { dryRun: false });
    expect(result.candidateIds).not.toContain(ROW_ADMIN_VOID);
    expect(result.healedIds).not.toContain(ROW_ADMIN_VOID);

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_ADMIN_VOID } });
    expect(row.status).toBe("void"); // a real admin's own void — never reconsidered
    expect(row.updatedById).toBe(ADMIN_USER_ID);
  });

  it("dry run reports candidates without writing", async () => {
    const db = getDb();
    const result = await healDesyncedLedgerVoids(db, { dryRun: true });
    expect(result.candidateIds).toContain(ROW_DRY_RUN);
    expect(result.healedIds).toEqual([]); // dry run NEVER reports anything healed

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DRY_RUN } });
    expect(row.status).toBe("void"); // untouched — no write happened
  });

  it("guards against a row that changed between selection and write", async () => {
    const db = getDb();
    // Compute candidates the same way healDesyncedLedgerVoids does internally...
    const voided = await findVoidedSyncOwnedRows(db);
    const healable = await filterHealable(db, voided);
    expect(healable.map((r) => r.id)).toContain(ROW_RACE);

    // ...then, BEFORE the write step runs, a real admin voids the row for real
    // (updatedById now a genuine actor) — simulating a race with a concurrent
    // legitimate action between selection and write.
    await db.ownerLedgerEntry.update({ where: { id: ROW_RACE }, data: { updatedById: ADMIN_USER_ID } });

    const healedIds = await applyHeal(db, healable.filter((r) => r.id === ROW_RACE));
    expect(healedIds).not.toContain(ROW_RACE); // write re-asserted the guard and safely skipped it

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_RACE } });
    expect(row.status).toBe("void"); // NOT blindly resurrected
    expect(row.updatedById).toBe(ADMIN_USER_ID); // the race-winner's stamp survives untouched
  });

  // ── Money-safety review hardening (Task 7 fix) ────────────────────────────

  it("default gate (no --apply + HEAL_CONFIRM=yes) is dry-run — makes no writes", async () => {
    const db = getDb();
    // The write gate mirrors the sibling sweep: BOTH --apply AND HEAL_CONFIRM=yes
    // must be present; anything less stays dry-run.
    expect(guardsSatisfied([], {} as NodeJS.ProcessEnv)).toBe(false); // bare invocation
    expect(guardsSatisfied(["--apply"], {} as NodeJS.ProcessEnv)).toBe(false); // flag alone
    expect(guardsSatisfied([], { HEAL_CONFIRM: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(false); // env alone
    expect(guardsSatisfied(["--apply"], { HEAL_CONFIRM: "no" } as unknown as NodeJS.ProcessEnv)).toBe(false); // wrong value
    expect(guardsSatisfied(["--apply"], { HEAL_CONFIRM: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(true);

    // What main() computes for a bare run → dryRun true → zero writes.
    const dryRun = !guardsSatisfied([], {} as NodeJS.ProcessEnv);
    const result = await healDesyncedLedgerVoids(db, { dryRun });
    expect(result.healedIds).toEqual([]);

    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_CHARGE_VICTIM } });
    expect(row.status).toBe("void"); // untouched — the default never writes
  });

  it("writes a per-row heal AuditLog (real actor; before=void, after=active)", async () => {
    const db = getDb();
    const result = await healDesyncedLedgerVoids(db, { dryRun: false });
    expect(result.healedIds).toContain(ROW_CHARGE_VICTIM);

    const audit = await db.auditLog.findFirst({
      where: {
        action: "owner_ledger.entry.heal_desync",
        entityType: "OwnerLedgerEntry",
        entityId: ROW_CHARGE_VICTIM,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(ADMIN_USER_ID); // a REAL user, never the SYNC_ACTOR_ID sentinel
    const meta = audit!.meta as { before?: string; after?: string; sourceChargeId?: string | null };
    expect(meta.before).toBe("void");
    expect(meta.after).toBe("active");
    expect(meta.sourceChargeId).toBe(CHARGE_LIVE); // source ref captured
  });

  it("flags candidates that carry a deliberate-void AuditLog (not those without)", async () => {
    const db = getDb();
    const result = await healDesyncedLedgerVoids(db, { dryRun: true });

    // ROW_DELIBERATE_VOID is a genuinely healable candidate...
    expect(result.candidateIds).toContain(ROW_DELIBERATE_VOID);
    // ...but it carries a deliberate owner_ledger.entry.void audit → flagged for review.
    expect(result.deliberateVoidIds).toContain(ROW_DELIBERATE_VOID);

    // A healable candidate with NO such audit is NOT flagged.
    expect(result.candidateIds).toContain(ROW_CHARGE_VICTIM);
    expect(result.deliberateVoidIds).not.toContain(ROW_CHARGE_VICTIM);

    // Dry-run stays write-free even while cross-referencing.
    const row = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DELIBERATE_VOID } });
    expect(row.status).toBe("void");
  });

  // ── Money-safety review hardening (Task 7 fix 2) ──────────────────────────
  // Finding: the deliberate-void flag was REPORT-ONLY — on --apply, EVERY
  // healable row was healed INCLUDING flagged ones, permanently re-inflating
  // a deliberately-voided duplicate into the owner's payout. Fix: exclude
  // flagged rows from the healed set BY DEFAULT; --include-deliberate opts in.

  it("excludes deliberate-void-flagged rows from the healed set by default on apply", async () => {
    const db = getDb();
    const result = await healDesyncedLedgerVoids(db, { dryRun: false });

    // Clean healable candidate (no deliberate-void audit) — healed exactly as before.
    expect(result.healedIds).toContain(ROW_CHARGE_VICTIM);
    const clean = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_CHARGE_VICTIM } });
    expect(clean.status).toBe("active");

    // Flagged candidate — excluded from the default heal, left void, but still reported.
    expect(result.healedIds).not.toContain(ROW_DELIBERATE_VOID);
    expect(result.deliberateVoidIds).toContain(ROW_DELIBERATE_VOID);
    const flagged = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DELIBERATE_VOID } });
    expect(flagged.status).toBe("void"); // NOT healed — never re-inflate a deliberate void by default
    expect(flagged.updatedById).toBe(SYNC_ACTOR_ID); // untouched
  });

  it("--include-deliberate heals the flagged deliberate-void row too", async () => {
    const db = getDb();
    const result = await healDesyncedLedgerVoids(db, { dryRun: false, includeDeliberate: true });

    // Both the clean candidate and the explicitly-opted-in flagged candidate are healed.
    expect(result.healedIds).toContain(ROW_CHARGE_VICTIM);
    expect(result.healedIds).toContain(ROW_DELIBERATE_VOID);
    expect(result.deliberateVoidIds).toContain(ROW_DELIBERATE_VOID); // still reported even when healed

    const flagged = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: ROW_DELIBERATE_VOID } });
    expect(flagged.status).toBe("active");
    expect(flagged.updatedById).toBe(SYNC_ACTOR_ID); // heal never touches updatedById
  });
});
