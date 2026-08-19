/**
 * Task 7: notify tenants + owner on re-Bill supersede (in-app Notification, best-effort).
 *
 * When a billed+invoiced entry is re-Billed (its live tenant+owner invoices are
 * superseded and reissued from amended amounts), the re-Bill emits ONE in-app
 * `Notification` (domain "finance") per affected party that has a portal `User`
 * (User.partyId @unique). A partitioned re-Bill superseding N tenant rooms + 1
 * owner → up to N+1 notifications. Emission is BEST-EFFORT and runs POST-COMMIT, on
 * the shared client, AFTER the re-Bill transaction commits (billService →
 * notifyRebillParties): a party with no portal User is silently skipped (no org-wide
 * spam), and any Notification failure is caught+logged where it is an isolated
 * autocommit statement that can NEVER roll back the already-committed invoices (spec
 * R5). Emitting in-tx would poison the pg transaction on a create failure and silently
 * roll the reissue back (the caller still sees "reinvoiced" with phantom doc ids) — the
 * notify-failure-survivable case pins exactly this. The task writes ONLY in-app
 * Notification — never NotificationQueue (the email queue), so a re-Bill sends zero emails.
 *
 * Mirrors bill-rebill.integration.test.ts's fixture pattern: a dedicated,
 * fully-seeded org (never the shared dev seed), ENABLE_PHASE2_BILLING_DOCS
 * toggled per-test, ordered FK-safe cleanup. Adds User rows whose partyId maps
 * to the tenant/owner parties so they resolve to portal users.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/bill-notify.integration.test.ts
 *
 * Coverage (behavior-inventory):
 *  • notify-three  — re-Bill superseding 2 tenant rooms + 1 owner, all three
 *                    parties having portal Users → exactly 3 finance Notifications
 *                    for the 3 expected userIds, 0 NotificationQueue rows.
 *  • skip-no-user  — a tenancy party with NO portal User → no Notification for
 *                    that party, and billing is NOT rolled back (outcome
 *                    "reinvoiced", replacement docs ISSUED): the best-effort skip.
 *  • notify-failure-survivable — a re-Bill whose notification.create is FORCED to
 *                    fail (DB-level) still commits the reissue: outcome "reinvoiced",
 *                    all 3 replacement docs ISSUED in the DB, 0 notifications persisted,
 *                    and the failure went through the shared post-commit client (spy
 *                    called). Pins that notify is POST-COMMIT — an in-tx create failure
 *                    would silently roll the invoices back (spec R5). This is the
 *                    regression lock for the confirmed in-tx silent-rollback bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace (b7700000) so cleanup is org-scoped + total.
const ORG = "b7700000-0000-4000-8000-000000000001";
const USER = "b7700000-0000-4000-8000-000000000002";
const PROP = "b7700000-0000-4000-8000-000000000003";
const APT = "b7700000-0000-4000-8000-000000000004";
const ROOM_A = "b7700000-0000-4000-8000-000000000005";
const ROOM_B = "b7700000-0000-4000-8000-000000000006";
const PARTY_A = "b7700000-0000-4000-8000-000000000007";
const PARTY_B = "b7700000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7700000-0000-4000-8000-000000000009";
const TEN_A = "b7700000-0000-4000-8000-00000000000a";
const TEN_B = "b7700000-0000-4000-8000-00000000000b";
// Portal Users whose partyId maps to the tenant/owner parties (User.partyId @unique).
const USER_A = "b7700000-0000-4000-8000-00000000000c";
const USER_B = "b7700000-0000-4000-8000-00000000000d";
const USER_OWNER = "b7700000-0000-4000-8000-00000000000e";

// CURRENT org-local month so the previous-period re-Bill guard allows these re-Bills.
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.notification.deleteMany({ where: { organizationId: ORG } });
  await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * A PARTITIONED apartment: TWO occupied rooms (each its own tenancy/party, pax 1)
 * + an owner party. Absorbed-TNB (owner-borne > 0) with a tenant-borne wifi pool
 * so a first Bill issues 2 IVTEN + 1 IVOWN. Returns the concurrency token.
 *
 * `withUsers` controls which parties get a portal User row:
 *   • "all"       — Tenant A, Tenant B, and Owner all get portal Users (notify-three).
 *   • "no-tenant-a" — only Tenant B + Owner get Users; Tenant A has NO portal User
 *                     (skip-no-user: proves the skip path + best-effort).
 */
async function seedPartitionedEntry(withUsers: "all" | "no-tenant-a"): Promise<{ expectedUpdatedAt: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG7", slug: "bg7", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg7@example.test", fullName: "BG7 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B7", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B7", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });

  // Portal Users keyed to the parties (User.partyId @unique → one User per Party).
  // The operator USER above has no partyId, so it never matches a charge's party.
  if (withUsers === "all") {
    await db.user.create({ data: { id: USER_A, organizationId: ORG, partyId: PARTY_A, email: "tenant-a-bg7@example.test", fullName: "Tenant A", status: "active", role: "tenant", userType: "portal" } });
  }
  await db.user.create({ data: { id: USER_B, organizationId: ORG, partyId: PARTY_B, email: "tenant-b-bg7@example.test", fullName: "Tenant B", status: "active", role: "tenant", userType: "portal" } });
  await db.user.create({ data: { id: USER_OWNER, organizationId: ORG, partyId: OWNER_PARTY, email: "owner-bg7@example.test", fullName: "Owner", status: "active", role: "owner", userType: "portal" } });

  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/** Re-read the entry's current concurrency token (post-Bill / post-edit). */
async function tokenFor(): Promise<string> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  return e.updatedAt.toISOString();
}

/** Amend the wifi (tenant-borne) pool so the next Bill is a real supersede, not a no-op. */
async function amendWifi(newWifi: string): Promise<void> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { wifi: newWifi } });
}

