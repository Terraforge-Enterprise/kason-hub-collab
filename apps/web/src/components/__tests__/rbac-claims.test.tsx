// W6 — Unit-level RBAC sweep for the Renovation + Sales claim detail pages.
//
// The server already strips commission $ values from editor responses
// (`packagePrice`, `monthlyOffsetAmount`, `splits` for renovation;
// `commissionValue`, `computedAmount`, `splits` for sales). The detail pages
// add a second-line defence: even if the wire shape ever leaks, the editor
// branch is rendered from a `RoleGate`-style `isEditor` flag and the gated
// blocks are never mounted.
//
// These tests assert both halves of the contract:
//   1. When the user is `editor`, the gated DOM blocks (commission $ amounts,
//      split rows, approve/reject buttons) are absent.
//   2. When the user is `manager`, the same blocks are present.
//
// Both pages are rendered with mocked `getRenovationClaim` / `getSalesClaim`
// API clients so no network traffic happens. The wire shape we feed mirrors
// what the server returns to a manager — the `isEditor` UI branch is
// responsible for hiding that data, NOT the API mock.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type AuthContextType, type User } from "@/lib/auth";

// ── Sonner — toast.success/error are called from useMutation onSuccess; stub
// to keep tests pure and avoid mounting the toaster portal.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── react-router-dom — claim detail pages use useParams + useNavigate. Stub
// both so the tests do not need a real router. We pin the id so the
// underlying useQuery runs.
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: "claim-test-id" }),
}));

// ── API mocks ────────────────────────────────────────────────────────────────

const mockGetRenovationClaim = vi.fn();
const mockApproveRenovation = vi.fn();
const mockRejectRenovation = vi.fn();
const mockNeedsAmendmentRenovation = vi.fn();
const mockGetRenovationDocumentViewUrl = vi.fn();

vi.mock("@/api/renovation-claims", () => ({
  approveRenovationClaim: (...a: unknown[]) => mockApproveRenovation(...a),
  rejectRenovationClaim: (...a: unknown[]) => mockRejectRenovation(...a),
  needsAmendmentRenovationClaim: (...a: unknown[]) =>
    mockNeedsAmendmentRenovation(...a),
  getRenovationClaim: (...a: unknown[]) => mockGetRenovationClaim(...a),
  getRenovationDocumentViewUrl: (...a: unknown[]) =>
    mockGetRenovationDocumentViewUrl(...a),
}));

const mockGetSalesClaim = vi.fn();
const mockApproveSales = vi.fn();
const mockRejectSales = vi.fn();
const mockNeedsAmendmentSales = vi.fn();

vi.mock("@/api/sales-claims", () => ({
  approveSalesClaim: (...a: unknown[]) => mockApproveSales(...a),
  rejectSalesClaim: (...a: unknown[]) => mockRejectSales(...a),
  needsAmendmentSalesClaim: (...a: unknown[]) => mockNeedsAmendmentSales(...a),
  getSalesClaim: (...a: unknown[]) => mockGetSalesClaim(...a),
}));

// ── Shared fixtures ──────────────────────────────────────────────────────────

const RENOVATION_CLAIM_FULL = {
  id: "rc-1",
  organizationId: "org-1",
  salesUnitId: "su-1",
  packageId: "pkg-1",
  // Distinctive numeric strings so absence is unambiguous in the DOM check.
  packagePrice: 12_345,
  paymentType: "offset_from_rental" as const,
  monthlyOffsetAmount: 678.9,
  status: "submitted" as const,
  notes: null,
  submittedAt: "2026-04-01T00:00:00.000Z",
  submittedById: "user-agent-1234",
  reviewedAt: null,
  reviewedById: null,
  reviewerNote: null,
  splits: [
    {
      id: "split-1",
      organizationId: "org-1",
      claimId: "rc-1",
      partyPartyId: null,
      partyDisplayName: "Sales Commission",
      roleLabel: "Sales Commission",
      splitType: "percent" as const,
      splitValue: 60,
      isHouseKeep: false,
      sortOrder: 1,
    },
  ],
  documents: [
    {
      id: "doc-1",
      organizationId: "org-1",
      claimId: "rc-1",
      kind: "quotation" as const,
      fileKey: "key/quote.pdf",
      filename: "quote.pdf",
      uploadedAt: "2026-04-01T00:00:00.000Z",
      uploadedById: "user-agent-1234",
    },
  ],
};

