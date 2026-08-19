// vi.stubEnv BEFORE importing navigation (it reads import.meta.env at module scope
// via isPhase2FlagEnabled) — use dynamic import per case + vi.resetModules().
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => vi.resetModules());

async function loadNav(flagOn: boolean) {
  vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", flagOn ? "true" : "");
  const mod = await import("../navigation");
  return mod.navSections;
}

describe("Billing nav: BILLING_DOCS gates Documents + retires Charges/Payments", () => {
  it("flag ON: Billing has Documents; Charges/Payments retired from Billing and Hidden", async () => {
    const sections = await loadNav(true);
    const billing = sections.find((s) => s.label === "Billing")!;
    const titles = billing.items.map((i) => i.title);
    expect(titles).toContain("Documents");
    // Charges/Payments are retired from the active nav once the accounting
    // workspace (BILLING_DOCS) is on — Documents/Invoices/Receipts supersede
    // them; they remain reachable by URL only (see navigation.ts:209-214,266-271).
    expect(titles).not.toContain("Charges");
    expect(titles).not.toContain("Payments");
    const hidden = sections.find((s) => s.label === "Hidden")!;
    expect(hidden.items.map((i) => i.title)).not.toContain("Charges");
    expect(hidden.items.map((i) => i.title)).not.toContain("Payments");
  });
  it("flag OFF: Charges/Payments remain in Hidden; no Documents item", async () => {
    const sections = await loadNav(false);
    const hidden = sections.find((s) => s.label === "Hidden")!;
    expect(hidden.items.map((i) => i.title)).toEqual(expect.arrayContaining(["Charges", "Payments"]));
    const billing = sections.find((s) => s.label === "Billing");
    if (billing) {
      expect(billing.items.map((i) => i.title)).not.toContain("Documents");
    }
  });
});
