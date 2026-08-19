/**
 * The claim must match what we asked for — on BOTH channels.
 *
 * A verified signature proves the gateway signed a message with OUR ACCOUNT's
 * secret. It does not prove the figures are ours: that secret is per-account and
 * the account is shared surface (the merchant portal's Check button signs
 * arbitrary transactions with it; another project on the same profile signs with
 * it too). So a validly-signed `status=00` can name any amount against one of our
 * order ids, and settling on it alone pays off a RM150 charge for RM1.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * An adversarial review found three separate ways the guard did not hold, and
 * every one of them would have been caught by one test here. There were none.
 * The comparison was added, and then:
 *   - the REQUERY channel never passed the figures through, so the guard was
 *     skipped entirely on the channel that had just been made functional;
 *   - an empty `amount=` collapsed to `undefined`, which the guard reads as
 *     "this channel does not report figures" and skips — a one-parameter bypass
 *     handed to exactly the actor the guard targets;
 *   - a revived payment carried its PRE-revive status into the park, whose
 *     status-guarded write then matched zero rows and returned before writing
 *     anything, leaving the row in the state the sweep settles in full.
 *
 * The distinction these tests protect: `undefined` means the channel does not
 * report figures at all (the mock). An EMPTY STRING means it claimed to and said
 * nothing. Only the first may be skipped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/fpx", () => ({ getFpxGateway: vi.fn() }));
vi.mock("../../billing/auto-draft.repository", () => ({ resolveSystemActor: vi.fn() }));
vi.mock("../fpx-callback.repository", () => ({
  findPaymentByProviderTxnId: vi.fn(),
  setFpxGatewaySuccess: vi.fn(),
  failFpxPaymentTx: vi.fn(),
  persistProviderTranId: vi.fn(),
  reviveSweptFpxPaymentTx: vi.fn(),
  holdForReconciliationTx: vi.fn(),
}));
vi.mock("../payments.service", () => ({ postPaymentService: vi.fn() }));

import { getFpxGateway } from "../../../lib/fpx";
import { resolveSystemActor } from "../../billing/auto-draft.repository";
import {
  findPaymentByProviderTxnId,
  holdForReconciliationTx,
  reviveSweptFpxPaymentTx,
  setFpxGatewaySuccess,
} from "../fpx-callback.repository";
import { postPaymentService } from "../payments.service";
import { applyVerifiedFpxOutcome } from "../fpx-callback.service";

const ORG = "org-1";
const PAYMENT_ID = "pay-1";
const ADMIN = "admin-1";
const TXN = "order-1";

/** We recorded RM150.00. Everything below is judged against this. */
function recorded(over: Partial<{ status: string; gatewayStatus: string | null }> = {}) {
  return {
    id: PAYMENT_ID,
    organizationId: ORG,
    status: over.status ?? "pending_approval",
    gatewayStatus: over.gatewayStatus === undefined ? "pending" : over.gatewayStatus,
    providerTranId: null,
    amount: "150.00",
    currency: "MYR",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getFpxGateway).mockReturnValue({ verifyCallback: vi.fn() } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(resolveSystemActor).mockResolvedValue({ actorUserId: ADMIN, actorRole: "admin" } as any);
  vi.mocked(reviveSweptFpxPaymentTx).mockResolvedValue(true);
  // The park LANDS by default — it returns a boolean now, and a bare vi.fn()
  // resolves undefined, which reads as "did not land".
  vi.mocked(holdForReconciliationTx).mockResolvedValue(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: {} } as any);
});