const SALES_CLAIM_FULL = {
  id: "sc-1",
  organizationId: "org-1",
  salesUnitId: "su-1",
  commissionType: "percent_of_purchase" as const,
  commissionValue: 2.5,
  computedAmount: 24_680,
  paymentType: "full" as const,
  status: "submitted" as const,
  notes: null,
  submittedAt: "2026-04-01T00:00:00.000Z",
  submittedById: "user-agent-5678",
  reviewedAt: null,
  reviewedById: null,
  reviewerNote: null,
  splits: [
    {
      id: "split-2",
      organizationId: "org-1",
      claimId: "sc-1",
      partyPartyId: null,
      partyDisplayName: "Listing Commission",
      roleLabel: "Listing Commission",
      splitType: "percent" as const,
      splitValue: 100,
      sortOrder: 1,
    },
  ],
};

// ── Test harness ─────────────────────────────────────────────────────────────

function makeUser(role: string): User {
  return {
    id: `u-${role}`,
    fullName: `Test ${role}`,
    email: `${role}@kaen.test`,
    role,
    orgId: "org-1",
    userType: "operator",
  };
}

function makeAuth(role: string): AuthContextType {
  return {
    user: makeUser(role),
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
    isAuthenticated: true,
  };
}

function renderWithAuth(role: string, ui: React.ReactNode) {
  // Disable retries so the test surfaces failures synchronously.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={makeAuth(role)}>{ui}</AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Renovation claim detail ─────────────────────────────────────────────────

describe("Renovation claim detail — RBAC", () => {
  // Imported inside the suite so the component picks up the vi.mock() bindings
  // above. Using top-level `import` works too, but the consensus pattern in
  // this codebase is to require after mocks (mirrors agent-claim-new.test.tsx).
  // Both flavours work because `vi.mock` is hoisted.
  it("Editor: hides commission $ amounts, splits and reviewer buttons", async () => {
    mockGetRenovationClaim.mockResolvedValueOnce(RENOVATION_CLAIM_FULL);
    const { default: RenovationClaimDetailPage } = await import(
      "@/pages/renovation/claim-detail-page"
    );

    renderWithAuth("editor", <RenovationClaimDetailPage />);

    // Wait for the loaded state — the page header includes "Renovation claim".
    await waitFor(() => {
      expect(screen.getByText("Renovation claim")).toBeInTheDocument();
    });

    // The editor "view-only" callout is the human-visible signal.
    expect(screen.getByText(/Editor view/i)).toBeInTheDocument();

    // Commission $ amounts MUST be absent.
    // formatRM renders 12,345 as "RM 12,345.00" and 678.9 as "RM 678.90".
    expect(screen.queryByText(/RM 12,345\.00/)).toBeNull();
    expect(screen.queryByText(/RM 678\.90/)).toBeNull();
    // Field labels for the gated detail fields are also hidden.
    expect(screen.queryByText("Package price")).toBeNull();
    expect(screen.queryByText("Monthly offset")).toBeNull();
    // Splits + Documents cards are gated — no party display name renders.
    expect(screen.queryByText("Sales Commission")).toBeNull();
    expect(screen.queryByText("quote.pdf")).toBeNull();

    // Reviewer buttons MUST be absent for editor.
    expect(screen.queryByRole("button", { name: /^Approve$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reject$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Needs amendment/i })).toBeNull();
  });

  it("Manager: shows commission $ amounts, splits and reviewer buttons", async () => {
    mockGetRenovationClaim.mockResolvedValueOnce(RENOVATION_CLAIM_FULL);
    const { default: RenovationClaimDetailPage } = await import(
      "@/pages/renovation/claim-detail-page"
    );

    renderWithAuth("manager", <RenovationClaimDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Renovation claim")).toBeInTheDocument();
    });

    // Editor callout MUST NOT render for managers.
    expect(screen.queryByText(/Editor view/i)).toBeNull();

    // Commission $ amounts must be present (may appear more than once if a
    // split row also renders the same amount — manager view is allowed to).
    expect(screen.getAllByText(/RM 12,345\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/RM 678\.90/).length).toBeGreaterThan(0);
    // Gated field labels visible.
    expect(screen.getByText("Package price")).toBeInTheDocument();
    expect(screen.getByText("Monthly offset")).toBeInTheDocument();
    // Splits + Documents cards render for managers. The split's party
    // display name AND role label may both render the same text — assert
    // ≥1 occurrence rather than uniqueness.
    expect(screen.getAllByText("Sales Commission").length).toBeGreaterThan(0);
    expect(screen.getByText("quote.pdf")).toBeInTheDocument();

    // Reviewer buttons all present.
    expect(screen.getByRole("button", { name: /^Approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Needs amendment/i }),
    ).toBeInTheDocument();
  });
});

