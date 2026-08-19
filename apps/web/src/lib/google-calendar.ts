/** Google Calendar link-out (NO API/OAuth — user-confirmed). Day-level event from dueOn. */
export function buildGoogleCalendarUrl(opts: { title: string; dueOn: string; details?: string }): string {
  const d = new Date(opts.dueOn);
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  const dayEnd = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: opts.title,
    dates: `${day}/${dayEnd}`,
    ...(opts.details ? { details: opts.details } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
