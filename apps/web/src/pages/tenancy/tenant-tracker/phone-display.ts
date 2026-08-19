import { formatMyPhoneDisplay, readPhoneAnyFormat } from "@kason/shared";

/**
 * Render-safe phone display (v2 spec §4.1): canonical and legacy "+60…" rows
 * both render as "+60 13-345 6780"; unparseable values render verbatim.
 */
export function displayPhone(raw: string): string {
  const canonical = readPhoneAnyFormat(raw);
  return canonical ? formatMyPhoneDisplay(canonical) : raw;
}
