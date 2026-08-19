/**
 * Task 2 — assertPeriodOpen truth table (unit). Pure: the DB is a hand-stubbed
 * transaction client whose `ownerStatementPeriod.findFirst` returns a preset
 * period (or throws when the guard must NOT consult it), so the branching logic
 * is exercised without a real Postgres.
 *
 * Truth table: flag on/off × period open/frozen/absent × intent bypass, plus
 * target-month normalization to first-of-UTC-month.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertPeriodOpen } from "../assert-period-open";
import { ClosedPeriodError } from "../closed-period";

const LEDGER = "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER";
const ORG = "org-1";
const OWNER = "owner-1";

type StubOpts = { period?: { status: string } | null; onRead?: (where: unknown) => void };
function stubTx(opts: StubOpts) {
  return {
    ownerStatementPeriod: {
      findFirst: async (args: { where?: unknown }) => {
        opts.onRead?.(args?.where);
        return opts.period ?? null;
      },
    },
  } as unknown as Parameters<typeof assertPeriodOpen>[0];
}

/** Guard-tripwire tx: any period read throws, proving a short-circuit. */
function neverReadTx() {
  return stubTx({ onRead: () => { throw new Error("period must NOT be read"); } });
}

const utcMonthKey = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

describe("assertPeriodOpen truth table (R1)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[LEDGER];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[LEDGER];
    else process.env[LEDGER] = saved;
  });

  it("B4: flag OFF → no-op; the period is never read", async () => {
    delete process.env[LEDGER];
    await expect(
      assertPeriodOpen(neverReadTx(), ORG, OWNER, new Date(Date.UTC(2026, 4, 1))),
    ).resolves.toBeUndefined();
  });

  it("B5: flag ON + period OPEN → no throw", async () => {
    process.env[LEDGER] = "1";
    await expect(
      assertPeriodOpen(stubTx({ period: { status: "open" } }), ORG, OWNER, new Date(Date.UTC(2026, 4, 1))),
    ).resolves.toBeUndefined();
  });

  it("B6: flag ON + no period row → no throw", async () => {
    process.env[LEDGER] = "1";
    await expect(
      assertPeriodOpen(stubTx({ period: null }), ORG, OWNER, new Date(Date.UTC(2026, 4, 1))),
    ).resolves.toBeUndefined();
  });

  it("B7: flag ON + period FROZEN → throws ClosedPeriodError with correct months", async () => {
    process.env[LEDGER] = "1";
    const target = new Date(Date.UTC(2026, 4, 1)); // 2026-05
    const expectedOpen = utcMonthKey(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)));
    let caught: unknown;
    try {
      await assertPeriodOpen(stubTx({ period: { status: "frozen" } }), ORG, OWNER, target);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClosedPeriodError);
    const err = caught as ClosedPeriodError;
    expect(err.originalBillingMonth).toBe("2026-05");
    expect(err.currentOpenMonth).toBe(expectedOpen);
  });

  it("B8: flag ON + FROZEN + intent=prior_period_adjustment → no throw; period never read", async () => {
    process.env[LEDGER] = "1";
    await expect(
      assertPeriodOpen(neverReadTx(), ORG, OWNER, new Date(Date.UTC(2026, 4, 1)), {
        intent: "prior_period_adjustment",
      }),
    ).resolves.toBeUndefined();
  });

  it("B19b: flag ON + period lookup throws → fails CLOSED (error propagates, never silently allows)", async () => {
    process.env[LEDGER] = "1";
    const boomTx = stubTx({ onRead: () => { throw new Error("db down"); } });
    await expect(
      assertPeriodOpen(boomTx, ORG, OWNER, new Date(Date.UTC(2026, 4, 1))),
    ).rejects.toThrow("db down");
  });

  it("B23: year-boundary target (Dec 31) normalizes to Dec-01 and reports 2026-12", async () => {
    process.env[LEDGER] = "1";
    let caught: unknown;
    try {
      await assertPeriodOpen(
        stubTx({ period: { status: "frozen" } }),
        ORG,
        OWNER,
        new Date("2026-12-31T23:59:59.000Z"),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClosedPeriodError);
    expect((caught as ClosedPeriodError).originalBillingMonth).toBe("2026-12");
  });

  it("B9: mid-month target is normalized to first-of-UTC-month + combined scope in the lookup", async () => {
    process.env[LEDGER] = "1";
    let capturedWhere: Record<string, unknown> | undefined;
    const tx = stubTx({
      period: { status: "open" },
      onRead: (where) => { capturedWhere = where as Record<string, unknown>; },
    });
    await assertPeriodOpen(tx, ORG, OWNER, new Date("2026-05-31T12:34:56.000Z"));
    expect(capturedWhere).toBeDefined();
    expect(capturedWhere!.organizationId).toBe(ORG);
    expect(capturedWhere!.ownerPartyId).toBe(OWNER);
    expect(capturedWhere!.apartmentId).toBeNull();
    expect((capturedWhere!.periodMonth as Date).getTime()).toBe(Date.UTC(2026, 4, 1));
  });
});