describe("a signed success must agree with what we recorded", () => {
  it("settles when the figures match", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: "MYR",
      status: "success",
    });

    expect(r).toMatchObject({ ok: true, applied: "settled" });
    expect(postPaymentService).toHaveBeenCalledTimes(1);
  });

  it("PARKS a RM1 claim against a RM150 payment instead of settling it in full", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "1.00",
      currency: "MYR",
      status: "success",
    });

    expect(r).toMatchObject({ ok: true, applied: "parked" });
    expect(postPaymentService).not.toHaveBeenCalled();
    expect(setFpxGatewaySuccess).not.toHaveBeenCalled();
    expect(holdForReconciliationTx).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("amount mismatch") }),
    );
  });

  it("PARKS an EMPTY amount — the one-parameter bypass", async () => {
    // `amount=` in a validly-signed body. The skey chain hashes whatever is
    // present, so an empty amount signs perfectly well; collapsing it to
    // `undefined` upstream made the guard vanish for the exact actor it targets.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "",
      currency: "MYR",
      status: "success",
    });

    expect(r).toMatchObject({ ok: true, applied: "parked" });
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("settles when the amount agrees but is formatted differently", async () => {
    // The guard exists to catch a different VALUE, not a different FORMAT.
    // Refusing money over "150" vs "150.00" protects nothing and turns every
    // settlement into a manual queue item. The spec says two decimal places, so
    // this should never fire in practice — which is what makes it cheap.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    for (const claimed of ["150", "150.0", "150.00", " 150.00 "]) {
      vi.clearAllMocks();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(resolveSystemActor).mockResolvedValue({ actorUserId: ADMIN, actorRole: "admin" } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(postPaymentService).mockResolvedValue({ ok: true, status: 200, data: {} } as any);
      vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

      const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: claimed, status: "success" });
      expect(r, `claimed "${claimed}" should settle`).toMatchObject({ applied: "settled" });
    }
  });

  it("settles on a lower-case currency — case is not a security signal", async () => {
    // `pick()` is already deliberately case-insensitive on field NAMES because
    // Fiuu's own casing is inconsistent across its documents and SDKs. The same
    // argument applies to values: a reply saying `myr` would otherwise park
    // every payment the sweep touched, and an attacker gains nothing from `myr`
    // that `MYR` does not already give them.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: "myr",
      status: "success",
    });

    expect(r).toMatchObject({ applied: "settled" });
  });

  it("settles when Fiuu's callback names the ringgit \"RM\" — its two channels disagree", async () => {
    // NOT hypothetical. UAT payment PAY-MSX9ZLXR-ZXYY (Fiuu tranID 3955716616,
    // FPX_UOB, StatCode 00 "captured") was debited at the bank and never settled,
    // because Fiuu's notify/return channel POSTs `currency=RM` while its OWN
    // requery channel answers `Currency: MYR` for the same transaction. We send
    // `MYR` at initiate and record `MYR`, so the callback looked like a mismatch.
    //
    // It then failed the malleability shape check too — ISO-4217 is three letters
    // and "RM" is two — so it was classified as a moved signed-field boundary and
    // `refuseMalleated` returned 400 WITHOUT touching the row. That is the worst
    // available outcome: no settle, no park, no ack, and Fiuu's three retries
    // burned against a payer whose money had already left their account.
    //
    // "RM" is the ringgit's everyday symbol, not an attack. It must settle.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: "RM",
      status: "success",
    });

    expect(r).toMatchObject({ applied: "settled" });
    expect(postPaymentService).toHaveBeenCalledTimes(1);
  });

  it("treats \"rm\" the same as \"RM\" — casing is not a security signal here either", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: " rm ",
      status: "success",
    });

    expect(r).toMatchObject({ applied: "settled" });
  });

  it("still PARKS a genuinely different amount, tolerance notwithstanding", async () => {
    // The tolerance is half a cent. It must not become a loophole.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "149.99", status: "success" });

    expect(r).toMatchObject({ applied: "parked" });
  });

  it("PARKS a currency mismatch", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: "SGD",
      status: "success",
    });

    expect(r).toMatchObject({ applied: "parked" });
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("still settles when the channel reports no figures at all (the mock)", async () => {
    // `undefined` is NOT the same as empty: it means this channel cannot report
    // figures, which is true of the mock adapter. Treating it as a mismatch would
    // break every dev and CI flow.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, status: "success" });

    expect(r).toMatchObject({ applied: "settled" });
  });

  it("does not judge a FAILED answer on its amount", async () => {
    // A failure carries no money and its figures are irrelevant; comparing them
    // would park rows that simply did not pay.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "0.00",
      status: "failed",
    });

    expect(r).toMatchObject({ applied: "failed" });
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });
});

