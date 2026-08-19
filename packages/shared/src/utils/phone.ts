import { parsePhoneNumberFromString } from "libphonenumber-js/min";

/**
 * Valid Malaysian mobile prefixes after the `60` country code.
 *
 * These map to the leading-0 national prefixes 010-019. Lengths after the
 * `60` country code:
 *   - 010/012/013/014/016/017/018/019 → 9 digits (60 + 7 subscriber)
 *   - 011/015 → 10 digits (60 + 8 subscriber)
 *
 * Source: docs/superpowers/specs/2026-05-10-phone-format-standardization-design.md
 */
const MY_MOBILE_PREFIX_RE = /^60(1[0-9])\d{7,8}$/;

/**
 * Check whether a `60`-prefixed digit string matches an MY mobile pattern.
 * `/min` libphonenumber-js metadata cannot distinguish mobile vs fixed-line
 * (that would require `/max`, which loses some valid mobile prefixes), so
 * we layer this explicit MY check on top of `isValid()`.
 */
function looksLikeMyMobile(canonical: string): boolean {
  if (!MY_MOBILE_PREFIX_RE.test(canonical)) return false;
  const subscriberPrefix = canonical.slice(2, 4); // "10", "11", ..., "19"
  const subscriberLen = canonical.length - 2;
  // 011 and 015 carriers issue 8-digit subscriber numbers; the rest issue 7.
  if (subscriberPrefix === "11" || subscriberPrefix === "15") {
    return subscriberLen === 10;
  }
  return subscriberLen === 9;
}

/**
 * Normalize any input to canonical Malaysian phone format: "60XXXXXXXXX".
 *
 * - Strips separators (spaces, dashes, parens, leading +).
 * - Handles national format (with or without leading 0) and international.
 * - Validates via libphonenumber-js with `MY` as default country.
 * - Rejects non-mobile numbers (landlines, etc.) via an explicit prefix check.
 *
 * Returns null if the input cannot be parsed as a valid Malaysian mobile.
 */
export function normalizeMyPhone(input: string | null | undefined): string | null {
  if (!input) return null;

  let digits = input.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("60")) {
    // already has country code
  } else if (digits.startsWith("0")) {
    digits = "60" + digits.slice(1);
  } else {
    digits = "60" + digits;
  }

  const parsed = parsePhoneNumberFromString("+" + digits, "MY");
  if (!parsed || !parsed.isValid()) return null;
  if (parsed.country !== "MY") return null;

  const canonical = parsed.number.startsWith("+")
    ? parsed.number.slice(1)
    : parsed.number;

  if (!looksLikeMyMobile(canonical)) return null;

  return canonical;
}

/**
 * Strict canonical-format validity check. Input MUST already be in canonical
 * form (`60XXXXXXXXX`, no `+`, no separators).
 */
export function isValidMyPhone(canonical: string): boolean {
  if (!canonical) return false;
  if (!/^60\d{9,10}$/.test(canonical)) return false;
  const parsed = parsePhoneNumberFromString("+" + canonical, "MY");
  if (!parsed || !parsed.isValid()) return false;
  if (parsed.country !== "MY") return false;
  return looksLikeMyMobile(canonical);
}

/**
 * Format a canonical phone for display: "+60 12-345 6789".
 *
 * Built on `formatNational()` (`"012-345 6789"`) — strip the leading `0`,
 * prepend `+60 ` to produce the spec'd display string. We don't use
 * `formatInternational()` directly because it spaces the trunk prefix
 * (`"+60 12 345 6789"`) instead of using a dash like the local convention.
 *
 * Returns the input unchanged if not parseable, so callers can render
 * legacy/unrecognized values without crashing.
 */
export function formatMyPhoneDisplay(canonical: string): string {
  if (!canonical) return canonical;
  const parsed = parsePhoneNumberFromString("+" + canonical, "MY");
  // Treat parseable-but-invalid inputs (e.g. "60123" — too short) the same
  // as unparseable: return unchanged so the caller can render the legacy
  // value verbatim, matching the JSDoc contract.
  if (!parsed || !parsed.isValid()) return canonical;
  // Group the national digits ourselves rather than trusting
  // parsed.formatNational(): libphonenumber groups the 11-digit 011/015 range
  // as "0152-345 6789" (dash after 4 chars), so stripping the leading "0"
  // would misplace the dash — "152-345 6789" instead of "15-2345 6789". The
  // Malaysian convention is a 2-digit prefix, then the subscriber number:
  //   - 010/012–019 → 7 subscriber digits → "1X-XXX XXXX"  (2-3-4)
  //   - 011/015     → 8 subscriber digits → "1X-XXXX XXXX" (2-4-4)
  const m = /^60(1[0-9])(\d{7,8})$/.exec(canonical);
  if (m) {
    const [, prefix, sub] = m;
    const body =
      sub.length === 8
        ? `${sub.slice(0, 4)} ${sub.slice(4)}`
        : `${sub.slice(0, 3)} ${sub.slice(3)}`;
    return `+60 ${prefix}-${body}`;
  }
  // Fallback for any parseable-valid-but-non-mobile input (shouldn't normally
  // reach here): preserve the prior formatNational-based behaviour.
  const national = parsed.formatNational(); // e.g. "012-345 6789"
  if (!national.startsWith("0")) return parsed.formatInternational();
  return "+60 " + national.slice(1);
}

/**
 * Tolerant reader for legacy DB values that may still be stored with a `+`,
 * separators, or other pre-spec formats. Returns canonical or null.
 */
export function readPhoneAnyFormat(stored: string | null | undefined): string | null {
  return normalizeMyPhone(stored);
}