// ── Sales claim detail ──────────────────────────────────────────────────────

describe("Sales claim detail — RBAC", () => {
  it("Editor: hides commission $ amounts, splits and reviewer buttons", async () => {
    mockGetSalesClaim.mockResolvedValueOnce(SALES_CLAIM_FULL);
    const { default: SalesClaimDetailPage } = await import(
      "@/pages/sales/claim-detail-page"
    );

    renderWithAuth("editor", <SalesClaimDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Sales claim")).toBeInTheDocument();
    });

    expect(screen.getByText(/Editor view/i)).toBeInTheDocument();

    // Commission value (2.5%) and computed amount (RM 24,680.00) MUST be hidden.
    expect(screen.queryByText("2.5%")).toBeNull();
    expect(screen.queryByText(/RM 24,680\.00/)).toBeNull();
    expect(screen.queryByText("Commission value")).toBeNull();
    expect(screen.queryByText("Computed amount")).toBeNull();
    // Splits gated.
    expect(screen.queryByText("Listing Commission")).toBeNull();

    // Reviewer buttons absent.
    expect(screen.queryByRole("button", { name: /^Approve$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reject$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Needs amendment/i })).toBeNull();
  });

  it("Manager: shows commission $ amounts, splits and reviewer buttons", async () => {
    mockGetSalesClaim.mockResolvedValueOnce(SALES_CLAIM_FULL);
    const { default: SalesClaimDetailPage } = await import(
      "@/pages/sales/claim-detail-page"
    );

    renderWithAuth("manager", <SalesClaimDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Sales claim")).toBeInTheDocument();
    });

    expect(screen.queryByText(/Editor view/i)).toBeNull();

    // Commission value + computed amount visible. The amount may appear more
    // than once (Computed amount field + Splits card row at 100%); assert ≥1
    // match rather than uniqueness.
    expect(screen.getByText("2.5%")).toBeInTheDocument();
    expect(screen.getAllByText(/RM 24,680\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText("Commission value")).toBeInTheDocument();
    expect(screen.getByText("Computed amount")).toBeInTheDocument();
    // Splits card row with the party display name renders for managers.
    // partyDisplayName + roleLabel both equal "Listing Commission" — ≥1 OK.
    expect(screen.getAllByText("Listing Commission").length).toBeGreaterThan(0);

    // Reviewer buttons all present.
    expect(screen.getByRole("button", { name: /^Approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Needs amendment/i }),
    ).toBeInTheDocument();
  });
});