dn("bills-grid re-Bill supersede notifications (Task 7)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); // undo any notification.create spy before cleanup/next test
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("notify-three: re-Bill superseding 2 tenant rooms + 1 owner (all with portal Users) writes exactly 3 finance Notifications and 0 NotificationQueue", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry("all");

    // First Bill → live IVTEN×2 + IVOWN. NO notification on first issuance (this task
    // notifies only on the re-Bill SUPERSEDE path).
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    // Clear any first-issuance notifications so the assertion below counts ONLY the re-Bill's.
    await db.notification.deleteMany({ where: { organizationId: ORG } });

    // Amend + re-Bill → supersede 2 tenant + 1 owner, reissue, notify the 3 parties.
    await amendWifi("240.00");
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("reinvoiced");

    // Exactly 3 finance Notifications — one per affected party (2 tenants + owner).
    const notifs = await db.notification.findMany({ where: { organizationId: ORG, domain: "finance" }, select: { userId: true, title: true, body: true } });
    expect(notifs).toHaveLength(3);
    const gotUserIds = new Set(notifs.map((n) => n.userId));
    expect(gotUserIds).toEqual(new Set([USER_A, USER_B, USER_OWNER]));
    // De-dup sanity: the partitioned owner charge → exactly ONE owner notification.
    expect(notifs.filter((n) => n.userId === USER_OWNER)).toHaveLength(1);

    // ZERO emails queued — this task writes ONLY in-app Notification, never the queue.
    expect(await db.notificationQueue.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("skip-no-user: an affected tenancy party with NO portal User gets no Notification, and billing is NOT rolled back", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    // Tenant A has NO portal User; Tenant B + Owner do.
    const { expectedUpdatedAt } = await seedPartitionedEntry("no-tenant-a");

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    await db.notification.deleteMany({ where: { organizationId: ORG } });

    await amendWifi("240.00");
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];

    // Billing is NOT rolled back by the missing-User skip: the reissue succeeded.
    expect(res.outcome).toBe("reinvoiced");
    expect(res.tenantInvoiceIds).toHaveLength(2);
    expect(res.ownerInvoiceIds).toHaveLength(1);
    const freshIds = [...(res.tenantInvoiceIds ?? []), ...(res.ownerInvoiceIds ?? [])];
    const fresh = await db.billingDocument.findMany({ where: { id: { in: freshIds } }, select: { documentStatus: true } });
    expect(fresh).toHaveLength(3);
    for (const d of fresh) expect(d.documentStatus).toBe("ISSUED");

    // Only 2 Notifications (Tenant B + Owner). Tenant A (no portal User) is skipped.
    const notifs = await db.notification.findMany({ where: { organizationId: ORG, domain: "finance" }, select: { userId: true } });
    const gotUserIds = new Set(notifs.map((n) => n.userId));
    expect(gotUserIds).toEqual(new Set([USER_B, USER_OWNER]));
    // No notification carries Tenant A's (non-existent) portal user — nothing leaked to A.
    expect(notifs.some((n) => n.userId === USER_A)).toBe(false);
    expect(await db.notificationQueue.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("notify-failure-survivable: a re-Bill whose notification.create fails still commits the reissue (post-commit, isolated)", async () => {
    // REGRESSION LOCK for the confirmed in-tx silent-rollback bug. If notify ran INSIDE
    // the money $transaction, a notification.create failure would poison the pg tx and
    // the final COMMIT would silently ROLL BACK the just-minted invoices — yet the caller
    // would still see "reinvoiced" with phantom doc ids. The fix emits notifications
    // POST-COMMIT on the shared client, so a create failure is an isolated autocommit
    // statement that can never touch the money.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    const { expectedUpdatedAt } = await seedPartitionedEntry("all");

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");
    await db.notification.deleteMany({ where: { organizationId: ORG } });

    // Force EVERY notification.create to fail at the client layer. Because getDb() is a
    // process singleton (global.__kasonPrisma), this same `db` object IS the client the
    // service notifies through — so the spy intercepts the service's post-commit calls.
    // On the pre-fix in-tx code the service called tx.notification.create (a different
    // object), so this spy would never fire and notifications would still persist → RED.
    const createSpy = vi
      .spyOn(db.notification, "create")
      .mockRejectedValue(new Error("forced notification.create failure"));

    await amendWifi("240.00");
    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await tokenFor(), confirmRebill: true }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];

    // 1. The reissue COMMITTED despite the notify failure: outcome + returned ids.
    expect(res.outcome).toBe("reinvoiced");
    expect(res.tenantInvoiceIds).toHaveLength(2);
    expect(res.ownerInvoiceIds).toHaveLength(1);

    // 2. The returned invoice ids ACTUALLY PERSIST (not phantom): all 3 ISSUED in the DB.
    //    On the in-tx bug these would be gone (rolled back) though the caller saw them.
    const freshIds = [...(res.tenantInvoiceIds ?? []), ...(res.ownerInvoiceIds ?? [])];
    expect(freshIds).toHaveLength(3);
    const fresh = await db.billingDocument.findMany({ where: { id: { in: freshIds } }, select: { documentStatus: true } });
    expect(fresh).toHaveLength(3);
    for (const d of fresh) expect(d.documentStatus).toBe("ISSUED");

    // 3. The failure was routed through the shared POST-COMMIT client (spy fired) — the
    //    property that distinguishes the fix from the in-tx original.
    expect(createSpy).toHaveBeenCalled();

    // 4. No notification survived (all creates were forced to fail) — best-effort swallow.
    createSpy.mockRestore();
    expect(await db.notification.count({ where: { organizationId: ORG, domain: "finance" } })).toBe(0);
    expect(await db.notificationQueue.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
