import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  charge: { findFirst: vi.fn() },
  payment: { create: vi.fn() },
  notification: { create: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

import { submitPayment } from "../portal.charges.service";

const session = { partyId: "p1", orgId: "org1", userId: "u1" };

describe("submitPayment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects non-existent charge", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce(null);
    const result = await submitPayment(session, "bad-id", {
      amount: 100, paymentMethod: "fpx", referenceNumber: "REF-001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("rejects payment on void charge", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "void", outstandingAmount: 0, chargeNumber: "CHG-001" });
    const result = await submitPayment(session, "c1", {
      amount: 100, paymentMethod: "fpx", referenceNumber: "REF-001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("void");
  });

  it("rejects amount exceeding outstanding", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "posted", outstandingAmount: 500, chargeNumber: "CHG-001" });
    const result = await submitPayment(session, "c1", {
      amount: 600, paymentMethod: "fpx", referenceNumber: "REF-001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exceeds");
  });

  it("rejects amount less than outstanding (underpayment)", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "posted", outstandingAmount: 1500, chargeNumber: "CHG-001" });
    // No payment/notification create stub needed here: the underpay guard
    // returns before either is ever called. Queuing a mockResolvedValueOnce
    // for them anyway would go unconsumed and leak into whichever test runs
    // next — vi.clearAllMocks() in beforeEach clears call history but does
    // NOT drain queued *Once values, so a stray one silently shadows the
    // next test's own stub.
    const result = await submitPayment(session, "c1", {
      amount: 500, paymentMethod: "fpx", referenceNumber: "REF-003",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("paid in full");
    }
    expect(mockDb.payment.create).not.toHaveBeenCalled();
  });

  it("accepts payment exactly equal to outstanding (±0.005 tolerance boundary)", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "posted", outstandingAmount: 1500, chargeNumber: "CHG-001" });
    mockDb.payment.create.mockResolvedValueOnce({ id: "pay-boundary-exact", paymentNumber: "PAY-BOUNDARY-EXACT" });
    mockDb.notification.create.mockResolvedValueOnce({});

    const result = await submitPayment(session, "c1", {
      amount: 1500, paymentMethod: "fpx", referenceNumber: "REF-004",
    });

    expect(result.ok).toBe(true);
    expect(mockDb.payment.create).toHaveBeenCalledTimes(1);
  });

  it("rejects payment one sen under outstanding as underpayment (±0.005 tolerance boundary)", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "posted", outstandingAmount: 1500, chargeNumber: "CHG-001" });

    const result = await submitPayment(session, "c1", {
      amount: 1499.99, paymentMethod: "fpx", referenceNumber: "REF-005",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("paid in full");
    }
    expect(mockDb.payment.create).not.toHaveBeenCalled();
  });

  it("rejects payment one sen over outstanding as exceeding (±0.005 tolerance boundary)", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "posted", outstandingAmount: 1500, chargeNumber: "CHG-001" });

    const result = await submitPayment(session, "c1", {
      amount: 1500.01, paymentMethod: "fpx", referenceNumber: "REF-006",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("exceeds");
    }
    expect(mockDb.payment.create).not.toHaveBeenCalled();
  });

  it("creates pending_approval payment and notification", async () => {
    mockDb.charge.findFirst.mockResolvedValueOnce({ id: "c1", status: "posted", outstandingAmount: 1500, chargeNumber: "CHG-001" });
    mockDb.payment.create.mockResolvedValueOnce({ id: "pay1", paymentNumber: "PAY-TEST" });
    mockDb.notification.create.mockResolvedValueOnce({});

    const result = await submitPayment(session, "c1", {
      amount: 1500, paymentMethod: "bank_transfer", referenceNumber: "REF-002",
    });
    expect(result.ok).toBe(true);
    expect(mockDb.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "pending_approval",
          paymentType: "incoming",
          externalReference: "c1",
        }),
      }),
    );
    expect(mockDb.notification.create).toHaveBeenCalledTimes(1);
  });
});
