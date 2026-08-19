import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bundled fallback letterhead logo. Returned in PDF renders (via
// getTemplateForOrgDocType) AND in admin listTemplates so the live preview
// matches the actual rendered PDF when no logo has been uploaded.
//
// Source PNG is 4167×4167 (~257 KB) — we resize to 600px and re-encode as a
// compressed paletted PNG on first call, cutting the inline data URL by ~6×.
// Result is cached for the life of the process.
let cached: string | null = null;

export async function getDefaultLogoDataUrl(): Promise<string> {
  if (cached !== null) return cached;
  try {
    const sharp = (await import("sharp")).default;
    const srcPath = join(__dirname, "../../assets/default-letterhead-logo.png");
    const buf = readFileSync(srcPath);
    const resized = await sharp(buf)
      .resize({ width: 600, withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    cached = `data:image/png;base64,${resized.toString("base64")}`;
  } catch {
    cached = "";
  }
  return cached;
}
