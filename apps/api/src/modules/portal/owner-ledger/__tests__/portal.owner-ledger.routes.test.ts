/**
 * Route-level tests for the portal owner-ledger endpoints (Task 8).
 *
 * Mirrors portal.financials.routes.test.ts (owner-session mocking, DB mock via
 * repository mock, app harness with portalUserTypeGuard).
 *
 * Assertions:
 *   (a) flag OFF → 404 on all endpoints
 *   (b) owner A gets only A's rows + correct summary.netPayoutToOwner
 *       (seeded kaen-paid income + an owner-paid expense so net-payout ≠ net-rental)
 *   (c) owner B (different partyId) sees empty rows; /properties/:A_prop → 404
 *   (d) tax-summary returns the disclaimer + grouped totals
 *   (e) /properties/:id 404s for non-owned property
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../auth/portal.auth.types";

// Mock the portal repository so the DB is never reached.
vi.mock("../portal.owner-ledger.repository", () => ({
  getOwnerLedgerRows: vi.fn(),
  getOwnerPropertyView: vi.fn(),
}));

// Mock the admin owner-ledger repository — resolveOwnerBalance is imported from
// there by the route and must not hit the DB (which is undefined in tests).
vi.mock("../../../owner-ledger/owner-ledger.repository", () => ({
  resolveOwnerBalance: vi.fn(),
}));

import { portalOwnerLedgerRoutes } from "../portal.owner-ledger.routes";
import { getOwnerLedgerRows, getOwnerPropertyView } from "../portal.owner-ledger.repository";
import { resolveOwnerBalance } from "../../../owner-ledger/owner-ledger.repository";
import { portalUserTypeGuard } from "../../portal.middleware";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROP_A = "11111111-1111-4111-8111-111111111111";
const ORG = "org-1";

function ownerSession(partyId: string): PortalSessionPayload {
  return {
    userId: `user-${partyId.slice(0, 4)}`,
    orgId: ORG,
    role: "viewer",
    userType: "owner",
    partyId,
    iat: 0,
    absoluteExp: 0,
  };
}

const agentSession: PortalSessionPayload = {
  userId: "user-agent",
  orgId: ORG,
  role: "viewer",
  userType: "agent",
  partyId: "agent-party",
  iat: 0,
  absoluteExp: 0,
};

/** Build the app the way portal/index.ts mounts owner-ledger: owner-guard + router. */
function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.use("/owner-ledger/*", portalUserTypeGuard("owner"));
  app.route("/owner-ledger", portalOwnerLedgerRoutes);
  return app;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Owner A has:
//   1) rental_income (kaen-paid, includeInPayout:true) RM 2000
//   2) management_fee (expense, owner-paid, includeInPayout:false) RM 200
// net-rental-after-expenses = 2000 - 200 = 1800
// net-payout-to-owner       = 2000 - 0   = 2000  (owner-paid expense excluded from payout)
const ownerARows = [
  {
    id: "row-1",
    statementMonth: "2026-06",
    transactionDate: "2026-06-01",
    direction: "income",
    category: "rental_income",
    description: "June rent",
    remarks: null,
    amount: "2000.00",
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    includeInPayout: true,
    taxCategory: "not_applicable",
    attachmentKeys: [],
    propertyId: PROP_A,
    apartmentId: null,
    unitCode: null,
    listingId: null,
  },
  {
    id: "row-2",
    statementMonth: "2026-06",
    transactionDate: "2026-06-05",
    direction: "expense",
    category: "management_fee",
    description: "Mgmt fee June",
    remarks: null,
    amount: "200.00",
    sstAmount: "16.00",
    paidBy: "owner",
    paymentStatus: "paid",
    includeInPayout: false,
    taxCategory: "rental_expense",
    attachmentKeys: [],
    propertyId: PROP_A,
    apartmentId: null,
    unitCode: null,
    listingId: null,
  },
];

// OwnerLedgerLine representations of the rows above.
const ownerALines = [
  {
    direction: "income" as const,
    category: "rental_income",
    amount: "2000.00",
    sstAmount: null,
    includeInPayout: true,
    taxCategory: "not_applicable",
  },
  {
    direction: "expense" as const,
    category: "management_fee",
    amount: "200.00",
    sstAmount: "16.00",
    // owner-paid → includeInPayout:false (not deducted from payout)
    includeInPayout: false,
    taxCategory: "rental_expense",
  },
];

const propertyView = {
  id: PROP_A,
  name: "Annex Residence",
  address: {
    addressLine1: "1 Jalan Test",
    addressLine2: null,
    city: "Kuala Lumpur",
    state: "WP",
    postalCode: "50480",
    country: "Malaysia",
  },
  managerId: null,
  units: [
    {
      listingId: "listing-1",
      unitCode: "A-1",
      occupancyStatus: "occupied",
      currentTenancy: {
        id: "tenancy-1",
        tenantDisplayName: "Tan Wei",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        monthlyRentAmount: "2000.00",
      },
      deposits: [
        { id: "dep-1", type: "security", amount: "4000.00", status: "held" },
      ],
    },
  ],
  managementFeeConfig: {
    feeType: "percent",
    feeValue: "10.00",
    sstPercent: "8.00",
    capAmount: null,
  },
};

