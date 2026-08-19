// Contract tests for the tenant money-visibility rule.
//
// The load-bearing claim is that a DRAFT charge — one no admin has approved, for
// which no document exists — can never reach a tenant. These tests pin the rule
// itself; the cross-surface integration test
// (apps/api/src/modules/portal/__tests__/draft-charge-not-tenant-visible.integration.test.ts)
// pins that every portal read actually applies it.
import { describe, expect, it } from "vitest";
import { CHARGE_STATUSES } from "../../constants/statuses";
import { DOCUMENT_STATUSES } from "../../schemas/billing-documents";
import {
  isTenantPayableChargeStatus,
  isTenantVisibleChargeStatus,
  LEGACY_CHARGE_STATUS_ALIASES,
  LEGACY_PAYABLE_CHARGE_STATUSES,
  normalizeChargeStatus,
  TENANT_CHARGE_PAYABILITY,
  TENANT_CHARGE_VISIBILITY,
  TENANT_DOCUMENT_VISIBILITY,
  TENANT_HIDDEN_CHARGE_STATUSES,
  TENANT_HIDDEN_DOCUMENT_STATUSES,
  TENANT_PAYABLE_CHARGE_STATUSES,
  tenantVisibleChargeWhere,
  tenantVisibleDocumentWhere,
} from "../tenant-visibility";

describe("tenant charge visibility", () => {
  it("hides draft — the whole point: no document has been issued for it yet", () => {
    expect(TENANT_CHARGE_VISIBILITY.draft).toBe(false);
    expect(isTenantVisibleChargeStatus("draft")).toBe(false);
    expect(TENANT_HIDDEN_CHARGE_STATUSES).toContain("draft");
  });

  it("hides void and shows every other live status", () => {
    expect(TENANT_HIDDEN_CHARGE_STATUSES).toEqual(["draft", "void"]);
    for (const s of ["posted", "partially_paid", "paid", "credited"] as const) {
      expect(isTenantVisibleChargeStatus(s)).toBe(true);
    }
  });

  it("classifies EVERY status in the live vocabulary (no silent gaps)", () => {
    for (const s of CHARGE_STATUSES) {
      expect(TENANT_CHARGE_VISIBILITY).toHaveProperty(s);
      expect(TENANT_CHARGE_PAYABILITY).toHaveProperty(s);
      expect(typeof TENANT_CHARGE_VISIBILITY[s]).toBe("boolean");
    }
    expect(Object.keys(TENANT_CHARGE_VISIBILITY).sort()).toEqual([...CHARGE_STATUSES].sort());
  });

  // The deny-list decision. statuses.ts warns that CHARGE_STATUSES is the LIVE
  // write-set, not an exhaustive historical one — so an allow-list would erase
  // real, still-owed legacy money from the tenant's portal.
  it("keeps unknown/legacy statuses VISIBLE (fails safe for money the tenant owes)", () => {
    expect(isTenantVisibleChargeStatus("partial")).toBe(true);
    expect(isTenantVisibleChargeStatus("some_status_invented_in_2029")).toBe(true);
  });

  it("emits a notIn filter, freshly built each call so no caller can mutate it", () => {
    const a = tenantVisibleChargeWhere();
    expect(a).toEqual({ status: { notIn: ["draft", "void"] } });
    a.status.notIn.push("posted");
    expect(tenantVisibleChargeWhere().status.notIn).toEqual(["draft", "void"]);
  });
});

describe("tenant charge payability", () => {
  it("refuses draft and void", () => {
    expect(isTenantPayableChargeStatus("draft")).toBe(false);
    expect(isTenantPayableChargeStatus("void")).toBe(false);
  });

  it("refuses already-settled charges (visible as history, nothing left to pay)", () => {
    expect(isTenantVisibleChargeStatus("paid")).toBe(true);
    expect(isTenantPayableChargeStatus("paid")).toBe(false);
    expect(isTenantVisibleChargeStatus("credited")).toBe(true);
    expect(isTenantPayableChargeStatus("credited")).toBe(false);
  });

  it("allows the two live open statuses", () => {
    expect(isTenantPayableChargeStatus("posted")).toBe(true);
    expect(isTenantPayableChargeStatus("partially_paid")).toBe(true);
  });

  // Inverse of the visibility rule: paying is a money MUTATION, so an
  // unrecognised state must fail closed rather than open.
  it("refuses an unrecognised status (allow-list, fails closed)", () => {
    expect(isTenantPayableChargeStatus("some_status_invented_in_2029")).toBe(false);
    expect(isTenantPayableChargeStatus("")).toBe(false);
  });

  it("still allows the documented legacy 'partial' via the alias", () => {
    expect(normalizeChargeStatus("partial")).toBe("partially_paid");
    expect(isTenantPayableChargeStatus("partial")).toBe(true);
  });

  // Pinned by portal.payments.pay.integration.test.ts, which seeds charges in
  // these states and asserts they are offered for payment. Narrowing the list
  // would turn an open receivable unpayable.
  it("preserves the non-vocabulary payable statuses the portal already accepted", () => {
    expect(isTenantPayableChargeStatus("overdue")).toBe(true);
    expect(isTenantPayableChargeStatus("pending")).toBe(true);
    expect(TENANT_PAYABLE_CHARGE_STATUSES).toEqual([
      "overdue", "partial", "partially_paid", "pending", "posted",
    ]);
  });

  // The legacy carve-out is enumerated, so it never becomes a blanket
  // "anything unknown is payable" escape hatch.
  it("never lets draft or void in through the legacy carve-out", () => {
    expect(LEGACY_PAYABLE_CHARGE_STATUSES).not.toContain("draft");
    expect(LEGACY_PAYABLE_CHARGE_STATUSES).not.toContain("void");
    expect(TENANT_PAYABLE_CHARGE_STATUSES).not.toContain("draft");
    expect(TENANT_PAYABLE_CHARGE_STATUSES).not.toContain("void");
  });

  it("never lets a legacy alias point at a status that is not live", () => {
    for (const live of Object.values(LEGACY_CHARGE_STATUS_ALIASES)) {
      expect(CHARGE_STATUSES).toContain(live);
    }
  });

  it("payable ⊆ visible — nothing is payable that the tenant cannot even see", () => {
    for (const s of CHARGE_STATUSES) {
      if (TENANT_CHARGE_PAYABILITY[s]) expect(TENANT_CHARGE_VISIBILITY[s]).toBe(true);
    }
  });
});

describe("tenant document visibility", () => {
  it("hides DRAFT documents and keeps issued/cancelled/superseded", () => {
    expect(TENANT_HIDDEN_DOCUMENT_STATUSES).toEqual(["DRAFT"]);
    expect(tenantVisibleDocumentWhere()).toEqual({ documentStatus: { notIn: ["DRAFT"] } });
  });

  it("classifies every document status in the vocabulary", () => {
    for (const s of DOCUMENT_STATUSES) expect(TENANT_DOCUMENT_VISIBILITY).toHaveProperty(s);
    expect(Object.keys(TENANT_DOCUMENT_VISIBILITY).sort()).toEqual([...DOCUMENT_STATUSES].sort());
  });
});
