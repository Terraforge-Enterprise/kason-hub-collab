/**
 * Task 6 — getOwnerMonthsService optional `apartmentId` scope.
 *
 * MONEY test. Drives the REAL route (`GET /owners/:ownerPartyId/months`) into the
 * REAL getOwnerMonthsService with ONLY `@kason/db` mocked (an in-memory fake whose
 * findMany honours `where.apartmentId`). This proves the full vertical slice:
 *   - entries scope        (OwnerLedgerEntry.apartmentId)  → gross/net
 *   - statement scope      (Invoice.apartmentId)           → card.statementId
 *   - listings→deposit     (Listing.apartmentId)           → depositCollected → net
 *   - route param forward  (?apartmentId=<uuid>, validated)
 *
 * The mock's apartment predicate is `where.apartmentId === undefined || row === it`,
 * so a service that does NOT add `apartmentId` to its `where` (pre-implementation)
 * returns the owner-COMBINED rows (RED on the scoped assertions); once the additive
 * filter is wired, the same call scopes (GREEN). Absent ⇒ combined (today), untouched.
 *
 * Unlike the sibling owner-months-routes.test.ts (which mocks the whole service to
 * isolate the route), this test deliberately runs the REAL service — the only way to
 * assert the per-apartment gross/net actually reflects ONLY that apartment's rows.
 * Fixtures live in vi.hoisted() so the hoisted @kason/db mock factory may close over
 * them without a TDZ error.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

const F = vi.hoisted(() => {
  const ORG = "o1";
  const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const APT1 = "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const APT2 = "a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const L1 = "11111111-1111-4111-8111-111111111111";
  const L2 = "22222222-2222-4222-8222-222222222222";
  const INV1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const INV2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
  const PROP = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

  const MONTH = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01
  const MID_MONTH = new Date(Date.UTC(2026, 5, 15));

  /** Prisma-Decimal stand-in: every consumer reads it via `.toString()`. */
  const dec = (s: string) => ({ toString: () => s });

  // apt-1: income rent 2000 + a 500 deposit on its listing.
  // apt-2: income rent 1000, no deposit.
  const ENTRIES = [
    {
      organizationId: ORG, ownerPartyId: OWNER, status: "active", apartmentId: APT1,
      direction: "income", category: "rent", amount: dec("2000.00"), sstAmount: null,
      includeInPayout: true, taxCategory: "rental_income", statementMonth: MONTH, propertyId: PROP,
    },
    {
      organizationId: ORG, ownerPartyId: OWNER, status: "active", apartmentId: APT2,
      direction: "income", category: "rent", amount: dec("1000.00"), sstAmount: null,
      includeInPayout: true, taxCategory: "rental_income", statementMonth: MONTH, propertyId: PROP,
    },
  ];

  const INVOICES = [
    { id: INV1, organizationId: ORG, ownerPartyId: OWNER, invoiceType: "owner_statement", apartmentId: APT1, periodMonth: MONTH, status: "draft" },
    { id: INV2, organizationId: ORG, ownerPartyId: OWNER, invoiceType: "owner_statement", apartmentId: APT2, periodMonth: MONTH, status: "approved" },
  ];

  const LISTINGS = [
    { id: L1, organizationId: ORG, ownerPartyId: OWNER, apartmentId: APT1, listingStatus: "active" },
    { id: L2, organizationId: ORG, ownerPartyId: OWNER, apartmentId: APT2, listingStatus: "active" },
  ];

  const DEPOSITS = [
    { organizationId: ORG, unitId: L1, type: "security", amount: dec("500.00"), status: "held", createdAt: MID_MONTH },
  ];

  // `where.apartmentId` absent ⇒ no apartment filter (combined = today's behaviour).
  const aptOk = (rowApt: string, where: Record<string, unknown>) =>
    where.apartmentId === undefined || rowApt === where.apartmentId;

  return { ORG, OWNER, APT1, APT2, INV1, INV2, ENTRIES, INVOICES, LISTINGS, DEPOSITS, aptOk };
});

