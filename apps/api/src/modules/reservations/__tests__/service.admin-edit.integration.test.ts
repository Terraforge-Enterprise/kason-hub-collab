/**
 * Integration tests for adminEditAfterSigningService + getReservationEditHistory.
 *
 * Spec §5.3: signed reservations can be edited by admin role with a mandatory
 * audit-logged reason. Every edit writes exactly ONE AuditLog row with
 * action=admin_edit_after_signing, before/after diff, and meta.reason inside
 * the same transaction as the UnitReservation update.
 *
 * Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/service.admin-edit.integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import {
  adminEditAfterSigningService,
  getReservationEditHistory,
} from "../service";
import type { ReservationSession } from "../types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Unique UUID prefix (cccc...) — distinct from sibling integration tests.
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccd";
const AGENT_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccce0";
const AGENT_PARTY = "cccccccc-cccc-4ccc-8ccc-ccccccccccce";
const PROPERTY = "cccccccc-cccc-4ccc-8ccc-cccccccccccf";
const APARTMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccd0a";
const UNIT = "cccccccc-cccc-4ccc-8ccc-cccccccccd00";

const adminCtx: ReservationSession = {
  orgId: ORG,
  userId: ADMIN_USER,
  partyId: "",
  role: "admin",
  operatorRole: "admin",
};

const agentCtx: ReservationSession = {
  orgId: ORG,
  userId: AGENT_USER,
  partyId: AGENT_PARTY,
  role: "agent",
};

async function seedFixture() {
  const db = getDb();
  // Reverse-FK cleanup.
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservationTransition.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.documentTemplate.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });

  await db.organization.create({
    data: {
      id: ORG,
      name: "Admin-Edit Test Org",
      slug: "admin-edit-test",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
      reservationLinkExpiryDays: 7,
    },
  });
  // Actor user — AuditLog has an FK onto User; the integration test must seed
  // the admin actor or the audit insert will fail at the FK boundary.
  await db.user.create({
    data: {
      id: ADMIN_USER,
      organizationId: ORG,
      email: "admin@admin-edit.test",
      fullName: "Edit Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
  await db.party.create({
    data: {
      id: AGENT_PARTY,
      organizationId: ORG,
      displayName: "Agent",
      partyType: "agent",
      status: "active",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "Admin-Edit Test Property",
      propertyCode: "AETP-1",
      propertyType: "residential",
      addressLine1: "1 Edit St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APARTMENT,
      organizationId: ORG,
      propertyId: PROPERTY,
      unitCode: "E-101",
      listingMode: "WHOLE",
    },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      currency: "MYR",
      readyNow: true,
      ownerPartyId: AGENT_PARTY,
    },
  });
}

async function seedReservation(status: "signed" | "pending_customer" | "pending_approval") {
  const db = getDb();
  return db.unitReservation.create({
    data: {
      organizationId: ORG,
      referenceCode: `RES-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      status,
      issuedByPartyId: AGENT_PARTY,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      publicToken: `admedit${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      propertyId: PROPERTY,
      unitId: UNIT,
      carPark: "P-12",
      proposedMoveIn: new Date("2026-09-01T00:00:00Z"),
      proposedMoveOut: null,
      specialRemarks: null,
      reservationDeposit: "500.00",
      documentationFee: "100.00",
      rentalDeposit: "2400.00",
      utilityDeposit: "300.00",
      accessCardDeposit: "50.00",
      applicantFullName: "Tenan Smith",
      applicantNric: "900101-14-2222",
      applicantContact: "+60198765432",
      applicantEmail: "tenant@example.test",
      ...(status === "signed"
        ? {
            signedAt: new Date(),
            signedFromIp: "127.0.0.1",
            signedUserAgent: "test",
            signatureDrawingKey: `reservations/seeded/${Date.now()}/sig.png`,
            signatureTypedName: "Tenan Smith",
            signatureAgreementTickedAt: new Date(),
            signedPdfKey: `reservations/seeded/${Date.now()}/signed.pdf`,
          }
        : {}),
    },
  });
}

dn("adminEditAfterSigningService (integration)", () => {
  beforeAll(async () => {
    await seedFixture();
  });
  beforeEach(async () => {
    const db = getDb();
    // Per-test reset of reservations + audit, but keep org/user/unit fixtures.
    await db.auditLog.deleteMany({ where: { organizationId: ORG } });
    await db.unitReservationTransition.deleteMany({ where: { organizationId: ORG } });
    await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  });

  // D2: admin signed-edits now trigger a reset to pending_customer. The
  // signed PDF + signature keys are nulled and the legal artifacts get
  // deleted from S3 (best-effort, post-commit). The audit row uses the
  // new admin_edit_signed_reset action code; legacy rows with
  // admin_edit_after_signing remain queryable via the edit-history surface.
  it("updates a signed reservation, flips it to pending_customer, nulls signature fields, writes one admin_edit_signed_reset audit row", async () => {
    const signed = await seedReservation("signed");

    const result = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: {
        applicantFullName: "Tenant Corrected Name",
        reservationDeposit: "550.00",
      },
      reason: "Tenant typo correction per email 2026-05-19",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(200);

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: signed.id } });
    expect(after.applicantFullName).toBe("Tenant Corrected Name");
    expect(after.reservationDeposit.toString()).toBe("550");

    // D2 reset semantics: row flips to pending_customer; signature fields nulled.
    expect(after.status).toBe("pending_customer");
    expect(after.signedAt).toBeNull();
    expect(after.signedFromIp).toBeNull();
    expect(after.signedUserAgent).toBeNull();
    expect(after.signatureDrawingKey).toBeNull();
    expect(after.signatureTypedName).toBeNull();
    expect(after.signatureAgreementTickedAt).toBeNull();
    expect(after.signedPdfKey).toBeNull();

    const auditRows = await db.auditLog.findMany({
      where: {
        entityType: "UnitReservation",
        entityId: signed.id,
        action: "admin_edit_signed_reset",
      },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].meta).toMatchObject({
      reason: "Tenant typo correction per email 2026-05-19",
    });
    // Diff is a JSON-safe shape (Decimal → string, Date → ISO).
    const diff = auditRows[0].diff as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(diff.before.applicantFullName).toBe("Tenan Smith");
    expect(diff.after.applicantFullName).toBe("Tenant Corrected Name");
    expect(diff.before.reservationDeposit).toBe("500");
    expect(diff.after.reservationDeposit).toBe("550");
    expect(diff.before.status).toBe("signed");
    expect(diff.after.status).toBe("pending_customer");

    // A transition row marks the signed → pending_customer flip.
    const txns = await db.unitReservationTransition.findMany({
      where: { reservationId: signed.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].fromStatus).toBe("signed");
    expect(txns[0].toStatus).toBe("pending_customer");
    expect(txns[0].note).toBe("Tenant typo correction per email 2026-05-19");
  });

  it("rejects non-admin actors with 403 and writes NO audit row", async () => {
    const signed = await seedReservation("signed");

    const result = await adminEditAfterSigningService(agentCtx, signed.id, {
      patch: { reservationDeposit: "600.00" },
      reason: "agent trying to edit a signed row",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(403);

    const db = getDb();
    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: signed.id } });
    expect(row.reservationDeposit.toString()).toBe("500");
    const audits = await db.auditLog.findMany({ where: { organizationId: ORG } });
    expect(audits).toHaveLength(0);
  });

  it("rejects editor operatorRole with 403 (only admin/manager may admin-edit)", async () => {
    const signed = await seedReservation("signed");

    const editorCtx: ReservationSession = {
      ...adminCtx,
      operatorRole: "editor",
    };

    const result = await adminEditAfterSigningService(editorCtx, signed.id, {
      patch: { reservationDeposit: "600.00" },
      reason: "editor trying to admin-edit a signed row",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(403);
  });

  it("accepts pending_customer (awaiting tenant) reservations and writes admin_edit_pending_customer audit", async () => {
    const pending = await seedReservation("pending_customer");

    const result = await adminEditAfterSigningService(adminCtx, pending.id, {
      patch: { reservationDeposit: "600.00" },
      reason: "tenant requested deposit change before signing",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.status).toBe(200);

    const db = getDb();
    const after = await db.unitReservation.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.reservationDeposit.toString()).toBe("600");
    // Status stays pending_customer — admin edits never advance status.
    expect(after.status).toBe("pending_customer");

    const audits = await db.auditLog.findMany({
      where: { entityType: "UnitReservation", entityId: pending.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("admin_edit_pending_customer");
    expect(audits[0].meta).toMatchObject({
      reason: "tenant requested deposit change before signing",
    });
  });

  it("rejects non-editable statuses (pending_approval) with 409", async () => {
    const pending = await seedReservation("pending_approval");

    const result = await adminEditAfterSigningService(adminCtx, pending.id, {
      patch: { reservationDeposit: "600.00" },
      reason: "trying to edit a pending_approval reservation",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(409);
  });

  it("returns 404 when the reservation does not exist in the actor's org", async () => {
    const result = await adminEditAfterSigningService(
      adminCtx,
      "00000000-0000-0000-0000-000000000000",
      { patch: {}, reason: "valid 10-char reason" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected fail");
    expect(result.status).toBe(404);
  });

  // D5: customTerms are now editable via the admin-edit path. Replaces the
  // previous "T&Cs are out of scope" semantics; the diff records the array
  // change so the audit log preserves the original clauses.
  it("admin may edit customTerms; the diff captures before/after lists", async () => {
    const db = getDb();
    const signed = await seedReservation("signed");
    await db.unitReservation.update({
      where: { id: signed.id },
      data: { customTerms: ["Original clause one.", "Original clause two."] },
    });

    const result = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: {
        customTerms: ["Revised clause one.", "Revised clause two.", "New clause three."],
      },
      reason: "admin clause revision per client request",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const row = await db.unitReservation.findUniqueOrThrow({ where: { id: signed.id } });
    expect(row.customTerms).toEqual([
      "Revised clause one.",
      "Revised clause two.",
      "New clause three.",
    ]);

    const audits = await db.auditLog.findMany({
      where: { entityType: "UnitReservation", entityId: signed.id },
    });
    expect(audits).toHaveLength(1);
    const diff = audits[0].diff as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(diff.before.customTerms).toEqual(["Original clause one.", "Original clause two."]);
    expect(diff.after.customTerms).toEqual([
      "Revised clause one.",
      "Revised clause two.",
      "New clause three.",
    ]);
  });

  it("multiple successful edits all write distinct AuditLog rows", async () => {
    const signed = await seedReservation("signed");

    const r1 = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: { applicantContact: "+60100000001" },
      reason: "first correction per email A",
    });
    const r2 = await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: { applicantContact: "+60100000002" },
      reason: "second correction per email B",
    });
    expect(r1.ok && r2.ok).toBe(true);

    const audits = await getDb().auditLog.findMany({
      where: { entityType: "UnitReservation", entityId: signed.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect((audits[0].meta as { reason: string }).reason).toBe("first correction per email A");
    expect((audits[1].meta as { reason: string }).reason).toBe("second correction per email B");
  });
});

dn("getReservationEditHistory (integration)", () => {
  beforeAll(async () => {
    await seedFixture();
  });
  beforeEach(async () => {
    const db = getDb();
    await db.auditLog.deleteMany({ where: { organizationId: ORG } });
    await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  });

  it("returns empty entries when no admin edits exist", async () => {
    const signed = await seedReservation("signed");
    const res = await getReservationEditHistory(adminCtx, signed.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.entries).toEqual([]);
  });

  it("returns entries ordered newest-first with actor full name + reason", async () => {
    const signed = await seedReservation("signed");
    await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: { applicantContact: "+60100000001" },
      reason: "first reason explained here",
    });
    await adminEditAfterSigningService(adminCtx, signed.id, {
      patch: { applicantContact: "+60100000002" },
      reason: "second reason explained here",
    });

    const res = await getReservationEditHistory(adminCtx, signed.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.entries).toHaveLength(2);
    // Newest first
    expect(res.data.entries[0].reason).toBe("second reason explained here");
    expect(res.data.entries[1].reason).toBe("first reason explained here");
    expect(res.data.entries[0].actorName).toBe("Edit Admin");
  });

  it("rejects non-admin actors with 403", async () => {
    const signed = await seedReservation("signed");
    const res = await getReservationEditHistory(agentCtx, signed.id);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected fail");
    expect(res.status).toBe(403);
  });
});
