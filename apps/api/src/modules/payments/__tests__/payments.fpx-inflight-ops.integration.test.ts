/**
 * Item 3 (FPX ops polish) — integration tests for the admin in-flight-FPX view +
 * cancel, against a real LOCAL Postgres.
 *
 *   - listInFlightFpxService lists ONLY in-flight FPX rows (provider "fpx-mock",
 *     gatewayStatus "pending", status "pending_approval") — excluding settled
 *     FPX, manual pending, and posted-but-stamp-crashed rows.
 *   - cancelInFlightFpxService expires a stuck in-flight row (→ "expired"),
 *     writes a `payment.fpx_cancelled` audit, and leaves charges untouched.
 *   - cancelInFlightFpxService 400s on a settled/posted row and a manual one, and
 *     404s on a missing id.
 *
 * Skipped by default. Run:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_FPX=1 \
 *   DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *   npx vitest run src/modules/payments/__tests__/payments.fpx-inflight-ops.integration.test.ts
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listInFlightFpxService, cancelInFlightFpxService } from "../payments.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint prefix (fb) from sibling suites.
const ORG = "fb000000-0000-4000-8000-000000000001";
const PARTY = "fb000000-0000-4000-8000-000000000002";
const USER_ID = "fb000000-0000-4000-8000-000000000099";
const FPX_INFLIGHT = "fb000000-0000-4000-8000-000000000010"; // pending_approval, gatewayStatus "pending"
const FPX_SETTLED = "fb000000-0000-4000-8000-000000000011"; // posted, gatewayStatus "success"
const MANUAL_PENDING = "fb000000-0000-4000-8000-000000000012"; // pending_approval, gatewayStatus null
const FPX_STAMP_CRASHED = "fb000000-0000-4000-8000-000000000013"; // posted, gatewayStatus "pending"

const session = { userId: USER_ID, orgId: ORG, role: "admin" };

async function cleanup() {
  const db = getDb();
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "FB Ops Org", slug: "fb-ops", status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: { id: USER_ID, organizationId: ORG, email: "fb@example.test", fullName: "FB Admin", status: "active", role: "admin", userType: "operator" },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "FB Payer", partyType: "individual", status: "active" },
  });
  const common = { organizationId: ORG, partyId: PARTY, paymentType: "incoming", currency: "MYR", receivedAt: new Date() };
  await db.payment.create({
    data: { ...common, id: FPX_INFLIGHT, paymentNumber: "PAY-FB-INFLIGHT", paymentMethod: "fpx", provider: "fpx-mock", providerTxnId: "fb-txn-0001", gatewayStatus: "pending", status: "pending_approval", amount: "400.00", createdAt: new Date(Date.now() - 90 * 60_000) },
  });
  await db.payment.create({
    data: { ...common, id: FPX_SETTLED, paymentNumber: "PAY-FB-SETTLED", paymentMethod: "fpx", provider: "fpx-mock", providerTxnId: "fb-txn-0002", gatewayStatus: "success", status: "posted", amount: "600.00" },
  });
  await db.payment.create({
    data: { ...common, id: MANUAL_PENDING, paymentNumber: "PAY-FB-MANUAL", paymentMethod: "bank_transfer", status: "pending_approval", amount: "300.00" },
  });
  await db.payment.create({
    data: { ...common, id: FPX_STAMP_CRASHED, paymentNumber: "PAY-FB-STAMPCRASH", paymentMethod: "fpx", provider: "fpx-mock", providerTxnId: "fb-txn-0003", gatewayStatus: "pending", status: "posted", amount: "700.00" },
  });
}

dn("admin in-flight FPX ops (list + cancel)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("listInFlightFpxService returns ONLY the in-flight FPX row (with payer + age), excluding settled/manual/posted", async () => {
    const { data } = await listInFlightFpxService(session);
    const ids = data.map((r) => r.id);
    expect(ids).toEqual([FPX_INFLIGHT]);

    const row = data[0];
    expect(row.partyName).toBe("FB Payer");
    expect(row.amount).toBe(400);
    expect(row.ageMinutes).toBeGreaterThanOrEqual(89); // ~90 min old
  });

  it("cancelInFlightFpxService expires the in-flight row, writes an audit, and leaves it off the list", async () => {
    const db = getDb();
    const r = await cancelInFlightFpxService(session, FPX_INFLIGHT);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);

    const row = await db.payment.findUnique({ where: { id: FPX_INFLIGHT } });
    expect(row!.status).toBe("expired");
    // `cancelled`, NOT `expired` — the two mean different things to the callback
    // path. `cancelled` records that a HUMAN closed this off, so a late signed
    // success parks it for review (the payer was probably debited) instead of
    // silently reviving a row someone deliberately shut. Changed by 9f01e84b
    // "stop destroying late gateway settlements".
    expect(row!.gatewayStatus).toBe("cancelled");

    const audits = await db.auditLog.findMany({ where: { organizationId: ORG, action: "payment.fpx_cancelled", entityId: FPX_INFLIGHT } });
    expect(audits).toHaveLength(1);

    const { data } = await listInFlightFpxService(session);
    expect(data.map((x) => x.id)).not.toContain(FPX_INFLIGHT);
  });

  it("cancelInFlightFpxService 400s on a settled/posted FPX payment; row unchanged", async () => {
    const db = getDb();
    const r = await cancelInFlightFpxService(session, FPX_SETTLED);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);

    const row = await db.payment.findUnique({ where: { id: FPX_SETTLED } });
    expect(row!.status).toBe("posted");
    expect(row!.gatewayStatus).toBe("success");
  });

  it("cancelInFlightFpxService 400s on a manual pending (non-FPX) payment", async () => {
    const r = await cancelInFlightFpxService(session, MANUAL_PENDING);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("cancelInFlightFpxService 400s on a posted-but-stamp-crashed FPX row (status posted, gatewayStatus pending)", async () => {
    const r = await cancelInFlightFpxService(session, FPX_STAMP_CRASHED);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("cancelInFlightFpxService 404s on a missing payment id", async () => {
    const r = await cancelInFlightFpxService(session, "fb000000-0000-4000-8000-0000000000ff");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });
});
