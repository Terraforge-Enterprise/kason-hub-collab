export function formatDate(value?: string | null) {
  if (!value) return "-";
  return value.slice(0, 10);
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return value.slice(0, 16).replace("T", " ");
}

// Malaysia-time formatter (Asia/Kuala_Lumpur, UTC+8). Mirrors the reservation
// pages' Intl pattern. Used where wall-clock MY time matters (audit log,
// task assigned-date) rather than the raw-UTC `formatDateTime` slice.
const MY_DATE_TIME = new Intl.DateTimeFormat("en-MY", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kuala_Lumpur",
});

export function formatDateTimeMY(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : MY_DATE_TIME.format(d);
}

const MY_DATE = new Intl.DateTimeFormat("en-MY", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kuala_Lumpur",
});

/** Tenant-facing pretty date: "1 Jul 2026". Non-parseable / empty → "-". */
export function formatDateMY(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : MY_DATE.format(d);
}

export function formatNumber(value: number | null | undefined) {
  if (value == null) return "0";
  return value.toLocaleString("en-MY");
}

export function formatRM(value: number | null | undefined) {
  if (value == null) return "RM 0.00";
  return `RM ${value.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Integer cents (API `*C` fields) → RM display. Shares formatRM's
 * rounding/locale. Guards non-finite input (missing/malformed API field
 * arriving as `undefined`/`NaN`) the same way formatRM guards `null` —
 * without this, `undefined / 100` is `NaN` and `formatRM`'s `== null` check
 * does not catch it, so a bad field would otherwise render "RM NaN".
 */
export function formatCents(c: number): string {
  if (!Number.isFinite(c)) return "RM 0.00";
  return formatRM(c / 100);
}

/** Whole-ringgit variant for rent columns (tenant tracker v2 spec §4.3). */
export function formatRM0(value: number | null | undefined) {
  if (value == null) return "RM 0";
  return `RM ${value.toLocaleString("en-MY", { maximumFractionDigits: 0 })}`;
}

export function formatMoney(value: number | null | undefined, currency = "MYR") {
  if (value == null) return `0 ${currency}`;
  return `${value.toLocaleString("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

// Onblur normalizer for "person name" inputs. Splits on any whitespace and
// uppercases the first letter of each token while lowercasing the rest, so
// shouty caps-lock paste-jobs and lower-case typing both normalize to the
// way names appear on Malaysian NRIC/passports. Empty/whitespace-only input
// returns "" so caller can decide whether to leave the field empty or fall
// back to the prior value.
export function toTitleCase(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\s+/)
    .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1).toLowerCase())
    .join(" ");
}

export function getStatusTone(status?: string | null) {
  const value = status?.toLowerCase();

  if (!value) return "slate" as const;
  if (["active", "posted", "published", "occupied", "sent", "read", "success", "paid"].includes(value)) return "emerald" as const;
  // "needs_reconciliation" is amber, not rose: the bank confirmed this payment,
  // so it is an unresolved item awaiting a decision — never a failure.
  if (["pending", "pending_approval", "needs_reconciliation", "partial", "partially_paid", "submitted", "draft", "paused", "reserved", "queued", "processing", "amended"].includes(value)) return "amber" as const;
  if (["terminated", "void", "voided", "credited", "refunded", "blacklisted", "failed", "archived", "rejected"].includes(value)) return "rose" as const;
  if (["open", "vacant", "maintenance", "unread", "approved", "on_statement"].includes(value)) return "sky" as const;

  return "slate" as const;
}

/**
 * Enum value → human label: "letting_commission" → "Letting Commission".
 *
 * The last-resort prettifier for a raw backend enum that has no curated label. Prefer
 * a real label map where one exists (e.g. invoiceTypeMeta for invoiceType) — this is
 * for the long tail like chargeType, where a hand-written map would rot as new types
 * are added server-side.
 */
export function prettyEnumLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * A billing period → "Aug 2026". Accepts either "YYYY-MM" or the full ISO timestamp the
 * API sends for periodMonth ("2026-08-01T00:00:00.000Z"), which was previously rendered
 * raw in the invoice drawer. Read in UTC: the period is a calendar month key, so a local
 * read would show the previous month for anyone east of UTC.
 */
export function formatPeriodMonth(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(/^\d{4}-\d{2}$/.test(value) ? `${value}-01T00:00:00.000Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-MY", { month: "short", year: "numeric", timeZone: "UTC" });
}
