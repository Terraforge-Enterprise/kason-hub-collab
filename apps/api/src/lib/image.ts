import sharp from "sharp";

/**
 * Shared image helpers for services that fetch an image from S3, sanitise it,
 * and write it back (listing photos).
 */

/**
 * Best-effort MIME lookup based on the S3 key extension. We only accept
 * jpg/jpeg/png/webp — anything else falls back to `application/octet-stream`
 * so S3 doesn't serve mis-typed content.
 */
export function sniffImageMime(key: string): string {
  const ext = key.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

/**
 * Strip EXIF metadata (including GPS and device fingerprints) from an image
 * buffer. `.rotate()` is called first so the EXIF orientation flag is applied
 * to pixels before metadata is dropped — otherwise the visible image can flip.
 */
export async function stripExifBuffer(buf: Buffer): Promise<Buffer> {
  return sharp(buf).rotate().withMetadata({ exif: {} }).toBuffer();
}
