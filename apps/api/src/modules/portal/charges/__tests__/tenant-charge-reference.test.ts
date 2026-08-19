import { describe, it, expect } from "vitest";
import { pickTenantBillReference, type ChargeDocumentRef } from "../tenant-charge-reference";

const doc = (o: Partial<ChargeDocumentRef> & Pick<ChargeDocumentRef, "documentNumber">): ChargeDocumentRef => ({
  docType: "invoice",
  issuedAt: new Date("2026-08-17T00:00:00.000Z"),
  ...o,
});

describe("pickTenantBillReference — never show a tenant an internal id", () => {
  it("returns the invoice number for a charge billed on an invoice", () => {
    expect(pickTenantBillReference([doc({ documentNumber: "IVTEN-0002" })])).toBe("IVTEN-0002");
  });

  it("prefers the EARLIEST invoice when a charge was re-billed", () => {
    const ref = pickTenantBillReference([
      doc({ documentNumber: "IVTEN-0009", issuedAt: new Date("2026-09-01") }),
      doc({ documentNumber: "IVTEN-0002", issuedAt: new Date("2026-08-17") }),
    ]);
    // The tenant is chasing the bill they were first sent, not the latest revision.
    expect(ref).toBe("IVTEN-0002");
  });

  it("falls back to a debit note — equally a bill the tenant owes", () => {
    // The Invoices register deliberately spans invoice AND debit_note (DEP-series
    // rent/utility bills under pay_back_landlord); both are bills owed.
    const ref = pickTenantBillReference([doc({ documentNumber: "DEP-2026-0007", docType: "debit_note" })]);
    expect(ref).toBe("DEP-2026-0007");
  });

  it("prefers an invoice over a debit note regardless of order or date", () => {
    const ref = pickTenantBillReference([
      doc({ documentNumber: "DN-0003", docType: "debit_note", issuedAt: new Date("2026-08-01") }),
      doc({ documentNumber: "IVTEN-0002", docType: "invoice", issuedAt: new Date("2026-08-17") }),
    ]);
    expect(ref).toBe("IVTEN-0002");
  });

  it("ignores a credit note, refund note and receipt — none of them is the bill", () => {
    expect(
      pickTenantBillReference([
        doc({ documentNumber: "CN-0003", docType: "credit_note" }),
        doc({ documentNumber: "RN-0001", docType: "refund_note" }),
        doc({ documentNumber: "RCPT-0007", docType: "receipt" }),
      ]),
    ).toBeNull();
  });

  it("returns null for a charge on no document at all", () => {
    // A doc-less grid charge. The caller must render the description and due date
    // rather than falling through to `chargeNumber` — that is the leak: tenants were
    // shown 'GRIDEXP-202608-360f0307-7426-412f-b362-3e500534b44d-SST'.
    expect(pickTenantBillReference([])).toBeNull();
  });

  it("accepts ISO strings as well as Dates, so a JSON round-trip sorts the same", () => {
    const ref = pickTenantBillReference([
      doc({ documentNumber: "IVTEN-0009", issuedAt: "2026-09-01T00:00:00.000Z" }),
      doc({ documentNumber: "IVTEN-0002", issuedAt: "2026-08-17T00:00:00.000Z" }),
    ]);
    expect(ref).toBe("IVTEN-0002");
  });

  it("is deterministic when two candidates share an issuedAt", () => {
    const a = pickTenantBillReference([
      doc({ documentNumber: "IVTEN-0005" }),
      doc({ documentNumber: "IVTEN-0002" }),
    ]);
    const b = pickTenantBillReference([
      doc({ documentNumber: "IVTEN-0002" }),
      doc({ documentNumber: "IVTEN-0005" }),
    ]);
    expect(a).toBe(b);
    // Tie broken by document number, so the same charge never flips reference
    // between two page loads.
    expect(a).toBe("IVTEN-0002");
  });
});
