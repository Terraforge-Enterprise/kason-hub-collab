import { describe, it, expect, vi } from "vitest";
import { generateTenancyCodeTx } from "../tenancy-code-generator";

describe("generateTenancyCodeTx", () => {
  it("returns TEN-{year}-0001 when org has no tenancies for this year", async () => {
    const tx = { tenancy: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    const code = await generateTenancyCodeTx(tx, "org-1");
    const year = new Date().getFullYear();
    expect(code).toBe(`TEN-${year}-0001`);
  });

  it("increments the highest existing seq for the current year", async () => {
    const year = new Date().getFullYear();
    const tx = {
      tenancy: {
        findMany: vi.fn().mockResolvedValue([
          { tenancyCode: `TEN-${year}-0042` },
          { tenancyCode: `TEN-${year}-0010` },
        ]),
      },
    } as any;
    const code = await generateTenancyCodeTx(tx, "org-1");
    expect(code).toBe(`TEN-${year}-0043`);
  });

  it("scopes the lookup to the current year prefix only", async () => {
    const year = new Date().getFullYear();
    const tx = { tenancy: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    await generateTenancyCodeTx(tx, "org-1");
    expect(tx.tenancy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenancyCode: { startsWith: `TEN-${year}-` },
        }),
      }),
    );
  });

  // Regression: seed data uses 3-digit suffixes ("TEN-2026-010") while this
  // generator emits 4-digit ("TEN-2026-0011"). Old `orderBy desc` + findFirst
  // ranked 010 above 0011 lexicographically and kept re-emitting 0011, hitting
  // the (organizationId, tenancyCode) unique constraint on every second insert.
  it("treats suffix numerically — mixed-width 3-digit and 4-digit codes don't collide", async () => {
    const year = new Date().getFullYear();
    const tx = {
      tenancy: {
        findMany: vi.fn().mockResolvedValue([
          { tenancyCode: `TEN-${year}-004` },
          { tenancyCode: `TEN-${year}-005` },
          { tenancyCode: `TEN-${year}-010` },
          { tenancyCode: `TEN-${year}-0011` },
        ]),
      },
    } as any;
    const code = await generateTenancyCodeTx(tx, "org-1");
    expect(code).toBe(`TEN-${year}-0012`);
  });
});
