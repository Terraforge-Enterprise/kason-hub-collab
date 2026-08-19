/**
 * Task 2 (owner-ledger view clarity, Approach B) — reversible backfill that VOIDS
 * the vestigial display-only "statement twin" utility OwnerLedgerEntry rows.
 *
 * HIGH-RISK money code: voids ledger rows. These integration tests exercise the
 * real `runBackfill` against LOCAL Postgres (opt-in via RUN_INTEGRATION=1) and
 * assert the payout-invariant void predicate (includeInPayout:false only), the
 * spare-non-target guards (includeInPayout:true stragglers, non-utility, full-bill),
 * the apply-without-confirm dry-run, idempotency, no-admin skip, and audit-driven undo.
 *
 * Seed strategy: OwnerLedgerEntry.propertyId / ownerPartyId / createdById /
 * updatedById are PLAIN columns (no FK), so a row needs only a real Organization
 * (FK, onDelete Cascade) plus — for resolveSystemActor + the audit actor FK — a
 * real admin User. No property/apartment/listing/tenancy graph required.
 *
 * Disjoint fixed UUIDs (0d1a…) — must not collide with sibling owner-ledger
 * integration files (which use 0c…) on the shared dev Postgres.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { runBackfill } from "../../../../../../scripts/backfill-void-owner-ledger-utility-twins";
import { SYNC_ACTOR_ID } from "../owner-ledger.sync";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const db = getDb();

// ── Fixed disjoint UUIDs ──────────────────────────────────────────────────────
const ORG_A = "0d1a0000-0000-4000-8000-000000000001";
const ADMIN_A = "0d1a0000-0000-4000-8000-000000000002";
const OWNER = "0d1a0000-0000-4000-8000-000000000003";
const PROP = "0d1a0000-0000-4000-8000-000000000004";
const REAL_EDITOR = "0d1a0000-0000-4000-8000-000000000005"; // a non-sync (admin) editor id
const ORG_NOADMIN = "0d1a0000-0000-4000-8000-000000000011";
const ORG_B = "0d1a0000-0000-4000-8000-000000000021";
const ADMIN_B = "0d1a0000-0000-4000-8000-000000000022";

const ALL_ORGS = [ORG_A, ORG_NOADMIN, ORG_B];
const MONTH_START = new Date(Date.UTC(2026, 5, 1));
const VOID_ACTION = "owner_ledger.entry.void_vestigial_twin";
const UNVOID_ACTION = "owner_ledger.entry.unvoid_vestigial_twin";

// ── Seed helpers ──────────────────────────────────────────────────────────────
async function seedOrg(orgId: string, adminId?: string) {
  await db.organization.create({
    data: {
      id: orgId,
      name: `BF Org ${orgId.slice(-4)}`,
      slug: `bf-org-${orgId.slice(-4)}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  if (adminId) {
    await db.user.create({
      data: {
        id: adminId,
        organizationId: orgId,
        email: `admin-${orgId.slice(-4)}@bf.test`,
        fullName: "BF Admin",
        status: "active",
        role: "admin",
        userType: "operator",
      },
    });
  }
}

async function seedEntry(o: {
  organizationId: string;
  sourceType: string;
  category: string;
  includeInPayout: boolean;
  status?: string;
  updatedById?: string;
}): Promise<string> {
  const row = await db.ownerLedgerEntry.create({
    data: {
      organizationId: o.organizationId,
      ownerPartyId: OWNER,
      propertyId: PROP,
      statementMonth: MONTH_START,
      transactionDate: MONTH_START,
      direction: "expense",
      category: o.category,
      amount: "10.00",
      paidBy: "kaen",
      includeInPayout: o.includeInPayout,
      sourceType: o.sourceType,
      status: o.status ?? "active",
      createdById: SYNC_ACTOR_ID,
      updatedById: o.updatedById ?? SYNC_ACTOR_ID,
    },
    select: { id: true },
  });
  return row.id;
}

async function cleanup() {
  const where = { organizationId: { in: ALL_ORGS } };
  // FK-safe order: ledger + audit before users (AuditLog.actor is onDelete: Restrict),
  // then users, then the org itself.
  await db.ownerLedgerEntry.deleteMany({ where });
  await db.auditLog.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.organization.deleteMany({ where: { id: { in: ALL_ORGS } } });
}

dn("backfill void vestigial statement utility twins", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("voids the includeInPayout:false utility twin, sparing the includeInPayout:true straggler + fire_insurance + full-bill", async () => {
    await seedOrg(ORG_A, ADMIN_A);
    // display-only twin (sync-owned, includeInPayout:false) — payout-invariant → MUST be voided
    const twinId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "wifi", includeInPayout: false });
    // pre-C1 STRAGGLER (statement utility, includeInPayout:TRUE) — its money-direction is
    // history-dependent (may be the SOLE payout deduction) → MUST be SPARED (money-safety, FIX 1)
    const stragglerId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "utilities_tnb", includeInPayout: true });
    // admin-edited owner-paid fire_insurance (statement, NON-utility) — must be SPARED (category-gate)
    const insId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "fire_insurance", includeInPayout: false, updatedById: REAL_EDITOR });
    // Source-3 full supplier bill (sourceType utility_*, not statement) — must be SPARED (sourceType-gate)
    const fullBillId = await seedEntry({ organizationId: ORG_A, sourceType: "utility_wifi", category: "wifi", includeInPayout: true });

    const res1 = await runBackfill({ apply: true, confirm: true, org: ORG_A });
    expect(res1.voided).toBe(1);

    const twin = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } });
    expect(twin.status).toBe("void");
    const straggler = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: stragglerId } });
    expect(straggler.status).toBe("active"); // includeInPayout:true — spared by the false-only predicate (money-safety)
    const ins = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: insId } });
    expect(ins.status).toBe("active"); // category-gated: non-utility not touched
    const fullBill = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: fullBillId } });
    expect(fullBill.status).toBe("active"); // sourceType utility_*, not statement — not touched

    // Audit rows: exactly one (only the voided twin), keyed on the backfill's own action,
    // written with the REAL admin actor (a User FK) — never the sync sentinel — carrying the
    // adminEdited meta the undo + operator review depend on.
    const audits = await db.auditLog.findMany({ where: { organizationId: ORG_A, action: VOID_ACTION } });
    expect(audits).toHaveLength(1);
    const twinAudit = audits.find((a) => a.entityId === twinId)!;
    expect(twinAudit.actorUserId).toBe(ADMIN_A); // real actor, not SYNC_ACTOR_ID
    expect(twinAudit.actorUserId).not.toBe(SYNC_ACTOR_ID);
    expect(twinAudit.actorRole).toBe("admin");
    expect((twinAudit.meta as { adminEdited: boolean }).adminEdited).toBe(false);

    // Idempotent: a second live run voids nothing more.
    const res2 = await runBackfill({ apply: true, confirm: true, org: ORG_A });
    expect(res2.voided).toBe(0);
  });

  it("dry-run (no apply) reports the matched count and writes nothing", async () => {
    await seedOrg(ORG_A, ADMIN_A);
    const twinId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "wifi", includeInPayout: false });

    const res = await runBackfill({ org: ORG_A }); // no apply, no confirm
    expect(res.matched).toBe(1);
    expect(res.voided).toBe(0);

    const twin = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } });
    expect(twin.status).toBe("active"); // untouched
    const audits = await db.auditLog.count({ where: { organizationId: ORG_A, action: VOID_ACTION } });
    expect(audits).toBe(0); // wrote nothing
  });

  it("apply WITHOUT confirm is a dry-run: reports the matched count but voids nothing (FIX 2 defense-in-depth)", async () => {
    await seedOrg(ORG_A, ADMIN_A);
    const twinId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "wifi", includeInPayout: false });

    // A programmatic caller passing apply:true WITHOUT confirm must NOT write money rows —
    // the write path requires BOTH flags (the CLI already exits before reaching runBackfill).
    const res = await runBackfill({ apply: true, org: ORG_A }); // apply:true, NO confirm
    expect(res.matched).toBe(1); // the match is still COUNTED (visible to the operator)
    expect(res.voided).toBe(0); // …but nothing is voided without confirm

    const twin = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } });
    expect(twin.status).toBe("active"); // untouched
    expect(await db.auditLog.count({ where: { organizationId: ORG_A, action: VOID_ACTION } })).toBe(0);
  });

  it("counts and skips a no-admin org, and still processes a sibling org that has an admin", async () => {
    // No-admin org (resolveSystemActor → null) with a twin that must be LEFT untouched.
    await seedOrg(ORG_NOADMIN); // no admin user
    const skippedTwinId = await seedEntry({ organizationId: ORG_NOADMIN, sourceType: "statement", category: "wifi", includeInPayout: false });
    // Sibling org WITH an admin whose twin must still be voided in the same pass.
    await seedOrg(ORG_B, ADMIN_B);
    const processedTwinId = await seedEntry({ organizationId: ORG_B, sourceType: "statement", category: "wifi", includeInPayout: false });

    const res = await runBackfill({ apply: true, confirm: true }); // unscoped: spans both orgs

    expect(res.skippedNoAdmin).toBeGreaterThanOrEqual(1); // the no-admin org was counted, not aborted-on
    const skipped = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: skippedTwinId } });
    expect(skipped.status).toBe("active"); // no-admin org left untouched (no real actor for the audit FK)
    const processed = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: processedTwinId } });
    expect(processed.status).toBe("void"); // sibling with an admin still processed
    // No audit could be written for the skipped org (no actor); the processed org has one.
    expect(await db.auditLog.count({ where: { organizationId: ORG_NOADMIN, action: VOID_ACTION } })).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: ORG_B, action: VOID_ACTION } })).toBe(1);
  });

  it("undo (audit-driven) re-activates ONLY backfill-voided rows, gated by --confirm and idempotent on re-run", async () => {
    await seedOrg(ORG_A, ADMIN_A);
    const twinId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "wifi", includeInPayout: false });
    // A row voided by SOMETHING ELSE (e.g. the sync reverse-pass) — already void, and
    // carries NO void_vestigial_twin audit. Undo must NEVER reactivate it.
    const syncVoidedId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "water", includeInPayout: false, status: "void" });

    // Live backfill voids the twin (and writes the audit undo keys off of).
    const live = await runBackfill({ apply: true, confirm: true, org: ORG_A });
    expect(live.voided).toBe(1);
    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } })).status).toBe("void");

    // Undo WITHOUT --confirm: previews the matched count but writes nothing —
    // including no unvoid audit row (FIX 3: undo now writes an audit trail).
    const undoDry = await runBackfill({ undo: true, org: ORG_A });
    expect(undoDry.matched).toBe(1);
    expect(undoDry.reactivated).toBe(0);
    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } })).status).toBe("void");
    expect(await db.auditLog.count({ where: { organizationId: ORG_A, action: UNVOID_ACTION } })).toBe(0);

    // Undo WITH --confirm: reactivates only the backfill-voided twin AND
    // writes a traceable unvoid_vestigial_twin audit row (FIX 3) — same real
    // actor as the void path (never SYNC_ACTOR_ID), entityId keyed to the
    // reactivated row, meta.reactivated:true. The row's own updatedById stays
    // SYNC_ACTOR_ID (untouched by undo) so a FUTURE re-void's own
    // meta.adminEdited computation (`updatedById !== SYNC_ACTOR_ID`) is never
    // corrupted by this reactivation.
    const undo = await runBackfill({ undo: true, confirm: true, org: ORG_A });
    expect(undo.reactivated).toBe(1);
    const reactivated = await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } });
    expect(reactivated.status).toBe("active");
    expect(reactivated.updatedById).toBe(SYNC_ACTOR_ID);
    // The separately-voided (no-audit) row is untouched.
    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: syncVoidedId } })).status).toBe("void");

    const unvoidAudits = await db.auditLog.findMany({ where: { organizationId: ORG_A, action: UNVOID_ACTION } });
    expect(unvoidAudits).toHaveLength(1);
    const twinUnvoidAudit = unvoidAudits.find((a) => a.entityId === twinId)!;
    expect(twinUnvoidAudit.actorUserId).toBe(ADMIN_A); // real actor, not SYNC_ACTOR_ID
    expect(twinUnvoidAudit.actorUserId).not.toBe(SYNC_ACTOR_ID);
    expect(twinUnvoidAudit.actorRole).toBe("admin");
    expect(twinUnvoidAudit.entityType).toBe("OwnerLedgerEntry");
    expect((twinUnvoidAudit.meta as { reactivated: boolean }).reactivated).toBe(true);

    // Idempotent: a second undo finds nothing still-void among the audit-backed
    // ids, and does NOT write a second unvoid audit row.
    const undoAgain = await runBackfill({ undo: true, confirm: true, org: ORG_A });
    expect(undoAgain.reactivated).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: ORG_A, action: UNVOID_ACTION } })).toBe(1);
  });

  it("undo skips reactivation for an org whose admin is no longer present, leaving the row void and writing no audit", async () => {
    await seedOrg(ORG_A, ADMIN_A);
    const twinId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "wifi", includeInPayout: false });

    // Live backfill voids the twin while ORG_A still has its admin (writes
    // the void audit undo keys off of).
    const live = await runBackfill({ apply: true, confirm: true, org: ORG_A });
    expect(live.voided).toBe(1);

    // The org's only admin is demoted (e.g. a later role change) —
    // resolveSystemActor (role:"admin" lookup, no fallback) can no longer
    // resolve an actor for this org, exactly mirroring the void path's own
    // no-admin gate — now reachable from the undo direction too (FIX 3).
    await db.user.update({ where: { id: ADMIN_A }, data: { role: "manager" } });

    const undo = await runBackfill({ undo: true, confirm: true, org: ORG_A });
    expect(undo.matched).toBe(1); // still discoverable via the audit trail
    expect(undo.reactivated).toBe(0); // not reactivated: no actor to attribute the audit to
    expect(undo.skippedNoAdmin).toBeGreaterThanOrEqual(1);

    // Row stays void — undo never silently reactivates without a traceable actor.
    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: twinId } })).status).toBe("void");
    expect(await db.auditLog.count({ where: { organizationId: ORG_A, action: UNVOID_ACTION } })).toBe(0);
  });

  // Hardening (money-safety): the sharpest edges of the reverted false-only predicate.
  it("SPARES an includeInPayout:true admin-edited utility row + statement cleaning, yet voids an includeInPayout:false admin-edited twin (meta.adminEdited)", async () => {
    await seedOrg(ORG_A, ADMIN_A);
    // Admin manually touched this display-only twin, but it is includeInPayout:FALSE → still
    // payout-invariant → it IS voided, and audit meta.adminEdited:true preserves the trail.
    const adminEditedFalseId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "water", includeInPayout: false, updatedById: REAL_EDITOR });
    // Admin set includeInPayout:TRUE on a statement-utility row. With no matching Source-3
    // full-bill it could be the SOLE payout deduction → voiding it would OVERPAY the owner.
    // FIX 1's false-only predicate MUST spare it regardless of the admin edit.
    const adminEditedTrueId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "utilities_tnb", includeInPayout: true, updatedById: REAL_EDITOR });
    // Statement `cleaning` is NOT display-only — it is the SOLE payout source for cleaning
    // (no Source-3 backing). Voiding it would OVERPAY the owner. It MUST be spared.
    const cleaningId = await seedEntry({ organizationId: ORG_A, sourceType: "statement", category: "cleaning", includeInPayout: true });

    const res = await runBackfill({ apply: true, confirm: true, org: ORG_A });
    expect(res.voided).toBe(1); // only the includeInPayout:false twin; the true-rows + cleaning spared

    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: adminEditedFalseId } })).status).toBe("void");
    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: adminEditedTrueId } })).status).toBe("active"); // money-safety: includeInPayout:true spared
    expect((await db.ownerLedgerEntry.findUniqueOrThrow({ where: { id: cleaningId } })).status).toBe("active");
    const audit = await db.auditLog.findFirstOrThrow({ where: { organizationId: ORG_A, action: VOID_ACTION, entityId: adminEditedFalseId } });
    expect((audit.meta as { adminEdited: boolean }).adminEdited).toBe(true);
  });
});