describe("the check runs BEFORE the terminal-status handling", () => {
  it("a mismatched claim on a swept row parks with a durable trace, and is NOT revived", async () => {
    // Ordering bug this pins: when the comparison sat AFTER the terminal block, a
    // swept row was revived to `pending_approval` first, then parked using its
    // PRE-revive status — so the park's status-guarded write matched zero rows and
    // returned before the notification and the audit. The signed unreconcilable
    // claim produced a console line and nothing else, and left the row in exactly
    // the state the requery sweep then settles in full.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "expired", gatewayStatus: "expired" }),
    );

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "1.00",
      currency: "MYR",
      status: "success",
    });

    expect(r).toMatchObject({ applied: "parked" });
    // Never revived — so the park's status guard matches the row as it stands.
    expect(reviveSweptFpxPaymentTx).not.toHaveBeenCalled();
    expect(holdForReconciliationTx).toHaveBeenCalledWith(
      expect.objectContaining({ priorStatus: "expired", priorGatewayStatus: "expired" }),
    );
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("does NOT un-dismiss a row a human already closed, however many times the gateway retries", async () => {
    // Regression guard. Moving the comparison above the terminal block fixed the
    // stale-status park — but it also put it ahead of the `dismissed`
    // short-circuit, so a dismissed row hit the mismatch path first. And it
    // mismatches BY CONSTRUCTION: the mismatch is why it was parked and then
    // dismissed in the first place. `holdForReconciliationTx` guards on
    // `status: priorStatus`, and a dismissed row IS `expired`, so the write
    // matched, the row went back to `needs_reconciliation`, and a fresh
    // notification fired — on each of the gateway's 3 retries over ~45 minutes.
    //
    // That is precisely the "silently reversing an audited human decision" the
    // `dismissed` marker was introduced to prevent.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "expired", gatewayStatus: "dismissed" }),
    );

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "1.00", // mismatched, as it always will be on a dismissed row
      currency: "MYR",
      status: "success",
    });

    expect(r.ok).toBe(true);
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
    expect(postPaymentService).not.toHaveBeenCalled();
  });

  it("does NOT raise a second notification for a row already in the queue", async () => {
    // Same ordering defect, other path: an already-parked row re-delivered.
    // `priorStatus` is then `needs_reconciliation`, the status guard matches
    // (status unchanged), and a duplicate notification + audit are written per
    // redelivery — the exact duplicate the guard was added to stop.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "needs_reconciliation", gatewayStatus: "cancelled" }),
    );

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "1.00",
      currency: "MYR",
      status: "success",
    });

    expect(r.ok).toBe(true);
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });

  it("a MATCHING claim on a swept row still revives and settles", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "expired", gatewayStatus: "expired" }),
    );

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: "MYR",
      status: "success",
    });

    expect(reviveSweptFpxPaymentTx).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ applied: "settled" });
  });
});

