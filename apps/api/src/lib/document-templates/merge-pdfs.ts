import { PDFDocument } from "pdf-lib";

export async function mergePdfs(
  basePdf: Buffer,
  appendPdfs: Buffer[],
): Promise<Buffer> {
  if (appendPdfs.length === 0) return basePdf;
  // The BASE is our own htmlToPdf output — if THAT fails to load it's a real
  // internal error, so it stays un-guarded.
  const doc = await PDFDocument.load(basePdf);
  for (const extra of appendPdfs) {
    // Skip empty / zero-byte append buffers outright.
    if (!extra || extra.length === 0) continue;
    try {
      // ignoreEncryption: owner/permission-encrypted bills (banks, utilities
      // commonly encrypt) still merge instead of throwing.
      const appendDoc = await PDFDocument.load(extra, { ignoreEncryption: true });
      const copiedPages = await doc.copyPages(appendDoc, appendDoc.getPageIndices());
      for (const page of copiedPages) doc.addPage(page);
    } catch {
      // A corrupt / truncated / unreadable appended bill must NEVER abort the
      // whole owner statement (the money document). Skip this one, keep the
      // base + the others.
      continue;
    }
  }
  const merged = await doc.save();
  return Buffer.from(merged);
}
