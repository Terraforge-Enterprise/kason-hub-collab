// vCard 3.0 builder + downloader for the public e-namecard.
//
// All output sanitization lives here per spec §9.10:
//   1. Strip CR/LF and control chars (0x00–0x1F) — prevents header/line
//      injection (e.g. attacker-controlled "displayName" containing CRLF
//      could synthesize a fake EMAIL/TEL line).
//   2. Strip Unicode bidi-override controls — prevents visually deceptive
//      contact data when the .vcf is opened in a text editor.
//   3. Reject leading formula chars (=, +, -, @) on textual fields — defends
//      against spreadsheet-import CSV-injection if the .vcf data is ever
//      pasted into Excel/Sheets.
//
// CRLF line endings on the output are mandated by RFC 6350.
//
// Phone normalization (per spec §6.3): the snapshot's `primaryPhone` is read
// through `readPhoneAnyFormat` from `@kason/shared` so legacy `+60...` and
// local-format `0XX-...` stored values canonicalize to `60XXXXXXXXX` before
// being emitted into the TEL line. If the value is null or unparseable the
// TEL line is omitted entirely. Chunk C wrote canonical values to all new
// snapshots, but pre-Chunk-C snapshots may still hold legacy formats.

import { readPhoneAnyFormat } from "@kason/shared";

import type { PublicCardDto } from "./types";

interface SanitizeOptions {
  rejectLeadingFormula?: boolean;
}

function sanitizeField(
  value: string | null | undefined,
  opts: SanitizeOptions = {},
): string {
  if (!value) return "";
  let s = value
    // Strip CR, LF, and other C0 control chars (0x00–0x1F).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]/g, "")
    // Strip Unicode bidi-override controls:
    //   U+202D LRO, U+202E RLO, U+2066 LRI, U+2067 RLI, U+2068 FSI,
    //   U+2069 PDI, U+200E LRM, U+200F RLM.
    .replace(/[‭‮⁦⁧⁨⁩‎‏]/g, "");
  if (opts.rejectLeadingFormula) {
    s = s.replace(/^[=+\-@]+/, "");
  }
  return s;
}

export function buildVCard(card: PublicCardDto): string {
  const fn = sanitizeField(card.displayName, { rejectLeadingFormula: true });
  const title = sanitizeField(card.title, { rejectLeadingFormula: true });
  // Canonicalize phone first (handles legacy `+60...` / `012-...`), THEN
  // sanitize. The canonical form `60XXXXXXXXX` is digits-only so the
  // sanitize pass is a no-op safety net rather than the primary defense.
  const tel = sanitizeField(readPhoneAnyFormat(card.primaryPhone));
  const email = sanitizeField(card.primaryEmail);
  const org = sanitizeField(card.org.agencyName, {
    rejectLeadingFormula: true,
  });
  const addr = card.org.address
    .map((l) => sanitizeField(l))
    .filter(Boolean)
    .join(", ");

  const lines: (string | false)[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    fn ? `FN:${fn}` : false,
    title ? `TITLE:${title}` : false,
    tel ? `TEL;TYPE=cell:${tel}` : false,
    email ? `EMAIL:${email}` : false,
    org ? `ORG:${org}` : false,
    addr ? `ADR:;;${addr};;;;` : false,
    "END:VCARD",
  ];

  return lines.filter((l): l is string => typeof l === "string").join("\r\n");
}

export function downloadVCard(card: PublicCardDto): void {
  const vcard = buildVCard(card);
  const blob = new Blob([vcard], { type: "text/vcard;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${
    sanitizeField(card.displayName).replace(/\s+/g, "-").toLowerCase() ||
    "contact"
  }.vcf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