describe("what the handler REPORTS it did", () => {
  // The requery sweep's five counters are its only output. Inferring "settled"
  // from `ok: true` counted a dozen deliberate no-ops as recovered money.
  it("reports nothing applied for an already-parked row", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "needs_reconciliation", gatewayStatus: "cancelled" }),
    );

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", status: "success" });

    expect(r.ok).toBe(true);
    expect(r.applied).toBeUndefined();
  });

  it("reports nothing applied for a dismissed row", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "expired", gatewayStatus: "dismissed" }),
    );

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", status: "success" });

    expect(r.ok).toBe(true);
    expect(r.applied).toBeUndefined();
  });

  it("reports 'parked' when an admin-cancelled row gets a late success", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "expired", gatewayStatus: "cancelled" }),
    );

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", status: "success" });

    expect(r).toMatchObject({ applied: "parked" });
  });

  it("parks a failed settle against the row's CURRENT status, not the stale read", async () => {
    // The status-guarded park matches on `priorStatus`. `payment` is read once at
    // step 2 and is stale by the time a settle fails — deterministically so after
    // a revive (which flips the DB row to `pending_approval` while the local
    // object still says `expired`), and on any concurrent status change during
    // `postPaymentService`. A stale value matches ZERO rows, so the park returns
    // before the status write, the notification AND the audit — while the handler
    // still reports `parked`. Money at the bank, row silently in flight: the exact
    // hole this branch was rewritten to close.
    vi.mocked(findPaymentByProviderTxnId)
      .mockResolvedValueOnce(recorded({ status: "expired", gatewayStatus: "expired" })) // step 2
      .mockResolvedValueOnce(recorded({ status: "pending_approval" })); // post-revive re-read
    vi.mocked(postPaymentService).mockResolvedValue({ ok: false, status: 409, error: "outstanding drifted" } as never);
    vi.mocked(holdForReconciliationTx).mockResolvedValue(true);

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", status: "success" });

    expect(r).toMatchObject({ applied: "parked" });
    expect(holdForReconciliationTx).toHaveBeenCalledWith(
      expect.objectContaining({ priorStatus: "pending_approval" }),
    );
  });

  it("does NOT claim 'parked' when the park did not land", async () => {
    // Announcing a park that matched zero rows is what made this invisible.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());
    vi.mocked(postPaymentService).mockResolvedValue({ ok: false, status: 409, error: "outstanding drifted" } as never);
    vi.mocked(holdForReconciliationTx).mockResolvedValue(false);

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", status: "success" });

    expect(r.ok).toBe(true); // still ack — the debit is real, never make Fiuu burn a retry
    expect(r.applied).toBeUndefined();
  });

  it("reports ALREADY_SETTLED, not settled, on an idempotent replay", async () => {
    // The browser-return banner reads this, and Fiuu's server-to-server notify
    // usually beats the payer's browser back — so the redelivery IS the common
    // path for a successful payment. Reporting "nothing applied" here told every
    // one of those payers their payment was still pending.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(
      recorded({ status: "posted", gatewayStatus: "success" }),
    );

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", status: "success" });

    // `already_settled`, NOT `settled`. The banner treats both as received, but
    // the requery sweep counts only `settled` — its counters mean "what THIS
    // sweep recovered", and it must not claim credit for money a concurrent
    // callback had already applied.
    expect(r).toMatchObject({ ok: true, applied: "already_settled" });
    expect(postPaymentService).not.toHaveBeenCalled(); // and settles nothing a second time
  });
});

/**
 * Fiuu's `skey` is an md5 over UNSEPARATED concatenated fields, so moving a field
 * boundary yields a different set of values with a byte-identical signature:
 * `amount=150.00 & currency=MYR` re-splits to `amount=150.00M & currency=YR`.
 *
 * That is not theoretical. Fiuu POSTs the payer's own browser to the Return URL,
 * and that route feeds the body straight into this handler — so every payer holds
 * a validly-signed success body for their own transaction, on a public
 * unauthenticated route with no CSRF. Replaying it re-split used to PARK the
 * payment as `needs_reconciliation`, and step 4a then short-circuits every
 * genuine callback that follows, so the real settle could never land: the payer
 * is debited, the charge stays fully outstanding, and BLOCKS_FURTHER_PAYMENT_WHERE
 * stops them paying it by any other method until an admin unpicks it by hand.
 *
 * The park IS the damage, so the answer is to touch nothing and let the genuine
 * callback settle it. These tests pin that the refusal is narrow — it fires only
 * on values that could not have come from a gateway, and a REAL disagreement
 * still parks exactly as before.
 */
