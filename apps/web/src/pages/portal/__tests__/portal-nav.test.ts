import { describe, it, expect, vi, beforeEach } from "vitest";
import * as featureFlags from "@/lib/feature-flags";

// ─── Mock feature flags ───────────────────────────────────────────────────────

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: vi.fn(),
}));

const mockIsPhase2FlagEnabled = vi.mocked(featureFlags.isPhase2FlagEnabled);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getPortalNavSections — owner sections (IA redesign)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockIsPhase2FlagEnabled.mockReset();
  });

  it("shows Dashboard + Documents only when ENABLE_PHASE2_OWNER_BILLING is off", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(false);
    const { getPortalNavSections } = await import("@/pages/portal/components/portal-nav");
    const sections = getPortalNavSections("owner");
    const items = sections.flatMap((s) => s.items);
    const hrefs = items.map((i) => i.href);

    expect(hrefs).toContain("/portal/dashboard");
    expect(hrefs).toContain("/portal/owner-docs");
    // Finance items should NOT appear
    expect(hrefs).not.toContain("/portal/statements");
    expect(hrefs).not.toContain("/portal/income-tax");
    expect(hrefs).not.toContain("/portal/transactions");
    // Old nav items must not appear
    expect(hrefs).not.toContain("/portal/financials");
    expect(hrefs).not.toContain("/portal/reports");
    expect(hrefs).not.toContain("/portal/owner-ledger");
    expect(hrefs).not.toContain("/portal/owner-tax-summary");
  });

  it("shows 5 nav items when ENABLE_PHASE2_OWNER_BILLING is on", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    const { getPortalNavSections } = await import("@/pages/portal/components/portal-nav");
    const sections = getPortalNavSections("owner");
    const items = sections.flatMap((s) => s.items);
    const hrefs = items.map((i) => i.href);

    // Required 5 items
    expect(hrefs).toContain("/portal/dashboard");
    expect(hrefs).toContain("/portal/statements");
    expect(hrefs).toContain("/portal/income-tax");
    expect(hrefs).toContain("/portal/transactions");
    expect(hrefs).toContain("/portal/owner-docs");
    expect(items).toHaveLength(5);
  });

  it("does NOT include old Financials, Reports, Ledger, Tax Summary in nav when flag is on", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    const { getPortalNavSections } = await import("@/pages/portal/components/portal-nav");
    const sections = getPortalNavSections("owner");
    const hrefs = sections.flatMap((s) => s.items).map((i) => i.href);

    expect(hrefs).not.toContain("/portal/financials");
    expect(hrefs).not.toContain("/portal/reports");
    expect(hrefs).not.toContain("/portal/owner-ledger");
    expect(hrefs).not.toContain("/portal/owner-tax-summary");
  });

  it("has correct titles for each nav item when flag is on", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    const { getPortalNavSections } = await import("@/pages/portal/components/portal-nav");
    const sections = getPortalNavSections("owner");
    const titles = sections.flatMap((s) => s.items).map((i) => i.title);

    expect(titles).toContain("Dashboard");
    expect(titles).toContain("Statements");
    expect(titles).toContain("Income & Tax");
    expect(titles).toContain("Transactions");
    expect(titles).toContain("Documents");
  });
});

describe("getPortalNavSections — tenant IA redesign", () => {
  it("tenant IA: 4 items Home/My Tenancy/Billing/Documents", async () => {
    const { getPortalNavSections } = await import("@/pages/portal/components/portal-nav");
    const hrefs = getPortalNavSections("tenant").flatMap((s) => s.items).map((i) => i.href);
    expect(hrefs).toEqual([
      "/portal/dashboard", "/portal/my-tenancy", "/portal/billing", "/portal/documents",
    ]);
  });
  it("tenant IA labels: renamed, old labels gone", async () => {
    const { getPortalNavSections } = await import("@/pages/portal/components/portal-nav");
    const titles = getPortalNavSections("tenant").flatMap((s) => s.items).map((i) => i.title);
    expect(titles).toContain("Home");
    expect(titles).toContain("My Tenancy");
    expect(titles).toContain("Billing");
    expect(titles).not.toContain("Lease");
    expect(titles).not.toContain("Charges");
    expect(titles).not.toContain("Statement");
  });
});
