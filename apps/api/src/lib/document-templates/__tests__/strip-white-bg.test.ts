import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { stripWhiteBg } from "../strip-white-bg";

async function makeSolidPng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

describe("stripWhiteBg", () => {
  it("turns near-white pixels transparent on raster PNG", async () => {
    const input = await makeSolidPng(255, 255, 255);
    const out = await stripWhiteBg(input, "image/png");
    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      expect(data[i + 3]).toBe(0);
    }
  });

  it("leaves non-white pixels opaque", async () => {
    const input = await makeSolidPng(10, 20, 30);
    const out = await stripWhiteBg(input, "image/png");
    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      expect(data[i + 3]).toBe(255);
    }
  });

  it("returns SVG bytes unchanged", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    const out = await stripWhiteBg(svg, "image/svg+xml");
    expect(out).toBe(svg);
  });

  it("converts JPEG with white bg to transparent PNG", async () => {
    const jpg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .jpeg()
      .toBuffer();
    const out = await stripWhiteBg(jpg, "image/jpeg");
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
  });
});
