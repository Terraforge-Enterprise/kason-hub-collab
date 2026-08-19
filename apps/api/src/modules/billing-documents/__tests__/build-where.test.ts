// buildWhere is the money-visibility core of the Documents register: it translates the
// list query into the Prisma filter. The route tests mock ../repository, so they only
// prove the zod CSV→array transform + wiring — buildWhere itself never runs there. These
// pure unit tests exercise the real branch logic (no DB: buildWhere resolves getDb()
// lazily, only for the `q` party-search which these cases never trigger).
import { describe, it, expect } from "vitest";
import { listBillingDocumentsQuery } from "@kason/shared";
import { buildWhere } from "../repository";

const ORG = "org-1";
// Parse raw query strings so the schema's CSV/boolean transforms run end-to-end,
// exactly as the route feeds c.req.query() in.
const parse = (raw: Record<string, string>) => listBillingDocumentsQuery.parse(raw);

describe("buildWhere — Documents register filter", () => {
  it("translates a CSV docTypes into docType { in: [...] } (Invoices register spans invoice+debit_note)", async () => {
    const where = await buildWhere(ORG, parse({ docTypes: "invoice,debit_note" }));
    expect(where.docType).toEqual({ in: ["invoice", "debit_note"] });
  });

  it("docTypes supersedes a single docType when both are present", async () => {
    const where = await buildWhere(ORG, parse({ docType: "receipt", docTypes: "invoice,debit_note" }));
    expect(where.docType).toEqual({ in: ["invoice", "debit_note"] });
  });

  it("falls back to a single docType when docTypes is absent", async () => {
    const where = await buildWhere(ORG, parse({ docType: "invoice" }));
    expect(where.docType).toBe("invoice");
  });

  it("primaryOnly filters to originalDocumentId IS NULL (excludes adjustment/correction notes)", async () => {
    const where = await buildWhere(ORG, parse({ primaryOnly: "true" }));
    expect(where.originalDocumentId).toBeNull();
  });

  it("activeOnly excludes CANCELLED / SUPERSEDED documents", async () => {
    const where = await buildWhere(ORG, parse({ activeOnly: "true" }));
    expect(where.documentStatus).toEqual({ notIn: ["CANCELLED", "SUPERSEDED"] });
  });

  it("the full Invoices-register query scopes to primary, live bills across both docTypes", async () => {
    const where = await buildWhere(
      ORG,
      parse({ docTypes: "invoice,debit_note", primaryOnly: "true", activeOnly: "true" }),
    );
    expect(where).toMatchObject({
      organizationId: ORG,
      docType: { in: ["invoice", "debit_note"] },
      originalDocumentId: null,
      documentStatus: { notIn: ["CANCELLED", "SUPERSEDED"] },
    });
  });

  it("omits primaryOnly/activeOnly keys when not requested (byte-identical for other callers)", async () => {
    const where = await buildWhere(ORG, parse({ docType: "receipt" }));
    expect("originalDocumentId" in where).toBe(false);
    expect("documentStatus" in where).toBe(false);
  });
});
