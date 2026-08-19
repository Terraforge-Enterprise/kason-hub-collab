/**
 * Date-formatting helpers used by the portal-my-card surface.
 *
 * The codebase has `formatDate` / `formatDateTime` in
 * `@/components/format` but they're slice-based ISO presentations — not
 * great for "submitted 3 hours ago" or "approved on May 5, 2026". These
 * helpers fill that gap without adding date-fns to the bundle (it isn't
 * a project dep).
 */

/**
 * Renders a friendly relative-time string. e.g. "3 hours ago",
 * "yesterday", "2 weeks ago". Uses Intl.RelativeTimeFormat which is
 * available in every modern browser.
 */
export function formatDistanceFromNow(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffSeconds = Math.round(diffMs / 1000);

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  // Tiered: minutes < 60, hours < 24, days < 30, months < 12, else years.
  if (Math.abs(diffSeconds) < 60) return rtf.format(-diffSeconds, "second");
  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) return rtf.format(-diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return rtf.format(-diffHours, "hour");
  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) return rtf.format(-diffDays, "day");
  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) return rtf.format(-diffMonths, "month");
  const diffYears = Math.round(diffMonths / 12);
  return rtf.format(-diffYears, "year");
}

/**
 * Renders a long-form date — "May 5, 2026". Used for "Approved on" stat
 * tile where a relative-time string would be too noisy.
 */
export function formatLongDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  return new Date(isoDate).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
