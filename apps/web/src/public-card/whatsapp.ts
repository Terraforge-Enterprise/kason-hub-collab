// WhatsApp deep-link builder.
//
// Per spec §9.10, the displayName is included in the prefilled chat text
// ONLY when it passes a tight whitelist (Unicode letters, digits, spaces,
// hyphens, apostrophes, dots). This guards against XSS-equivalent content
// being routed through wa.me into a chat preview. Names that fail the
// whitelist fall back to a name-less greeting that contains only the URL.
//
// Phone preference (per spec §6.3): use the live Party.whatsappPhone if
// present (canonical 60XXXXXXXXX, set in agent profile); otherwise fall back
// to the snapshot's primaryPhone. We pass the chosen value through
// `readPhoneAnyFormat` from `@kason/shared` so legacy `+60...` data and
// local-format `0XX-...` strings both canonicalize to `60XXXXXXXXX` before
// composing the wa.me URL. If both are null or unparseable the function
// returns null and the caller hides the WhatsApp button.

import { readPhoneAnyFormat } from "@kason/shared";

const NAME_WHITELIST = /^[\p{L}\p{N} '\-.]+$/u;

export function buildWhatsAppLink(
  displayName: string | null,
  whatsappPhone: string | null,
  primaryPhone: string | null,
  publicUrl: string,
): string | null {
  const stored = whatsappPhone ?? primaryPhone;
  const cleanPhone = readPhoneAnyFormat(stored);
  if (!cleanPhone) return null;

  let textParam = "";
  if (displayName && NAME_WHITELIST.test(displayName)) {
    const greeting = `Hi ${displayName}, I saw your e-namecard at ${publicUrl}`;
    textParam = `?text=${encodeURIComponent(greeting)}`;
  } else if (publicUrl) {
    textParam = `?text=${encodeURIComponent(
      `Hi, I saw your e-namecard at ${publicUrl}`,
    )}`;
  }

  return `https://wa.me/${cleanPhone}${textParam}`;
}