// Default resolveOwnerBalance mock returned for all tests — tests that need
// specific balance values override it in their own beforeEach/mockResolvedValue.
const DEFAULT_BALANCE = {
  broughtForward: "0.00",
  periodGross: "0.00",
  periodExpenses: "0.00",
  periodPayouts: "0.00",
  netThisPeriod: "0.00",
  depositCollected: "0.00",
  carriedForward: "0.00",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveOwnerBalance).mockResolvedValue(DEFAULT_BALANCE);
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_OWNER_BILLING;
});

// ─── (a) flag OFF → 404 ───────────────────────────────────────────────────────

describe("flag OFF → 404 on all endpoints", () => {
  it("GET /owner-ledger → 404 when flag is off", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request(
      "/owner-ledger?fromMonth=2026-06&toMonth=2026-06",
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    // Repository must NOT be called when flag is dark.
    expect(getOwnerLedgerRows).not.toHaveBeenCalled();
  });

  it("GET /owner-ledger/tax-summary → 404 when flag is off", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request(
      "/owner-ledger/tax-summary?fromMonth=2026-06&toMonth=2026-06",
    );
    expect(res.status).toBe(404);
  });

  it("GET /owner-ledger/properties/:id → 404 when flag is off", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-ledger/properties/${PROP_A}`);
    expect(res.status).toBe(404);
    expect(getOwnerPropertyView).not.toHaveBeenCalled();
  });
});

// ─── (b) owner A rows + correct summary ───────────────────────────────────────

describe("GET /owner-ledger — owner A sees own rows + correct summary", () => {
  beforeEach(() => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(getOwnerLedgerRows).mockResolvedValue({ rows: ownerARows, lines: ownerALines });
  });

  it("returns A's rows and a summary with correct netPayoutToOwner ≠ netRentalAfterExpenses", async () => {
    // Use non-zero balance values so the broughtForward/carriedForward assertions
    // are meaningful (distinct from any zero coming from the period summary).
    vi.mocked(resolveOwnerBalance).mockResolvedValue({
      broughtForward: "500.00",
      periodGross: "2000.00",
      periodExpenses: "216.00",
      periodPayouts: "0.00",
      netThisPeriod: "2000.00",
      depositCollected: "0.00",
      carriedForward: "2500.00",
    });

    const res = await makeApp(ownerSession(OWNER_A)).request(
      "/owner-ledger?fromMonth=2026-06&toMonth=2026-06",
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Rows match fixtures.
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.rows[0].id).toBe("row-1");
    expect(body.data.rows[1].id).toBe("row-2");

    // Summary: income=2000, expense=200+sst16=216
    expect(body.data.summary.grossRental).toBe("2000.00");
    expect(body.data.summary.totalExpenses).toBe("216.00"); // 200 amount + 16 sst

    // net-rental = 2000 - 216 = 1784
    expect(body.data.summary.netRentalAfterExpenses).toBe("1784.00");
    // net-payout: owner-paid expense excluded from payout (includeInPayout=false)
    // so payout expenses = 0 → net-payout = 2000
    expect(body.data.summary.netPayoutToOwner).toBe("2000.00");
    // The two values differ — this is the critical assertion.
    expect(body.data.summary.netPayoutToOwner).not.toBe(body.data.summary.netRentalAfterExpenses);

    // broughtForward + carriedForward come from the mocked resolveOwnerBalance.
    expect(body.data.summary.broughtForward).toBe("500.00");
    expect(body.data.summary.carriedForward).toBe("2500.00");
  });

  it("passes session.partyId (not query param) as ownerPartyId to repository", async () => {
    await makeApp(ownerSession(OWNER_A)).request(
      // Even if an adversary passes a different ownerPartyId in the query, it's ignored.
      `/owner-ledger?fromMonth=2026-06&toMonth=2026-06&ownerPartyId=${OWNER_B}`,
    );
    // The call must use OWNER_A (session), never OWNER_B (query param).
    expect(getOwnerLedgerRows).toHaveBeenCalledWith(ORG, OWNER_A, "2026-06", "2026-06", undefined);
  });

  it("passes optional propertyId filter through to repository", async () => {
    await makeApp(ownerSession(OWNER_A)).request(
      `/owner-ledger?fromMonth=2026-06&toMonth=2026-06&propertyId=${PROP_A}`,
    );
    expect(getOwnerLedgerRows).toHaveBeenCalledWith(ORG, OWNER_A, "2026-06", "2026-06", PROP_A);
  });

  it("accepts a missing fromMonth as an open (all-time) lower bound", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request(
      "/owner-ledger?toMonth=2026-06",
    );
    expect(res.status).toBe(200);
    expect(getOwnerLedgerRows).toHaveBeenCalledWith(ORG, OWNER_A, "", "2026-06", undefined);
    // Balance fields are included in the summary (sourced from the mock).
    const body = await res.json();
    expect(body.data.summary.broughtForward).toBe("0.00");
    expect(body.data.summary.carriedForward).toBe("0.00");
  });
});

// ─── (c) owner B sees empty rows / cannot see A's property ───────────────────

describe("cross-owner isolation — owner B cannot see owner A's data", () => {
  beforeEach(() => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });

  it("owner B gets empty rows (repository returns empty for B's partyId)", async () => {
    vi.mocked(getOwnerLedgerRows).mockResolvedValue({ rows: [], lines: [] });

    const res = await makeApp(ownerSession(OWNER_B)).request(
      "/owner-ledger?fromMonth=2026-06&toMonth=2026-06",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows).toEqual([]);
    // Summary with no lines: all zeros.
    expect(body.data.summary.grossRental).toBe("0.00");
    expect(body.data.summary.netPayoutToOwner).toBe("0.00");
    // Balance fields present (from the default DEFAULT_BALANCE mock).
    expect(body.data.summary.broughtForward).toBe("0.00");
    expect(body.data.summary.carriedForward).toBe("0.00");
    // Repository was called with OWNER_B (the correct isolation).
    expect(getOwnerLedgerRows).toHaveBeenCalledWith(ORG, OWNER_B, "2026-06", "2026-06", undefined);
    // NOT called with OWNER_A.
    expect(getOwnerLedgerRows).not.toHaveBeenCalledWith(ORG, OWNER_A, expect.anything(), expect.anything(), expect.anything());
  });

  it("/properties/:A_prop returns 404 for owner B (repository returns null)", async () => {
    vi.mocked(getOwnerPropertyView).mockResolvedValue(null);

    const res = await makeApp(ownerSession(OWNER_B)).request(`/owner-ledger/properties/${PROP_A}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    // Scoped to owner B's partyId, never owner A's.
    expect(getOwnerPropertyView).toHaveBeenCalledWith(ORG, OWNER_B, PROP_A);
    expect(getOwnerPropertyView).not.toHaveBeenCalledWith(ORG, OWNER_A, PROP_A);
  });

  it("userType guard blocks agent (403)", async () => {
    const res = await makeApp(agentSession).request(
      "/owner-ledger?fromMonth=2026-06&toMonth=2026-06",
    );
    expect(res.status).toBe(403);
    expect(getOwnerLedgerRows).not.toHaveBeenCalled();
  });
});

