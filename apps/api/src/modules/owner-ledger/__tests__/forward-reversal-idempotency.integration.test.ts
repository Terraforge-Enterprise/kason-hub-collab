/**
 * REGRESSION (companion to Commit 2 schema): the closed-period migration narrows the
 * (organizationId, sourceType, sourceChargeId) unique to a PARTIAL index, which removes the
 * Prisma-level compound where-input `organizationId_sourceType_sourceChargeId`. The existing
 * money path postForwardReversalForFrozenMonth() upserted the "reversal" row on that key. This
 * test pins the behavior that must survive the swap: exactly ONE forward-reversal row per
 * void/credited frozen-month charge, idempotent on re-run (the DB partial index still covers the
 * non-excluded "reversal" sourceType; idempotency now rides ON CONFLICT DO NOTHING).
 *
 * Gated on RUN_INTEGRATION=1; refuses any non-local DB host.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { postForwardReversalForFrozenMonth } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "c2f10000-0000-4000-8000-000000000001";
const OWNER = "c2f10000-0000-4000-8000-000000000002";
const USER = "c2f10000-0000-4000-8000-000000000003";
const PROP = "c2f10000-0000-4000-8000-000000000004";
const CHARGE = "c2f10000-0000-4000-8000-00000000000a";

const FROZEN_M = "2026-03";
const frozenStart = new Date(Date.UTC(2026, 2, 1));
const actor: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "Fwd-Reversal Idem Org", slug: "c2f1-fwd-reversal", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  // A source charge, VOIDED at source (so the frozen paid row needs a forward reversal).
  await db.charge.create({
    data: {
      id: CHARGE,
      organizationId: ORG,
      chargeNumber: "C2F1-0001",
      partyId: OWNER,
      chargeType: "rent",
      status: "void",
      dueDate: frozenStart,
      billingMonth: frozenStart,
      amount: "1000.00",
      outstandingAmount: "0.00",
      currency: "MYR",
    },
  });
  // The paid, active frozen-month owner-ledger row sourced from that charge (income to the owner).
  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      propertyId: PROP,
      statementMonth: frozenStart,
      transactionDate: frozenStart,
      direction: "income",
      category: "rental_income",
      amount: "1000.00",
      paidBy: "kaen",
      paymentStatus: "paid",
      sourceType: "rent",
      sourceChargeId: CHARGE,
      createdById: USER,
      updatedById: USER,
    },
  });
}

dn("postForwardReversalForFrozenMonth — idempotent after unique swap (integration)", () => {
  beforeAll(async () => {
    await cleanup().catch(() => {});
  });
  afterAll(cleanup);
  beforeEach(async () => {
    await cleanup().catch(() => {});
    await seed();
  });

  const reversalRows = () =>
    getDb().ownerLedgerEntry.findMany({ where: { organizationId: ORG, sourceType: "reversal", sourceChargeId: CHARGE } });

  it("B8: books exactly one forward-reversal (income→expense) for the voided frozen charge", async () => {
    const res = await postForwardReversalForFrozenMonth(actor, OWNER, FROZEN_M);
    expect(res.reversed).toBe(1);
    const rows = await reversalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe("expense"); // flipped from the original income
  });

  it("B8-idem: running twice leaves exactly one forward-reversal row (idempotent on the partial unique)", async () => {
    await postForwardReversalForFrozenMonth(actor, OWNER, FROZEN_M);
    await postForwardReversalForFrozenMonth(actor, OWNER, FROZEN_M);
    expect(await reversalRows()).toHaveLength(1);
  });
});
