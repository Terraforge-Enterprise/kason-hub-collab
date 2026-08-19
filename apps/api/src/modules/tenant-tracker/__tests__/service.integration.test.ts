/**
 * Integration tests for the tenant-tracker service writes. Hits a real
 * Postgres — DB-level proof that the PIC assign and its audit row live (and
 * die) in the SAME transaction.
 *
 * Skipped by default. Run explicitly (LOCAL DB ONLY — never remote/supabase):
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://...localhost:5432/kason_hub_dev..." \
 *     npx vitest run src/modules/tenant-tracker/__tests__/service.integration.test.ts
 *
 * Rollback proof needs NO stubbing: AuditLog.actorUserId is a real FK →
 * User.id (onDelete: Restrict), so a session with a nonexistent actorUserId
 * makes recordAudit's INSERT fail with a genuine FK violation INSIDE the tx —
 * if the listing update survives that, the tx isn't atomic.
 *
 * Seeds TWO orgs (org D is the leak canary) with fixed UUIDs unique to this
 * suite and removes exactly those rows in afterAll.
 *
 * NOTE: the tests are intentionally order-coupled (assign → rollback → stale →
 * re-assign → unassign share fixture state) and must run sequentially in-file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../../lib/auth";
import { assignInChargeService, recordIcRevealService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// ─── Fixed fixture ids (unique to this suite — cc/dd namespace) ─────────────
const ORG_C = "cc200000-0000-4000-8000-000000000001";
const ORG_D = "dd200000-0000-4000-8000-000000000001";

const USER_C = "cc200000-0000-4000-8000-000000000005";
const GHOST_USER = "cc200000-0000-4000-8000-0000000000de"; // never created
const PROP_C = "cc200000-0000-4000-8000-000000000010";
const APT_C = "cc200000-0000-4000-8000-000000000021";
const L_ROOM = "cc200000-0000-4000-8000-000000000031"; // assign/unassign happy path
const L_ROOM2 = "cc200000-0000-4000-8000-000000000032"; // rollback + concurrency target
const P_PIC = "cc200000-0000-4000-8000-000000000041"; // has idNumber
const P_NOIC = "cc200000-0000-4000-8000-000000000042"; // no idNumber
const P_D = "dd200000-0000-4000-8000-000000000041"; // org-D party (leak canary)

const session = (userId: string = USER_C): SessionPayload => ({
  userId,
  orgId: ORG_C,
  role: "manager",
});

const db = () => getDb();

const auditCount = (action?: string) =>
  db().auditLog.count({
    where: { organizationId: ORG_C, ...(action ? { action } : {}) },
  });

const listingState = (id: string) =>
  db().listing.findUnique({
    where: { id },
    select: { inChargePartyId: true, inChargeName: true },
  });

async function cleanup() {
  const orgs = { organizationId: { in: [ORG_C, ORG_D] } };
  await db().auditLog.deleteMany({ where: orgs });
  await db().aircondMeter.deleteMany({ where: orgs });
  await db().listing.deleteMany({ where: orgs });
  await db().apartment.deleteMany({ where: orgs });
  await db().property.deleteMany({ where: orgs });
  await db().party.deleteMany({ where: orgs });
  await db().user.deleteMany({ where: orgs });
  await db().organization.deleteMany({ where: { id: { in: [ORG_C, ORG_D] } } });
}

async function seed() {
  const orgBase = {
    status: "active",
    defaultCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    locale: "en-MY",
    subscriptionPlan: "free",
  };
  await db().organization.create({
    data: { id: ORG_C, name: "Tracker Svc Test Org C", slug: "trk-svc-c", ...orgBase },
  });
  await db().organization.create({
    data: { id: ORG_D, name: "Tracker Svc Test Org D", slug: "trk-svc-d", ...orgBase },
  });

  // The audit actor must be a real User (AuditLog.actorUserId FK, Restrict).
  await db().user.create({
    data: {
      id: USER_C, organizationId: ORG_C, email: "manager@trk-svc.test",
      fullName: "Tracker Manager", passwordHash: "x", status: "active", role: "manager",
    },
  });

  await db().property.create({
    data: {
      id: PROP_C, organizationId: ORG_C, name: "Tracker Svc Property C",
      propertyCode: "TRK-S-C", propertyType: "residential", addressLine1: "3 Test St",
      city: "Kuala Lumpur", country: "MY", status: "active", publishStatus: "draft",
    },
  });
  await db().apartment.create({
    data: {
      id: APT_C, organizationId: ORG_C, propertyId: PROP_C,
      unitCode: "C-1-1", listingMode: "PARTITIONED",
    },
  });
  const listingBase = {
    organizationId: ORG_C, apartmentId: APT_C, listingStatus: "active",
    currency: "MYR", occupancyStatus: "vacant",
  };
  await db().listing.create({ data: { id: L_ROOM, listingType: "Master", ...listingBase } });
  await db().listing.create({ data: { id: L_ROOM2, listingType: "Studio", ...listingBase } });

  await db().party.create({
    data: {
      id: P_PIC, organizationId: ORG_C, partyType: "individual", displayName: "PIC Person",
      status: "active", idNumber: "880808-08-8888",
    },
  });
  await db().party.create({
    data: {
      id: P_NOIC, organizationId: ORG_C, partyType: "tenant", displayName: "No Ic",
      status: "active",
    },
  });
  await db().party.create({
    data: {
      id: P_D, organizationId: ORG_D, partyType: "tenant", displayName: "Org-D Outsider",
      status: "active", idNumber: "770707-07-7777",
    },
  });
}

dn("tenant-tracker service (integration)", () => {
  beforeAll(async () => {
    // Guard: this suite mutates data — local postgres ONLY.
    const url = process.env.DATABASE_URL ?? "";
    if (!/localhost|127\.0\.0\.1/.test(url)) {
      throw new Error("RUN_INTEGRATION requires a LOCAL postgres DATABASE_URL");
    }
    await cleanup(); // defensively clear residue from a crashed prior run
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("assignInChargeService — audit row in the SAME tx", () => {
    it("assign persists the pair AND exactly one audit row with the before/after diff", async () => {
      const before = await auditCount("leasing.unit.assign_in_charge");

      const res = await assignInChargeService(session(), L_ROOM, { inChargePartyId: P_PIC });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.data).toEqual({ inChargePartyId: P_PIC, inChargeName: "PIC Person" });

      expect(await listingState(L_ROOM)).toEqual({
        inChargePartyId: P_PIC,
        inChargeName: "PIC Person",
      });

      expect(await auditCount("leasing.unit.assign_in_charge")).toBe(before + 1);
      const row = await db().auditLog.findFirst({
        where: { organizationId: ORG_C, action: "leasing.unit.assign_in_charge" },
        orderBy: { createdAt: "desc" },
      });
      expect(row).toMatchObject({
        actorUserId: USER_C,
        actorRole: "manager",
        entityType: "Listing",
        entityId: L_ROOM,
      });
      expect(row?.diff).toEqual({
        before: { inChargePartyId: null, inChargeName: null },
        after: { inChargePartyId: P_PIC, inChargeName: "PIC Person" },
      });
    });

    it("ROLLBACK: when the audit insert fails (real FK violation), the assign rolls back too", async () => {
      const before = await auditCount();

      // GHOST_USER does not exist → recordAudit's AuditLog INSERT violates
      // the actorUserId FK inside the tx. No stubbing — real Prisma, real
      // constraint, real rollback.
      await expect(
        assignInChargeService(session(GHOST_USER), L_ROOM2, { inChargePartyId: P_PIC }),
      ).rejects.toThrow();

      expect(await listingState(L_ROOM2)).toEqual({
        inChargePartyId: null,
        inChargeName: null,
      }); // the listing update was rolled back
      expect(await auditCount()).toBe(before); // and no audit row exists
    });

    it("stale expectedUpdatedAt → 409 STALE, no write, no audit row", async () => {
      const before = await auditCount();
      const snapshot = await listingState(L_ROOM2);

      const res = await assignInChargeService(session(), L_ROOM2, {
        inChargePartyId: P_PIC,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected not ok");
      expect(res.status).toBe(409);
      expect(res.error).toBe("STALE");

      expect(await listingState(L_ROOM2)).toEqual(snapshot);
      expect(await auditCount()).toBe(before);
    });

    it("matching expectedUpdatedAt round-trips through the updatedAt-in-WHERE update", async () => {
      const current = await db().listing.findUnique({
        where: { id: L_ROOM2 },
        select: { updatedAt: true },
      });
      if (!current) throw new Error("fixture listing missing");

      const res = await assignInChargeService(session(), L_ROOM2, {
        inChargePartyId: P_PIC,
        expectedUpdatedAt: current.updatedAt.toISOString(),
      });
      expect(res.ok).toBe(true);
      expect(await listingState(L_ROOM2)).toEqual({
        inChargePartyId: P_PIC,
        inChargeName: "PIC Person",
      });
    });

    it("unassign (null) clears both columns and audits the transition", async () => {
      const res = await assignInChargeService(session(), L_ROOM, { inChargePartyId: null });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.data).toEqual({ inChargePartyId: null, inChargeName: null });
      expect(await listingState(L_ROOM)).toEqual({ inChargePartyId: null, inChargeName: null });

      const row = await db().auditLog.findFirst({
        where: { organizationId: ORG_C, action: "leasing.unit.assign_in_charge", entityId: L_ROOM },
        orderBy: { createdAt: "desc" },
      });
      expect(row?.diff).toEqual({
        before: { inChargePartyId: P_PIC, inChargeName: "PIC Person" },
        after: { inChargePartyId: null, inChargeName: null },
      });
    });

    it("cross-org assignee → 404, nothing written", async () => {
      const before = await auditCount();
      const snapshot = await listingState(L_ROOM2);

      const res = await assignInChargeService(session(), L_ROOM2, { inChargePartyId: P_D });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected not ok");
      expect(res.status).toBe(404);

      expect(await listingState(L_ROOM2)).toEqual(snapshot);
      expect(await auditCount()).toBe(before);
    });

    it("unknown unit → 404", async () => {
      const res = await assignInChargeService(session(), "cc200000-0000-4000-8000-0000000000ff", {
        inChargePartyId: P_PIC,
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected not ok");
      expect(res.status).toBe(404);
    });
  });

  describe("recordIcRevealService — audited unmasked path", () => {
    it("returns the raw idNumber and writes one ic_reveal audit row in the same tx", async () => {
      const before = await auditCount("leasing.tenant.ic_reveal");

      const res = await recordIcRevealService(session(), P_PIC);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.data).toEqual({ partyId: P_PIC, idNumber: "880808-08-8888" });

      expect(await auditCount("leasing.tenant.ic_reveal")).toBe(before + 1);
      const row = await db().auditLog.findFirst({
        where: { organizationId: ORG_C, action: "leasing.tenant.ic_reveal" },
        orderBy: { createdAt: "desc" },
      });
      expect(row).toMatchObject({
        actorUserId: USER_C,
        actorRole: "manager",
        entityType: "Party",
        entityId: P_PIC,
      });
    });

    it("party without idNumber → 404 NO_IC and NO audit row (documented choice)", async () => {
      const before = await auditCount("leasing.tenant.ic_reveal");
      const res = await recordIcRevealService(session(), P_NOIC);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected not ok");
      expect(res.status).toBe(404);
      expect(res.error).toBe("NO_IC");
      expect(await auditCount("leasing.tenant.ic_reveal")).toBe(before);
    });

    it("cross-org party → 404, no audit row, no leak", async () => {
      const before = await auditCount("leasing.tenant.ic_reveal");
      const res = await recordIcRevealService(session(), P_D);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected not ok");
      expect(res.status).toBe(404);
      expect(await auditCount("leasing.tenant.ic_reveal")).toBe(before);
    });
  });
});