// `importOriginal` keeps the REAL `Prisma` namespace alongside the faked `getDb`.
// fetchOwnerReceivablePayoutRows constructs `new Prisma.Decimal(...)` for its
// adjustment-netted amount, so a wholesale `{ getDb }` mock throws
// "Prisma.Decimal is not a constructor" the moment that code path runs. It does NOT
// run today only because `documentSeries.findFirst` returns null below and the
// function bails early — add an IVOWN series to this fixture and it would detonate.
// `getDb` is a lazy factory, so importing the real module opens no connection.
vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  const mockDb = {
    ownerLedgerEntry: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        F.ENTRIES.filter(
          (e) =>
            e.organizationId === where.organizationId &&
            e.ownerPartyId === where.ownerPartyId &&
            e.status === where.status &&
            F.aptOk(e.apartmentId, where),
        ),
      ),
    },
    invoice: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        F.INVOICES.filter(
          (inv) =>
            inv.organizationId === where.organizationId &&
            inv.ownerPartyId === where.ownerPartyId &&
            inv.invoiceType === where.invoiceType &&
            F.aptOk(inv.apartmentId, where),
        ),
      ),
    },
    listing: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        F.LISTINGS.filter(
          (l) =>
            l.organizationId === where.organizationId &&
            l.ownerPartyId === where.ownerPartyId &&
            l.listingStatus !== "archived" &&
            F.aptOk(l.apartmentId, where),
        ),
      ),
    },
    managementFeeConfig: {
      findMany: vi.fn(async () => []),
    },
    // fetchOwnerReceivablePayoutRows folds owner-borne IVOWN costs into the card's
    // payout. No IVOWN series in this fixture ⇒ it returns [] and every expectation
    // below stays exactly as it was.
    documentSeries: {
      findFirst: vi.fn(async () => null),
    },
    billingDocumentLine: {
      findMany: vi.fn(async () => []),
    },
    deposit: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        const ids: string[] = where.unitId?.in ?? [];
        return F.DEPOSITS.filter(
          (d) =>
            d.organizationId === where.organizationId &&
            ids.includes(d.unitId) &&
            d.status !== where.status?.not &&
            d.createdAt >= where.createdAt.gte &&
            d.createdAt <= where.createdAt.lte,
        );
      }),
    },
  };
  return { ...actual, getDb: () => mockDb };
});

// Mirror owner-months-routes.test.ts: the routes module imports the sync service.
vi.mock("../owner-ledger.sync", () => ({
  syncMonthService: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

import { ownerLedgerRoutes } from "../owner-ledger.routes";

const { OWNER, APT1, APT2, INV1, INV2 } = F;

const managerSession: SessionPayload = {
  userId: "u2",
  orgId: F.ORG,
  role: "manager",
  userType: "operator",
};

function makeApp() {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    c.set("session", managerSession);
    await next();
  });
  app.route("/", ownerLedgerRoutes);
  return app;
}

async function months(query = "") {
  const res = await makeApp().request(`/owners/${OWNER}/months${query}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.items as Array<{
    month: string;
    grossRental: string;
    totalExpenses: string;
    netPayoutToOwner: string;
    depositCollected: string;
    statementId: string | null;
    statementStatus: string | null;
  }>;
}

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});

describe("GET /owners/:ownerPartyId/months — optional apartmentId scope (Task 6)", () => {
  it("ABSENT apartmentId ⇒ owner-COMBINED gross/net (today's behaviour)", async () => {
    const items = await months();
    const june = items.find((m) => m.month === "2026-06")!;
    expect(june).toBeDefined();
    // gross = apt-1 (2000) + apt-2 (1000); deposit = the single 500 on apt-1's listing;
    // net = grossCashIn − deductible(0) = 3000 + 500.
    expect(june.grossRental).toBe("3000.00");
    expect(june.depositCollected).toBe("500.00");
    expect(june.netPayoutToOwner).toBe("3500.00");
  });

  it("apartmentId=apt-1 ⇒ gross/net/deposit/statement reflect ONLY apt-1's rows", async () => {
    const items = await months(`?apartmentId=${APT1}`);
    const june = items.find((m) => m.month === "2026-06")!;
    expect(june).toBeDefined();
    expect(june.grossRental).toBe("2000.00"); // apt-2's 1000 excluded
    expect(june.depositCollected).toBe("500.00"); // apt-1's listing carries the deposit
    expect(june.netPayoutToOwner).toBe("2500.00"); // 2000 + 500
    expect(june.statementId).toBe(INV1); // the per-apartment statement
    expect(june.statementStatus).toBe("draft");
  });

  it("apartmentId=apt-2 ⇒ excludes apt-1's rows AND apt-1's deposit", async () => {
    const items = await months(`?apartmentId=${APT2}`);
    const june = items.find((m) => m.month === "2026-06")!;
    expect(june).toBeDefined();
    expect(june.grossRental).toBe("1000.00");
    expect(june.depositCollected).toBe("0.00"); // deposit lives on apt-1's listing → excluded
    expect(june.netPayoutToOwner).toBe("1000.00");
    expect(june.statementId).toBe(INV2);
    expect(june.statementStatus).toBe("approved");
  });

  it("rejects a non-UUID apartmentId with 400 (z.string().uuid())", async () => {
    const res = await makeApp().request(`/owners/${OWNER}/months?apartmentId=not-a-uuid`);
    expect(res.status).toBe(400);
  });
});
