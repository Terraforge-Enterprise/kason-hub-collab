/**
 * Pure validators for renovation-claim business rules.
 *
 * Lives in its own file so it can be unit-tested without DB or Hono. Both
 * service-side mutations (submit, approve, edit) and tests reuse these.
 */

export type SplitType = "percent" | "fixed";

export interface SplitForValidation {
  splitType: SplitType;
  splitValue: number;
}

export interface DocumentForValidation {
  kind: string;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

// Tolerance: ±RM 0.01 absolute. Anything beyond rejects.
const SPLIT_TOLERANCE = 0.01;

/**
 * Returns ok=true when the splits sum exactly to packagePrice (within the
 * RM 0.01 tolerance). Each split contributes:
 *   - splitType=percent → packagePrice × splitValue / 100
 *   - splitType=fixed   → splitValue (already in RM)
 *
 * Empty splits → ok=false (must explicitly cover 100%).
 */
export function validateSplitsHundredPercent(
  splits: SplitForValidation[],
  packagePrice: number,
): ValidationResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { ok: false, error: "At least one split is required" };
  }
  if (typeof packagePrice !== "number" || !Number.isFinite(packagePrice) || packagePrice < 0) {
    return { ok: false, error: "Invalid package price" };
  }
  let total = 0;
  for (const s of splits) {
    if (typeof s.splitValue !== "number" || !Number.isFinite(s.splitValue) || s.splitValue < 0) {
      return { ok: false, error: "Split value must be a non-negative number" };
    }
    if (s.splitType === "percent") {
      total += (packagePrice * s.splitValue) / 100;
    } else if (s.splitType === "fixed") {
      total += s.splitValue;
    } else {
      return { ok: false, error: `Unknown split type: ${String(s.splitType)}` };
    }
  }
  const diff = Math.abs(total - packagePrice);
  if (diff > SPLIT_TOLERANCE) {
    return {
      ok: false,
      error: `Splits must sum to package price. Expected RM ${packagePrice.toFixed(2)}, got RM ${total.toFixed(2)}`,
    };
  }
  return { ok: true };
}

/**
 * Document gate: claim must have at least one quotation AND at least one
 * invoice. Agreement is optional. Multiple of each kind is fine.
 */
export function validateDocumentGate(documents: DocumentForValidation[]): ValidationResult {
  if (!Array.isArray(documents)) {
    return { ok: false, error: "documents must be an array" };
  }
  const hasQuotation = documents.some((d) => d.kind === "quotation");
  const hasInvoice = documents.some((d) => d.kind === "invoice");
  if (!hasQuotation && !hasInvoice) {
    return { ok: false, error: "At least one quotation and one invoice document are required" };
  }
  if (!hasQuotation) {
    return { ok: false, error: "At least one quotation document is required" };
  }
  if (!hasInvoice) {
    return { ok: false, error: "At least one invoice document is required" };
  }
  return { ok: true };
}
