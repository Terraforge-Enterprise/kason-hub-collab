import { describe, it, expect } from "vitest";
import { buildOwnerStatementInvoiceKey } from "../owner-billing.repository";

/**
 * Deliverable C (Task 6): ONE shared owner-statement INVOICE idempotency-key
 * builder. generateStatementService (owner-billing.service) and the freeze service
 * (owner-statement-period.service) BOTH mint the `owner:<owner>:<month>[:<apt>]`
 * Invoice key through THIS single function, so the freeze's post-commit PDF lookup
 * (findInvoiceByIdempotencyKey) can NEVER drift from the key generate persisted — a
 * drift would silently leave every frozen period without a PDF.
 *
 * NOTE: this is the `owner:` INVOICE key — DELIBERATELY DISTINCT from the frozen
 * period's `ownerstmt:` key (buildStatementPeriodKey). These assertions lock the
 * exact byte shape and prove agreement with generate's historical inline formula.
 */
const OWNER = "11111111-1111-4111-8111-111111111111";
const APT = "22222222-2222-4222-8222-222222222222";
const MONTH = "2026-06";

// The EXACT historical inline formula generateStatementService used before the
// extraction (owner-billing.service.ts:490-492). The shared builder MUST reproduce
// it byte-for-byte — reproduced independently here so the test fails if the shared
// builder's output ever diverges from what the generate path used to mint.
function legacyGenerateInlineKey(
  ownerPartyId: string,
  billingMonth: string,
  apartmentId?: string,
): string {
  return apartmentId
    ? `owner:${ownerPartyId}:${billingMonth}:${apartmentId}`
    : `owner:${ownerPartyId}:${billingMonth}`;
}

describe("buildOwnerStatementInvoiceKey — shared owner-statement Invoice key (Task 6 C)", () => {
  it("combined scope (no apartmentId) → owner:<owner>:<month>", () => {
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH)).toBe(`owner:${OWNER}:${MONTH}`);
  });

  it("per-unit scope (apartmentId set) → owner:<owner>:<month>:<apt>", () => {
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH, APT)).toBe(
      `owner:${OWNER}:${MONTH}:${APT}`,
    );
  });

  it("treats null / undefined / empty-string apartmentId as combined (falsy → no :<apt> suffix)", () => {
    const combined = `owner:${OWNER}:${MONTH}`;
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH, null)).toBe(combined);
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH, undefined)).toBe(combined);
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH, "")).toBe(combined);
  });

  it("agrees byte-for-byte with generateStatementService's legacy inline formula (combined + per-unit)", () => {
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH)).toBe(legacyGenerateInlineKey(OWNER, MONTH));
    expect(buildOwnerStatementInvoiceKey(OWNER, MONTH, APT)).toBe(
      legacyGenerateInlineKey(OWNER, MONTH, APT),
    );
  });
});
