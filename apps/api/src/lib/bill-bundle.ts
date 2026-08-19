// apps/api/src/lib/bill-bundle.ts
//
// Turn a list of stored bills (PDFs and photos) into ONE PDF of their pages.
//
// Extracted from proof-pack.service so the owner proof pack and the billing-document
// PDF share it. Both take a set of supporting bills and have to render them into a
// document a human receives; duplicating the merge would mean duplicating every
// resilience rule below, and the two copies would drift the first time one is fixed.
//
// Two binding properties, unchanged from the proof pack:
//   1. MISS-RESILIENT — a bill whose bytes are gone (`fetchStorageBuffer` → null) is
//      SKIPPED, never thrown; an unreadable PDF / unsupported image likewise degrades.
//      A pathological set never aborts the whole download.
//   2. BOUNDED — capped at 50 bills / 100 MB total (log + skip beyond) so a runaway
//      upload count can't OOM the API.
import { PDFDocument } from "pdf-lib";
import { mergePdfs } from "./document-templates/merge-pdfs";
import { fetchStorageBuffer } from "./storage";

/** Hard bounds — a runaway upload count must never OOM the API. */
export const MAX_BILLS = 50;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB

/** The minimum a bill must expose to be bundled. */
export interface BundleableBill {
  storageKey: string;
}

/** PNG magic bytes (\x89 P N G). */
function isPng(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/** JPEG magic bytes (\xFF \xD8 \xFF). */
function isJpg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * Merge `bills` into a single PDF, one or more pages per bill. Returns null when
 * nothing usable survived (no bills, or every bill's bytes were missing/unreadable)
 * so callers can map that to "append nothing" / 404 as they see fit.
 *
 * `logLabel` prefixes the degrade warnings so a skipped bill is traceable back to the
 * caller that asked for it.
 */
export async function buildBillBundlePdf(
  bills: readonly BundleableBill[],
  logLabel: string,
): Promise<Uint8Array | null> {
  const warn = (msg: string) => {
    // eslint-disable-next-line no-console
    console.warn(`[bill-bundle] ${logLabel}: ${msg}`);
  };

  if (bills.length === 0) return null;

  // Image bills accumulate (each on its own fresh page) in this OWN document; PDF
  // bills accumulate as raw buffers for the guarded merge. Both halves are bounded.
  const imageDoc = await PDFDocument.create();
  let imagePages = 0;
  const pdfBuffers: Buffer[] = [];
  let totalBytes = 0;
  let processed = 0;

  for (const bill of bills) {
    if (processed >= MAX_BILLS) {
      warn(`>${MAX_BILLS} bills; skipping the rest`);
      break;
    }
    const buf = await fetchStorageBuffer(bill.storageKey);
    if (!buf) {
      // MISS-RESILIENT: a bill whose bytes are gone is dropped, not thrown.
      warn(`missing bytes for ${bill.storageKey}; skipping`);
      continue;
    }
    if (totalBytes + buf.length > MAX_TOTAL_BYTES) {
      warn(`total size would exceed ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB; skipping ${bill.storageKey}`);
      continue;
    }

    if (isPng(buf) || isJpg(buf)) {
      try {
        const img = isPng(buf) ? await imageDoc.embedPng(buf) : await imageDoc.embedJpg(buf);
        const page = imageDoc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        imagePages++;
        totalBytes += buf.length;
        processed++;
      } catch {
        // A corrupt image must degrade, not abort the whole bundle.
        warn(`failed to embed image ${bill.storageKey}; skipping`);
      }
      continue;
    }

    // Everything else (a PDF bill, or an unsupported type like webp) goes through the
    // guarded PDF-merge path below: a real PDF merges; a non-PDF simply fails the
    // guarded load and is skipped — it never throws.
    pdfBuffers.push(buf);
    totalBytes += buf.length;
    processed++;
  }

  if (imagePages === 0 && pdfBuffers.length === 0) return null;

  if (imagePages > 0) {
    // The image doc is OUR OWN, always-loadable base, so `mergePdfs` (which loads its
    // base UN-guarded but each append guarded) safely appends the bill PDFs onto it.
    const base = Buffer.from(await imageDoc.save());
    const merged = await mergePdfs(base, pdfBuffers);
    return new Uint8Array(merged);
  }

  // PDF-only bundle. We do NOT route this through `mergePdfs` with an empty base:
  // pdf-lib materializes a phantom blank page when an EMPTY document is saved and
  // reloaded as a merge base. Instead we merge the bills into one accumulator with
  // the SAME guarded copyPages logic mergePdfs uses — which additionally extends the
  // corrupt/encrypted-bill resilience to the FIRST bill (mergePdfs leaves its base
  // un-guarded). A bill that fails to load is skipped.
  const out = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    try {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const copied = await out.copyPages(src, src.getPageIndices());
      for (const page of copied) out.addPage(page);
    } catch {
      warn("failed to merge PDF bill; skipping");
    }
  }
  if (out.getPageCount() === 0) return null;
  return new Uint8Array(await out.save());
}
