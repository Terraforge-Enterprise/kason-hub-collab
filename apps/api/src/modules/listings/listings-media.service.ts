import ffmpeg from "fluent-ffmpeg";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { getObjectAsBuffer, putObject } from "../../lib/storage";
import { sniffImageMime, stripExifBuffer } from "../../lib/image";

// Re-export so existing callers (and tests) that import `sniffImageMime` from
// this module keep working. The canonical definition lives in `lib/image`.
export { sniffImageMime };

/**
 * Server-side EXIF strip for listing photos.
 *
 * Fetches the object uploaded directly to S3 by the client, strips all EXIF
 * metadata (which may contain GPS coordinates and other privacy-sensitive
 * data), then writes the sanitized version back to the same key. Idempotent:
 * re-running against an already-stripped image is a no-op aside from the
 * re-encode round-trip.
 */
export async function stripExifInPlace(key: string): Promise<void> {
  const buf = await getObjectAsBuffer(key);
  const stripped = await stripExifBuffer(buf);
  await putObject(key, stripped, sniffImageMime(key));
}

/**
 * Server-side 720p H.264 transcode for listing videos.
 *
 * Fetches the raw upload, transcodes to 720p H.264 + AAC at CRF 26 via
 * fluent-ffmpeg (requires ffmpeg binary on PATH at runtime), and writes the
 * result back as video/mp4 to the same key. Temp files are cleaned up even
 * when ffmpeg fails.
 */
export async function transcodeVideoInPlace(key: string): Promise<void> {
  const buf = await getObjectAsBuffer(key);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = join(tmpdir(), `kason-media-in-${stamp}.bin`);
  const outPath = join(tmpdir(), `kason-media-out-${stamp}.mp4`);
  writeFileSync(inPath, buf);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .outputOptions([
          "-vf", "scale=-2:720",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "26",
          "-c:a", "aac",
          "-b:a", "128k",
        ])
        .save(outPath)
        .on("end", () => resolve())
        .on("error", (err) => reject(err));
    });
    await putObject(key, readFileSync(outPath), "video/mp4");
  } finally {
    try { unlinkSync(inPath); } catch { /* best-effort */ }
    try { unlinkSync(outPath); } catch { /* best-effort */ }
  }
}

export function isVideoKey(key: string): boolean {
  return /\.(mp4|mov|webm)$/i.test(key);
}