describe("a re-split signed body cannot park the payment", () => {
  it("refuses a moved amount/currency boundary without touching the row", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00M",
      currency: "YR",
      status: "success",
    });

    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(holdForReconciliationTx).not.toHaveBeenCalled(); // NOT parked — that was the attack
    expect(postPaymentService).not.toHaveBeenCalled(); // and obviously never settled
  });

  it("catches the split where the AMOUNT still parses and only the currency gives it away", async () => {
    // "150.00MYR" also splits as "15" | "0.00MYR". The amount alone then looks
    // like a plain figures mismatch, so checking only the field that disagreed
    // would have parked it.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "15",
      currency: "0.00MYR",
      status: "success",
    });

    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });

  it("and the genuine callback that follows still settles normally", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00M", currency: "YR", status: "success" });
    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", currency: "MYR", status: "success" });

    expect(r).toMatchObject({ ok: true, applied: "settled" });
    expect(setFpxGatewaySuccess).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it("STILL parks a real figures disagreement — the refusal must not swallow those", async () => {
    // RM149.99 against our RM150.00 is a well-formed amount that simply is not
    // ours. That is the case the park exists for, and it must be untouched.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "149.99", status: "success" });

    expect(r).toMatchObject({ ok: true, applied: "parked" });
    expect(holdForReconciliationTx).toHaveBeenCalled();
  });

  it("STILL parks a thousands-separated amount, as the amount guard always did", async () => {
    // Fiuu's own WooCommerce plugin emits `1,250.00`. `amountsAgree` refuses it
    // and parks rather than mis-settling; the shape check deliberately counts it
    // as well-formed so that behaviour survives.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "1,250.00", status: "success" });

    expect(r).toMatchObject({ ok: true, applied: "parked" });
    expect(holdForReconciliationTx).toHaveBeenCalled();
  });

  it("STILL parks an EMPTY amount — a missing figure is not a moved boundary", async () => {
    // Guards the seam between the two ideas. `amount=""` is the one-parameter
    // bypass, and it has an owner: it parks so a human sees it. If the shape
    // check treated empty as "impossible", it would swallow that park silently.
    // A re-split that empties one field always fills the other with the
    // leftovers, so the counterpart check still catches the real attack.
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "", currency: "MYR", status: "success" });

    expect(r).toMatchObject({ ok: true, applied: "parked" });
  });

  it("catches the re-split that empties the amount and stuffs the currency", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "",
      currency: "150.00MYR",
      status: "success",
    });

    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(holdForReconciliationTx).not.toHaveBeenCalled();
  });

  it("STILL parks a genuine currency disagreement", async () => {
    vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

    const r = await applyVerifiedFpxOutcome({
      providerTxnId: TXN,
      amount: "150.00",
      currency: "SGD",
      status: "success",
    });

    expect(r).toMatchObject({ ok: true, applied: "parked" });
    expect(holdForReconciliationTx).toHaveBeenCalled();
  });

  it("admitting the RM alias does NOT open a re-split of an RM-denominated body", async () => {
    // The security-critical direction of the alias. "150.00" + "RM" concatenates
    // to "150.00RM", and every boundary inside it must still be refused — the
    // alias widened `looksLikeACurrencyCode`, so this is the check that the
    // widening bought an attacker nothing.
    //
    // "150.0" | "0RM" is the dangerous one: the amount still parses AND still
    // agrees (150.0 == 150.00), so ONLY the currency's shape can catch it. "0RM"
    // carries a digit, so it matches neither the alias table nor [A-Za-z]{3}.
    for (const [amount, currency] of [
      ["", "150.00RM"],
      ["1", "50.00RM"],
      ["150.0", "0RM"],
      ["150.00R", "M"],
      ["150.00RM", ""],
    ]) {
      vi.clearAllMocks();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(resolveSystemActor).mockResolvedValue({ actorUserId: ADMIN, actorRole: "admin" } as any);
      vi.mocked(holdForReconciliationTx).mockResolvedValue(true);
      vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

      const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount, currency, status: "success" });

      expect(r, `"${amount}" | "${currency}" must be refused, not settled`).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(postPaymentService).not.toHaveBeenCalled();
      // Refused means UNTOUCHED — not parked. Parking is the damage a re-split
      // body is after: step 4a then short-circuits every genuine callback after it.
      expect(holdForReconciliationTx).not.toHaveBeenCalled();
    }
  });

  it("does not treat an inherited Object property as a known currency", async () => {
    // `CURRENCY_ALIASES` is consulted with gateway-controlled input. As a plain
    // object literal, `["constructor"]` returns a function rather than undefined,
    // which would have made "constructor" a well-formed currency code and turned
    // a moved field boundary into a park instead of a refusal. It is a Map.
    for (const currency of ["constructor", "toString", "__proto__", "valueOf"]) {
      vi.clearAllMocks();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(resolveSystemActor).mockResolvedValue({ actorUserId: ADMIN, actorRole: "admin" } as any);
      vi.mocked(holdForReconciliationTx).mockResolvedValue(true);
      vi.mocked(findPaymentByProviderTxnId).mockResolvedValue(recorded());

      const r = await applyVerifiedFpxOutcome({ providerTxnId: TXN, amount: "150.00", currency, status: "success" });

      expect(r, `"${currency}" must never settle`).not.toMatchObject({ applied: "settled" });
      expect(postPaymentService).not.toHaveBeenCalled();
    }
  });
});
