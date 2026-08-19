import { describe, it, expect, afterAll } from "vitest";
import { htmlToPdf, closeBrowser } from "../pdf";

const SKIP = !process.env.PUPPETEER_EXECUTABLE_PATH;

describe.skipIf(SKIP)("htmlToPdf", () => {
  afterAll(async () => closeBrowser());

  it("produces a non-empty PDF buffer", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>";
    const buf = await htmlToPdf(html);

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("handles two sequential renders without browser leak", async () => {
    const buf1 = await htmlToPdf("<h1>A</h1>");
    const buf2 = await htmlToPdf("<h1>B</h1>");
    expect(buf1.length).toBeGreaterThan(500);
    expect(buf2.length).toBeGreaterThan(500);
  });
});
