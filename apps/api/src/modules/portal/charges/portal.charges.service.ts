import { getDb } from "@kason/db";
import { isTenantPayableChargeStatus } from "@kason/shared";
import type { PaymentSubmissionInput } from "@kason/shared";

function toNumber(value: { toString(): string } | string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.toString());
}

type SessionScope = { partyId: string; orgId: string; userId: string };

export async function submitPayment(session: SessionScope, chargeId: string, input: PaymentSubmissionInput) {
  const db = getDb();

  const charge = await db.charge.findFirst({
    where: { id: chargeId, partyId: session.partyId, organizationId: session.orgId },
    select: { id: true, status: true, outstandingAmount: true, chargeNumber: true },
  });

  if (!charge) return { ok: false as const, status: 404, error: "Charge not found" };

  // Third copy of the payability rule in this codebase, now sourced from the
  // shared allow-list so it cannot drift from the two in portal.payments.repository.
  if (!isTenantPayableChargeStatus(charge.status)) {
    return { ok: false as const, status: 400, error: `Charge is ${charge.status} and cannot be paid` };
  }

  const outstanding = toNumber(charge.outstandingAmount);
  if (input.amount > outstanding) {
    return { ok: false as const, status: 400, error: `Amount exceeds outstanding balance of ${outstanding}` };
  }
  if (input.amount < outstanding - 0.005) {
    return { ok: false as const, status: 400, error: "This charge must be paid in full." };
  }

  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const paymentNumber = `PAY-${ts}-${rand}`.toUpperCase();

  const payment = await db.payment.create({
    data: {
      organizationId: session.orgId,
      paymentNumber,
      partyId: session.partyId,
      paymentType: "incoming",
      paymentMethod: input.paymentMethod,
      status: "pending_approval",
      amount: input.amount,
      currency: "MYR",
      receivedAt: new Date(),
      referenceNote: input.notes ?? null,
      externalReference: chargeId,
    },
    select: { id: true, paymentNumber: true },
  });

  await db.notification.create({
    data: {
      organizationId: session.orgId,
      domain: "finance",
      title: `Payment submitted: ${paymentNumber}`,
      body: `Tenant submitted ${input.paymentMethod} payment of MYR ${input.amount.toFixed(2)} for charge ${charge.chargeNumber}. Reference: ${input.referenceNumber}`,
      actionUrl: "/billing/payments",
    },
  });

  return { ok: true as const, status: 201, data: { id: payment.id, paymentNumber: payment.paymentNumber } };
}
