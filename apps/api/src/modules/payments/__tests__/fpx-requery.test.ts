/**
 * FPX requery sweep — the ACTIVE half of settlement.
 *
 * The property under test throughout is asymmetry: a VERIFIED gateway answer may
 * change a payment, and ANY other outcome may not. "We could not find out" and
 * "the gateway says it failed" must never collapse into the same behaviour —
 * conflating them is how a live payment gets terminated while the payer's money
 * is still moving through the bank.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/fpx", () => ({ getFpxGateway: vi.fn() }));
vi.mock("../fpx-callback.service", () => ({ applyVerifiedFpxOutcome: vi.fn() }));
vi.mock("../fpx-callback.repository", () => ({ findPendingFpxPaymentsForRequery: vi.fn() }));

import { getFpxGateway } from "../../../lib/fpx";
import { applyVerifiedFpxOutcome } from "../fpx-callback.service";
import { findPendingFpxPaymentsForRequery } from "../fpx-callback.repository";
import { runFpxRequerySweep, requeryTenantStaleFpx } from "../fpx-requery.service";

const queryStatus = vi.fn();

function candidate(over: Partial<{ id: string; providerTxnId: string; providerTranId: string | null; amount: string }> = {}) {
  return {
    id: over.id ?? "pay-1",
    organizationId: "org-1",
    providerTxnId: over.providerTxnId ?? "order-1",
    providerTranId: over.providerTranId === undefined ? null : over.providerTranId,
    amount: over.amount ?? "150.00",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getFpxGateway).mockReturnValue({ queryStatus } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(applyVerifiedFpxOutcome).mockResolvedValue({ ok: true, status: 200, applied: "settled" } as any);
});

// Every test passes queryIntervalMs: 0 — the real 5s spacing is asserted
// separately rather than paid for in every case.
const FAST = { queryIntervalMs: 0 };

describe("runFpxRequerySweep — verified answers", () => {
  it("settles a payment the gateway confirms, through the SAME handler as a callback", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockResolvedValue({ ok: true, status: "success", providerTranId: "fiuu-77" });

    const r = await runFpxRequerySweep(FAST);

    expect(r).toMatchObject({ checked: 1, settled: 1, failed: 0, stillPending: 0, unresolved: 0 });
    // Routed through applyVerifiedFpxOutcome, NOT a parallel settle path — that
    // shared function is what makes a poll and a push settle identically.
    expect(applyVerifiedFpxOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        providerTxnId: "order-1",
        providerTranId: "fiuu-77",
        status: "success",
      }),
    );
  });

  it("passes the gateway's OWN figures through, so the poll gets the same amount check as the push", async () => {
    // Omitting these skipped the comparison entirely on this channel — and this
    // is the channel that had just been made functional, so the hole arrived
    // with the fix that made it reachable. A RM1 reply settled a RM150 charge.
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockResolvedValue({ ok: true, status: "success", amount: "1.00", currency: "MYR" });

    await runFpxRequerySweep(FAST);

    expect(applyVerifiedFpxOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "1.00", currency: "MYR" }),
    );
  });

  it("marks failed only when the gateway itself says failed", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockResolvedValue({ ok: true, status: "failed" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(applyVerifiedFpxOutcome).mockResolvedValue({ ok: true, status: 200, applied: "failed" } as any);

    const r = await runFpxRequerySweep(FAST);

    expect(r).toMatchObject({ checked: 1, settled: 0, failed: 1 });
    expect(applyVerifiedFpxOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("leaves a still-pending payment completely untouched", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockResolvedValue({ ok: true, status: "pending" });

    const r = await runFpxRequerySweep(FAST);

    expect(r).toMatchObject({ checked: 1, stillPending: 1, settled: 0, failed: 0 });
    expect(applyVerifiedFpxOutcome).not.toHaveBeenCalled();
  });
});

describe("runFpxRequerySweep — anything short of a verified answer changes NOTHING", () => {
  // Table-driven so a new `ok:false` reason cannot be added without deciding
  // whether it may terminate a payment. The answer is always no.
  const unverified = [
    ["transport", "we never reached the gateway"],
    ["unverified", "the reply's checksum did not match"],
    ["not_found", "no record — which is also what a payment past the retention horizon looks like"],
    ["unsupported", "the adapter cannot query at all (the mock)"],
  ] as const;

  for (const [reason, why] of unverified) {
    it(`does not touch the payment when ${why}`, async () => {
      vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
      queryStatus.mockResolvedValue({ ok: false, reason });

      const r = await runFpxRequerySweep(FAST);

      expect(r).toMatchObject({ checked: 1, unresolved: 1, settled: 0, failed: 0, stillPending: 0 });
      expect(applyVerifiedFpxOutcome).not.toHaveBeenCalled();
    });
  }

  it("treats an adapter that THROWS as 'we learned nothing', not as a failure", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockRejectedValue(new Error("socket hang up"));

    const r = await runFpxRequerySweep(FAST);

    expect(r).toMatchObject({ checked: 1, unresolved: 1 });
    expect(applyVerifiedFpxOutcome).not.toHaveBeenCalled();
  });
});

describe("runFpxRequerySweep — batch behaviour", () => {
  it("prefers the gateway's own id as the lookup key, and falls back to ours", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([
      candidate({ id: "pay-1", providerTranId: "fiuu-11" }),
      candidate({ id: "pay-2", providerTxnId: "order-2" }),
    ]);
    queryStatus.mockResolvedValue({ ok: true, status: "pending" });

    await runFpxRequerySweep(FAST);

    // Their id buys a 180-day requery window; ours only 7 — against a 60-day
    // window in which a payer can still dispute.
    expect(queryStatus).toHaveBeenNthCalledWith(1, expect.objectContaining({ providerTranId: "fiuu-11" }));
    expect(queryStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({ providerTxnId: "order-2", providerTranId: undefined }));
  });

  it("keeps going when one payment fails to apply — the rows behind it may be the ones owed money", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([
      candidate({ id: "pay-1" }),
      candidate({ id: "pay-2" }),
      candidate({ id: "pay-3" }),
    ]);
    queryStatus.mockResolvedValue({ ok: true, status: "success" });
    vi.mocked(applyVerifiedFpxOutcome)
      .mockResolvedValueOnce({ ok: true, status: 200, applied: "settled" })
      .mockRejectedValueOnce(new Error("settle blew up"))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ ok: true, status: 200, applied: "settled" } as any);

    const r = await runFpxRequerySweep(FAST);

    expect(r).toMatchObject({ checked: 3, settled: 2, unresolved: 1 });
  });

  it("carries the figures through the TENANT SELF-HEAL caller too", async () => {
    // This caller had NO coverage at all. Deleting `amount: answer.amount` from
    // it would have failed nothing — the same shape of bug already shipped once
    // on this exact pair, where the sweep was fixed and this one was not.
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockResolvedValue({ ok: true, status: "success", amount: "1.00", currency: "MYR" });

    await requeryTenantStaleFpx({ organizationId: "org-1", partyId: "party-1" });

    expect(applyVerifiedFpxOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "1.00", currency: "MYR" }),
    );
  });

  it("scopes the self-heal to that tenant's OWN rows", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([]);

    await requeryTenantStaleFpx({ organizationId: "org-1", partyId: "party-1" });

    expect(vi.mocked(findPendingFpxPaymentsForRequery).mock.calls[0][0]).toMatchObject({
      organizationId: "org-1",
      partyId: "party-1",
    });
  });

  it("does no work at all when nothing is in flight", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([]);

    const r = await runFpxRequerySweep(FAST);

    expect(r).toMatchObject({ checked: 0 });
    expect(queryStatus).not.toHaveBeenCalled();
  });

  it("asks about the oldest rows first and respects the per-run cap", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([candidate()]);
    queryStatus.mockResolvedValue({ ok: true, status: "pending" });

    await runFpxRequerySweep({ ...FAST, limit: 7, graceMinutes: 45 });

    const arg = vi.mocked(findPendingFpxPaymentsForRequery).mock.calls[0][0];
    expect(arg.limit).toBe(7);
    // The grace period is a "don't ask yet", never an expiry.
    const graceMs = Date.now() - arg.olderThan.getTime();
    expect(graceMs).toBeGreaterThanOrEqual(45 * 60_000 - 5_000);
    expect(graceMs).toBeLessThanOrEqual(45 * 60_000 + 5_000);
  });

  it("spaces queries apart — the gateway IP-bans for exceeding one per five seconds", async () => {
    vi.mocked(findPendingFpxPaymentsForRequery).mockResolvedValue([
      candidate({ id: "pay-1" }),
      candidate({ id: "pay-2" }),
      candidate({ id: "pay-3" }),
    ]);
    queryStatus.mockResolvedValue({ ok: true, status: "pending" });

    const started = Date.now();
    await runFpxRequerySweep({ queryIntervalMs: 40 });
    const elapsed = Date.now() - started;

    // Three rows ⇒ two gaps. The first query is not delayed, so a single-row run
    // costs nothing.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(queryStatus).toHaveBeenCalledTimes(3);
  });
});
