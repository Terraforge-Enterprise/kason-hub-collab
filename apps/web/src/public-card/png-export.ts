// PNG snapshot export for the public e-namecard via html2canvas.
//
// html2canvas options chosen:
//   - backgroundColor: "#000" — matches the dark card chrome so any
//     letterboxing reads as part of the design.
//   - scale: 2 — 2x for retina sharpness when shared on Hi-DPI displays
//     (WhatsApp will recompress, but starting at 2x preserves the QR contrast
//     post-recompression).
//   - useCORS: true / allowTaint: false — listing photos served from
//     Supabase Storage send permissive CORS headers; tainting the canvas
//     would silently break toBlob(). Failing loud here is correct.
//   - logging: false — quiet console in production.
//
// Failure UX (handled by the caller in PublicCardPage): an alert() with
// "Download failed — please share the link directly." This is intentionally
// boring; the page already exposes the URL to share, so PNG is best-effort.
//
// Pre-snapshot: wait for document.fonts.ready so Plus Jakarta Sans is loaded
// before the rasterization. Without this, the first export of a session can
// render a system fallback font.
//
// Post-snapshot: validate that the canvas isn't a fully-zero image (a known
// html2canvas failure mode when CORS taints or a fonts-not-ready race
// strikes). We sample the top-left 10x10 pixel block and reject if every
// non-alpha byte is zero.
//
// Bundle-size note: html2canvas is ~150KB raw / ~50KB gzipped. We dynamic-import
// it inside exportCardAsPng so the initial page load doesn't pay the cost —
// only visitors who actually click "Download PNG" pull it in. This drops the
// public-card initial bundle from ~96KB gzip to ~46KB gzip.

export async function exportCardAsPng(
  cardElement: HTMLElement,
  filename: string,
): Promise<void> {
  // Dynamic import keeps html2canvas out of the entry chunk.
  const { default: html2canvas } = await import("html2canvas");

  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  const canvas = await html2canvas(cardElement, {
    backgroundColor: "#000",
    scale: 2,
    useCORS: true,
    allowTaint: false,
    logging: false,
  });

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("html2canvas produced no 2D context");
  const sampleW = Math.min(10, canvas.width);
  const sampleH = Math.min(10, canvas.height);
  if (sampleW > 0 && sampleH > 0) {
    const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
    const allZero = Array.from(data).every((b, i) => i % 4 === 3 || b === 0);
    if (allZero) throw new Error("html2canvas produced a blank canvas");
  }

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
