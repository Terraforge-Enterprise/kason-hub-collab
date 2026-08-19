/**
 * Device-aware bulk media download.
 *
 * Mobile (iOS Safari / modern Android Chrome) with Web Share file support:
 *   fetches every URL as a `File` and invokes `navigator.share({ files })` so
 *   the native share sheet can save straight to Photos / Drive in one tap.
 *   When the browser refuses the bulk file set (canShare returns false or
 *   share() throws a non-cancel error), falls through to the blob path below.
 *
 * Desktop / mobile fallback:
 *   fetches each URL as a Blob and downloads via a same-origin `blob:` URL.
 *   Cross-origin `<a download>` is unreliable — the `download` attribute is
 *   ignored unless the response carries `Content-Disposition: attachment`,
 *   and Chrome blocks subsequent downloads in a multi-click chain. Routing
 *   through Blob URLs makes every file a same-origin download the browser
 *   respects, with a 600 ms gap so Chrome's "allow multiple downloads"
 *   prompt has time to register without dropping files.
 */
export async function downloadAllMedia(urls: string[], filenamePrefix = "unit"): Promise<void> {
  if (urls.length === 0) return;

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const shareApi = (navigator as unknown as {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  });
  const hasShare = isMobile && typeof shareApi.canShare === "function" && typeof shareApi.share === "function";

  // Pre-fetch every blob in parallel. We need File objects either way: bulk
  // Web Share takes them directly, and the blob fallback uses `URL.createObjectURL`
  // to mint same-origin download URLs.
  const files = await Promise.all(
    urls.map(async (url, i) => {
      const r = await fetch(url);
      const blob = await r.blob();
      // Strip subtype suffixes like "image/svg+xml" → "svg".
      const ext = (blob.type.split("/")[1] ?? "bin").replace(/\+.*/, "");
      return new File([blob], `${filenamePrefix}-${i + 1}.${ext}`, { type: blob.type });
    }),
  );

  // Mobile happy path: one share sheet with every file attached. The user picks
  // a destination once (Photos, Drive, AirDrop, etc.) and all files are saved.
  if (hasShare && shareApi.canShare!({ files })) {
    try {
      await shareApi.share!({ files, title: "Listing media" });
      return;
    } catch (err) {
      // User cancelled — respect that, don't trigger anything else.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Other failure (e.g. some Android builds reject large sets after canShare
      // returned true) → fall through to blob downloads.
    }
  }

  // Fallback: download each file via a same-origin blob URL. Throttle to 600 ms
  // between clicks so Chrome's "allow multiple automatic downloads" prompt
  // registers and so each download has time to start before the next click.
  for (const [i, file] of files.entries()) {
    const objectUrl = URL.createObjectURL(file);
    try {
      downloadOne(objectUrl, file.name);
    } finally {
      // Release after a tick so the browser has started the download. Revoking
      // synchronously can race with the click and cancel the download.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
    if (i < files.length - 1) await sleep(600);
  }
}

/**
 * Trigger a browser download of an ALREADY-FETCHED Blob via a same-origin `blob:`
 * URL — the reliable path for cross-origin / streamed responses (see the rationale
 * on downloadAllMedia: a bare `<a download>` on a cross-origin URL ignores the
 * filename unless the server sets Content-Disposition). Used by the owner-billing
 * proof-pack downloads (admin + portal), which fetch the PDF with an auth token.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  try {
    downloadOne(objectUrl, filename);
  } finally {
    // Release after a tick so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

function downloadOne(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
