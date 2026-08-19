import { describe, it, expect } from "vitest";
import { BILLING_DOC_TYPES } from "@kason/shared";
import { DOC_TITLE, LETTERHEAD_DOC_TYPE } from "../pdf.service";

describe("PDF docType maps cover every BILLING_DOC_TYPES value (R6)", () => {
  it("DOC_TITLE has a title for every docType including receipt", () => {
    for (const t of BILLING_DOC_TYPES) {
      expect(DOC_TITLE[t as keyof typeof DOC_TITLE], `title for ${t}`).toBeTypeOf("string");
    }
    expect(DOC_TITLE.receipt).toBe("RECEIPT");
  });

  it("LETTERHEAD_DOC_TYPE maps every docType; receipt reuses the invoice letterhead", () => {
    for (const t of BILLING_DOC_TYPES) {
      expect(LETTERHEAD_DOC_TYPE[t as keyof typeof LETTERHEAD_DOC_TYPE], `letterhead for ${t}`).toBeTypeOf("string");
    }
    expect(LETTERHEAD_DOC_TYPE.receipt).toBe("invoice");
  });
});
