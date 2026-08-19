// vi.stubEnv BEFORE importing navigation (it reads import.meta.env at module scope
// via isPhase2FlagEnabled) — use dynamic import per case + vi.resetModules().
// Mirrors navigation-billing.test.ts's stub pattern (P1 T5 precedent).
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => vi.resetModules());

async function loadNav() {
  vi.stubEnv("VITE_ENABLE_PHASE2_BILLING_DOCS", "true");
  const mod = await import("../navigation");
  return mod;
}

function accountingItems(navSections: Awaited<ReturnType<typeof loadNav>>["navSections"]) {
  return navSections
    .flatMap((s) => s.items)
    .filter((i) => i.href === "/accounting/invoices" || i.href === "/accounting/receipts");
}

describe("accounting nav section", () => {
  it("exposes Invoices + Receipts tagged workspace:accounting", async () => {
    const { navSections } = await loadNav();
    const items = accountingItems(navSections);
    expect(items.map((i) => i.href).sort()).toEqual(["/accounting/invoices", "/accounting/receipts"]);
    for (const i of items) expect(i.workspace).toBe("accounting");
  });
  it("accountant sees them; editor does not", async () => {
    const { navSections, canSeeNavItemFor } = await loadNav();
    for (const i of accountingItems(navSections)) {
      expect(canSeeNavItemFor("accountant", i)).toBe(true);
      expect(canSeeNavItemFor("editor", i)).toBe(false);
    }
  });
});
