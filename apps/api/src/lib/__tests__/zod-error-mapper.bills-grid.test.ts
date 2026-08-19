import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatZodError } from "../zod-error-mapper";

const schema = z.object({
  tnbTotal: z.string().regex(/^\d+(\.\d{1,2})?$/),
  someUnlabelledField: z.string(),
});

describe("formatZodError — bills-grid domain", () => {
  it("labels a known bills-grid field", () => {
    const r = schema.safeParse({ tnbTotal: "abc", someUnlabelledField: "ok" });
    expect(r.success).toBe(false);
    if (r.success) return;
    const out = formatZodError(r.error, { domain: "bills-grid" });
    expect(out.fieldErrors.tnbTotal).toContain("TNB total");
  });

  it("falls back to the raw path for an unlabelled field, without throwing", () => {
    const r = schema.safeParse({ tnbTotal: "10.00", someUnlabelledField: 5 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const out = formatZodError(r.error, { domain: "bills-grid" });
    expect(out.fieldErrors.someUnlabelledField).toBeTruthy();
  });
});
