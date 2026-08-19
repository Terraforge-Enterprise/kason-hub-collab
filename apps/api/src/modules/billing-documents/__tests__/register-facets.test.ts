/**
 * Phase 0C (§7-A? / D3): lock the doc-type register FACET semantics that the Phase-1
 * "All documents / Invoices / Credit notes / Debit notes" tabs rely on. buildWhere's
 * facet branches (docTypes / primaryOnly / activeOnly / counterpartyType) are DB-free —
 * only the free-text `q.q` search touches the DB — so this is a fast unit test on the
 * shaped Prisma where clause. Proves each facet selects the correct doc-type set and that
 * a party filter cross-composes.
 */
import { describe, it, expect } from "vitest";
import { buildWhere } from "../repository";

const ORG = "org-facets";

describe("buildWhere — register doc-type facets", () => {
  it('"Credit notes" facet → only credit_note, no primaryOnly filter', async () => {
    const w = await buildWhere(ORG, { docTypes: ["credit_note"] } as never);
    expect(w.docType).toEqual({ in: ["credit_note"] });
    expect(w.originalDocumentId).toBeUndefined(); // CN/DN rows must not be excluded by primaryOnly
  });

  it('"Debit notes" facet (primaryOnly:false) → debit_note incl. DEBIT_ADJUSTMENT notes', async () => {
    const w = await buildWhere(ORG, { docTypes: ["debit_note"], primaryOnly: false } as never);
    expect(w.docType).toEqual({ in: ["debit_note"] });
    expect(w.originalDocumentId).toBeUndefined(); // adjustment DNs (originalDocumentId set) stay
  });

  it('"Invoices" facet keeps its current scoping (primaryOnly:true, activeOnly:true)', async () => {
    const w = await buildWhere(ORG, {
      docTypes: ["invoice", "debit_note"], primaryOnly: true, activeOnly: true,
    } as never);
    expect(w.docType).toEqual({ in: ["invoice", "debit_note"] });
    expect(w.originalDocumentId).toBeNull(); // primary bills only
    expect(w.documentStatus).toEqual({ notIn: ["CANCELLED", "SUPERSEDED"] });
  });

  it('"All documents" facet → invoice+CN+DN+RN as their own rows (no primaryOnly)', async () => {
    const w = await buildWhere(ORG, {
      docTypes: ["invoice", "credit_note", "debit_note", "refund_note"],
    } as never);
    expect(w.docType).toEqual({ in: ["invoice", "credit_note", "debit_note", "refund_note"] });
    expect(w.originalDocumentId).toBeUndefined();
  });

  it("a party (tenant/owner) filter cross-composes with a doc-type facet", async () => {
    const w = await buildWhere(ORG, {
      docTypes: ["credit_note"], counterpartyType: "tenant",
    } as never);
    expect(w.docType).toEqual({ in: ["credit_note"] });
    expect(w.counterpartyType).toBe("tenant");
    expect(w.organizationId).toBe(ORG);
  });
});
