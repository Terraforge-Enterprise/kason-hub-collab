// vi.stubEnv BEFORE importing navigation (it reads import.meta.env at module scope
// via isPhase2FlagEnabled) — use dynamic import per case + vi.resetModules().
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => vi.resetModules());

async function loadNav(flagOn: boolean) {
  vi.stubEnv("VITE_ENABLE_PHASE2_BILLS_GRID", flagOn ? "true" : "");
  // Keep the other two Billing-section flags OFF so this test isolates the
  // ENABLE_PHASE2_BILLS_GRID section-condition extension (Step 2 of the brief).
  vi.stubEnv("VITE_ENABLE_PHASE2_AUTODRAFT", "");
  vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "");
  const mod = await import("../navigation");
  return mod.navSections;
}

describe("Tenant & Owner Billing nav entry (flag-gated)", () => {
  it("flag ON: Billing section appears with the Tenant & Owner Billing item at /billing/tenant-owner-billing", async () => {
    const sections = await loadNav(true);
    const billing = sections.find((s) => s.label === "Billing");
    expect(billing).toBeDefined();
    const item = billing!.items.find((i) => i.title === "Tenant & Owner Billing");
    expect(item).toBeDefined();
    expect(item!.href).toBe("/billing/tenant-owner-billing");
  });

  it("flag OFF: no Tenant & Owner Billing item and no /billing/tenant-owner-billing href anywhere in the nav", async () => {
    const sections = await loadNav(false);
    const allItems = sections.flatMap((s) => s.items);
    expect(allItems.map((i) => i.title)).not.toContain("Tenant & Owner Billing");
    expect(allItems.map((i) => i.href)).not.toContain("/billing/tenant-owner-billing");
  });
});
