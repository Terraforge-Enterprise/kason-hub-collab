/**
 * What a tenant is allowed to SEE in their own payment history.
 *
 * This pins the change that started the FPX work. A tenant reported two dead
 * payment attempts sitting in their history for days, under a heading implying
 * someone was reviewing their money — after they had already successfully paid.
 * Nothing had happened on those rows: no money moved, no charge was settled, and
 * nothing was owed against the row itself.
 *
 * Every payment provider surveyed keeps abandoned attempts on the merchant side
 * only. So `expired` is filtered out at the QUERY, not hidden in the component —
 * a row the tenant must never see should not travel to their browser at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const count = vi.fn();

vi.mock("@kason/db", () => ({
  getDb: () => ({ payment: { findMany, count } }),
  Prisma: {},
}));

import { listPayments } from "../portal.payments.repository";

const SESSION = { partyId: "party-1", orgId: "org-1" };

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe("portal listPayments — tenant visibility", () => {
  it("excludes abandoned attempts from the tenant's history", async () => {
    await listPayments(SESSION, 1, 20);

    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: "expired" });
    // Still scoped to the tenant — the visibility filter must not have replaced
    // the ownership filter.
    expect(where.partyId).toBe("party-1");
    expect(where.organizationId).toBe("org-1");
  });

  it("applies the same filter to the total, so the count cannot disagree with the rows", async () => {
    await listPayments(SESSION, 1, 20);

    // A page of 0 rows reported as "3 payments" is its own confusing bug.
    expect(count.mock.calls[0][0].where).toEqual(findMany.mock.calls[0][0].where);
  });

  it("keeps every status the tenant genuinely needs", async () => {
    // Guards against someone "tidying up" by widening the exclusion. Each of
    // these is either money that moved, money that left their account, or an
    // event they lived through and may need to act on:
    //   posted               — a receipt
    //   pending_approval     — in flight; they must NOT pay again
    //   needs_reconciliation — the bank took it; we owe them the resolution
    //   rejected             — carries the reason they need to re-submit
    //   failed               — their bank declined it
    //   void / refunded      — money returned
    await listPayments(SESSION, 1, 20);

    const where = findMany.mock.calls[0][0].where;
    // A `not` on a single value, never an allow-list that could silently drop a
    // status added later.
    expect(Object.keys(where.status)).toEqual(["not"]);
  });
});
