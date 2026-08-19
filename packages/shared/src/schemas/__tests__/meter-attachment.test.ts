import { describe, it, expect } from "vitest";
import { billAttachmentRowSchema } from "../meter";

describe("billAttachmentRowSchema", () => {
  it("accepts a well-formed row", () => {
    const row = { id: crypto.randomUUID(), filename: "TNB-Jul.pdf", url: "https://x/y.pdf", createdAt: new Date().toISOString() };
    expect(billAttachmentRowSchema.parse(row)).toEqual(row);
  });
  it("rejects a missing filename", () => {
    expect(() => billAttachmentRowSchema.parse({ id: crypto.randomUUID(), url: "u", createdAt: "t" })).toThrow();
  });
});