// ─── (d) tax-summary returns disclaimer + grouped totals ─────────────────────

describe("GET /owner-ledger/tax-summary", () => {
  beforeEach(() => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    vi.mocked(getOwnerLedgerRows).mockResolvedValue({ rows: ownerARows, lines: ownerALines });
  });

  it("returns byTaxCategory, byCategory, totalExpenses, and the disclaimer", async () => {
    const res = await makeApp(ownerSession(OWNER_A)).request(
      "/owner-ledger/tax-summary?fromMonth=2026-06&toMonth=2026-06",
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Tax groupings: management_fee is a rental_expense.
    expect(body.data.byTaxCategory).toEqual({ rental_expense: "216.00" }); // 200+16 sst
    expect(body.data.byCategory).toEqual({ management_fee: "216.00" });
    expect(body.data.totalExpenses).toBe("216.00");

    // Disclaimer must be present (never say "deductible").
    expect(typeof body.data.disclaimer).toBe("string");
    expect(body.data.disclaimer).toContain("consult your tax agent");
    expect(body.data.disclaimer.toLowerCase()).not.toContain("deductible");
  });

  it("scopes to session.partyId (not any query param)", async () => {
    await makeApp(ownerSession(OWNER_A)).request(
      `/owner-ledger/tax-summary?fromMonth=2026-06&toMonth=2026-06`,
    );
    expect(getOwnerLedgerRows).toHaveBeenCalledWith(ORG, OWNER_A, "2026-06", "2026-06", undefined);
  });
});

// ─── (e) /properties/:id 404 for non-owned property ──────────────────────────

describe("GET /owner-ledger/properties/:id", () => {
  beforeEach(() => {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  });

  it("returns property view for owner A's own property", async () => {
    vi.mocked(getOwnerPropertyView).mockResolvedValue(propertyView);

    const res = await makeApp(ownerSession(OWNER_A)).request(`/owner-ledger/properties/${PROP_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.id).toBe(PROP_A);
    expect(body.data.name).toBe("Annex Residence");
    expect(body.data.address.city).toBe("Kuala Lumpur");
    expect(body.data.units).toHaveLength(1);
    expect(body.data.units[0].unitCode).toBe("A-1");
    expect(body.data.units[0].currentTenancy.tenantDisplayName).toBe("Tan Wei");
    expect(body.data.units[0].deposits[0].type).toBe("security");
    expect(body.data.managementFeeConfig.feeType).toBe("percent");
    // Scoped to owner A.
    expect(getOwnerPropertyView).toHaveBeenCalledWith(ORG, OWNER_A, PROP_A);
  });

  it("404 when property is not owned by the session owner", async () => {
    vi.mocked(getOwnerPropertyView).mockResolvedValue(null);

    const res = await makeApp(ownerSession(OWNER_A)).request(
      "/owner-ledger/properties/99999999-9999-4999-8999-999999999999",
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });
});
