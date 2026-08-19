import sharp from "sharp";

// Pixels brighter than this on every channel are treated as background and
// converted to alpha = 0. 240/255 ≈ 94% — strict enough to leave typical
// off-white brand colours alone, loose enough to handle JPEG compression
// artefacts on uploaded logos.
const WHITE_BG_THRESHOLD = 240;

export async function stripWhiteBg(buf: Buffer, contentType: string): Promise<Buffer> {
  if (contentType === "image/svg+xml") return buf;
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  for (let i = 0; i < data.length; i += channels) {
    if (
      data[i] > WHITE_BG_THRESHOLD &&
      data[i + 1] > WHITE_BG_THRESHOLD &&
      data[i + 2] > WHITE_BG_THRESHOLD
    ) {
      data[i + 3] = 0;
    }
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
