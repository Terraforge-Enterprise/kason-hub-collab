import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mergePdfs } from "../merge-pdfs";

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage();
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe("mergePdfs", () => {
  it("appends extra PDF pages onto the base PDF", async () => {
    const base = await makePdf(1);
    const extra = await makePdf(2);

    const merged = await mergePdfs(base, [extra]);

    const resultDoc = await PDFDocument.load(merged);
    expect(resultDoc.getPageCount()).toBe(3); // 1 base + 2 extra
  });

  it("handles multiple append PDFs", async () => {
    const base = await makePdf(1);
    const extra1 = await makePdf(2);
    const extra2 = await makePdf(3);

    const merged = await mergePdfs(base, [extra1, extra2]);

    const resultDoc = await PDFDocument.load(merged);
    expect(resultDoc.getPageCount()).toBe(6); // 1 + 2 + 3
  });

  it("returns the base buffer unchanged when appendPdfs is empty", async () => {
    const base = await makePdf(2);

    const result = await mergePdfs(base, []);

    expect(result).toBe(base); // same reference, not just equal bytes
    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);
  });

  it("produces a valid loadable PDF", async () => {
    const base = await makePdf(1);
    const extra = await makePdf(1);

    const merged = await mergePdfs(base, [extra]);

    // If this throws, the buffer is not a valid PDF
    await expect(PDFDocument.load(merged)).resolves.toBeDefined();
  });

  it("skips a corrupt/garbage append buffer and keeps the base + the valid ones (never throws)", async () => {
    const base = await makePdf(1);
    const garbage = Buffer.from("%PDF-garbage not real"); // unparseable → would 500
    const validExtra = await makePdf(2);

    // Must RESOLVE (not throw) even though one appended buffer is corrupt — a bad
    // bill must never abort the money document.
    const merged = await mergePdfs(base, [garbage, validExtra]);

    const resultDoc = await PDFDocument.load(merged);
    // Garbage skipped → only base (1) + validExtra (2) survive.
    expect(resultDoc.getPageCount()).toBe(3);
  });

  it("skips an empty / zero-byte append buffer, base preserved", async () => {
    const base = await makePdf(2);
    const empty = Buffer.alloc(0);

    const merged = await mergePdfs(base, [empty]);

    const resultDoc = await PDFDocument.load(merged);
    expect(resultDoc.getPageCount()).toBe(2); // base intact, empty skipped
  });
});
