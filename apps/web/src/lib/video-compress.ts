/**
 * Client-side video compression via ffmpeg.wasm.
 *
 * Trigger threshold: only compress when the source file exceeds the cap
 * the caller passes in (typically 250 MB — well below the 500 MB upload
 * cap so the transcoded output has slack). The wasm bundle is roughly
 * 30 MB and this module does NOT eagerly load it. The dynamic import in
 * compressVideoIfOversize triggers the bundle download lazily, only on
 * the first compression.
 *
 * UX contract:
 *   - The caller owns the modal that asks the user "Compress / Upload
 *     as-is / Cancel" — this module ONLY does the transcode.
 *   - On transcode failure (codec unsupported, OOM, user cancel) we
 *     return `{ skipped, reason }`. The caller MUST surface a toast and
 *     let the user pick another file. NEVER auto-fall-back to
 *     upload-original — the user explicitly chose to compress.
 *
 * Output target: H.264 / AAC MP4 at ~6 Mbps video. A 1080p walkthrough
 * at this bitrate runs ~75 MB/min — comfortably under the 500 MB cap
 * for typical agent uploads (≤ 6 min).
 */

export type CompressResult =
  | { output: File; compressed: boolean }
  | { skipped: true; reason: string };

export async function compressVideoIfOversize(
  file: File,
  capBytes: number,
  onProgress?: (frac: number) => void,
): Promise<CompressResult> {
  if (file.size <= capBytes) {
    return { output: file, compressed: false };
  }

  // Dynamic imports keep the wasm bundle out of the main chunk. The
  // browser only fetches it when the user actually triggers a
  // compression — first-trigger latency is the trade-off, but it's a
  // far better default than adding ~30 MB to every page load.
  let ffmpegMod: typeof import("@ffmpeg/ffmpeg");
  let utilMod: typeof import("@ffmpeg/util");
  try {
    [ffmpegMod, utilMod] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      import("@ffmpeg/util"),
    ]);
  } catch (err) {
    return {
      skipped: true,
      reason:
        err instanceof Error
          ? `Compression library failed to load: ${err.message}`
          : "Compression library failed to load.",
    };
  }

  const ffmpeg = new ffmpegMod.FFmpeg();
  if (onProgress) {
    ffmpeg.on("progress", ({ progress }) => {
      // ffmpeg's progress is 0..1; normalise & clamp.
      onProgress(Math.max(0, Math.min(1, progress)));
    });
  }

  try {
    await ffmpeg.load();
  } catch (err) {
    return {
      skipped: true,
      reason:
        err instanceof Error
          ? `ffmpeg.load failed: ${err.message}`
          : "ffmpeg.load failed.",
    };
  }

  const inputName = "in." + (extOf(file.name) ?? "mp4");
  const outputName = "out.mp4";

  try {
    await ffmpeg.writeFile(inputName, await utilMod.fetchFile(file));
  } catch (err) {
    return {
      skipped: true,
      reason: `Failed to stage source file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // -c:v libx264 → H.264 video; -b:v 6M → ~6 Mbps;
  // -preset veryfast → balance speed vs compression ratio for browsers;
  // -movflags +faststart → put the moov atom first for streaming;
  // -c:a aac -b:a 128k → standard AAC audio.
  const args = [
    "-i",
    inputName,
    "-c:v",
    "libx264",
    "-b:v",
    "6M",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outputName,
  ];

  try {
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      return { skipped: true, reason: `ffmpeg exited with code ${code}` };
    }
  } catch (err) {
    return {
      skipped: true,
      reason: `Transcode failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let outBytes: Uint8Array;
  try {
    const data = await ffmpeg.readFile(outputName);
    if (typeof data === "string") {
      return { skipped: true, reason: "ffmpeg returned text instead of bytes" };
    }
    outBytes = data as Uint8Array;
  } catch (err) {
    return {
      skipped: true,
      reason: `Failed to read transcode output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Belt-and-braces sanity check: if compression didn't actually shrink
  // the file under the cap, treat as skipped so the caller can decide.
  if (outBytes.byteLength > capBytes) {
    return {
      skipped: true,
      reason: `Compressed output (${outBytes.byteLength} bytes) still exceeds cap (${capBytes} bytes).`,
    };
  }

  // Copy into a plain ArrayBuffer to satisfy Blob's BlobPart type. The
  // ffmpeg.wasm output is a Uint8Array backed by a SharedArrayBuffer in
  // some runtimes; Blob refuses SharedArrayBuffer-backed views.
  const ab = new ArrayBuffer(outBytes.byteLength);
  new Uint8Array(ab).set(outBytes);
  const blob = new Blob([ab], { type: "video/mp4" });
  const outName = replaceExt(file.name, "mp4");
  const output = new File([blob], outName, { type: "video/mp4" });
  return { output, compressed: true };
}

function extOf(name: string): string | undefined {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return undefined;
  return name.slice(idx + 1).toLowerCase();
}

function replaceExt(name: string, newExt: string): string {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return `${name}.${newExt}`;
  return `${name.slice(0, idx)}.${newExt}`;
}
