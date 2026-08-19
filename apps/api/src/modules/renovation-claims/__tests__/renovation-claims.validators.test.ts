import { describe, expect, it } from "vitest";
import {
  validateDocumentGate,
  validateSplitsHundredPercent,
} from "../renovation-claims.validators";

describe("validateSplitsHundredPercent", () => {
  it("rejects empty splits array", () => {
    const r = validateSplitsHundredPercent([], 25000);
    expect(r.ok).toBe(false);
  });

  it("happy: 60/15/25 percent splits sum exactly to package price", () => {
    const r = validateSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 60 },
        { splitType: "percent", splitValue: 15 },
        { splitType: "percent", splitValue: 25 },
      ],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("happy: percent-only with non-round package price", () => {
    const r = validateSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 50 },
        { splitType: "percent", splitValue: 50 },
      ],
      45000,
    );
    expect(r.ok).toBe(true);
  });

  it("happy: fixed-only splits sum to price", () => {
    const r = validateSplitsHundredPercent(
      [
        { splitType: "fixed", splitValue: 15000 },
        { splitType: "fixed", splitValue: 10000 },
      ],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("happy: mixed percent + fixed sums correctly", () => {
    // Half percent, half fixed: 50% of 25000 = 12500, plus fixed 12500 = 25000.
    const r = validateSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 50 },
        { splitType: "fixed", splitValue: 12500 },
      ],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts ±RM 0.01 boundary (under)", () => {
    // Total = 24999.99, price 25000.00 → diff exactly 0.01 → ok.
    const r = validateSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 24999.99 }],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts ±RM 0.01 boundary (over)", () => {
    const r = validateSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 25000.01 }],
      25000,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects RM 0.02 over", () => {
    const r = validateSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 25000.02 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects RM 0.02 under", () => {
    const r = validateSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: 24999.98 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects when total grossly off", () => {
    const r = validateSplitsHundredPercent(
      [
        { splitType: "percent", splitValue: 60 },
        { splitType: "percent", splitValue: 30 },
      ],
      25000,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sum/i);
  });

  it("rejects non-finite price", () => {
    const r = validateSplitsHundredPercent(
      [{ splitType: "percent", splitValue: 100 }],
      Number.NaN,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects negative split value", () => {
    const r = validateSplitsHundredPercent(
      [{ splitType: "fixed", splitValue: -1 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unknown split type", () => {
    const r = validateSplitsHundredPercent(
      [{ splitType: "weird" as unknown as "fixed", splitValue: 25000 }],
      25000,
    );
    expect(r.ok).toBe(false);
  });
});

describe("validateDocumentGate", () => {
  it("happy: one quotation + one invoice", () => {
    const r = validateDocumentGate([{ kind: "quotation" }, { kind: "invoice" }]);
    expect(r.ok).toBe(true);
  });

  it("happy: 2 quotations + 1 invoice (multiples are fine)", () => {
    const r = validateDocumentGate([
      { kind: "quotation" },
      { kind: "quotation" },
      { kind: "invoice" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("happy: quotation + invoice + agreement", () => {
    const r = validateDocumentGate([
      { kind: "quotation" },
      { kind: "invoice" },
      { kind: "agreement" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects when quotation missing", () => {
    const r = validateDocumentGate([{ kind: "invoice" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/quotation/i);
  });

  it("rejects when invoice missing", () => {
    const r = validateDocumentGate([{ kind: "quotation" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/invoice/i);
  });

  it("rejects empty document array", () => {
    const r = validateDocumentGate([]);
    expect(r.ok).toBe(false);
  });

  it("rejects when agreement is the only doc", () => {
    const r = validateDocumentGate([{ kind: "agreement" }]);
    expect(r.ok).toBe(false);
  });

  it("rejects non-array input", () => {
    const r = validateDocumentGate(undefined as unknown as { kind: string }[]);
    expect(r.ok).toBe(false);
  });
});
