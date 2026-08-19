import { z } from "zod";

// The organisation name is the headline string on every issued document
// (letterhead, reservation PDF, e-namecard). Allow 2-120 chars — wider
// than a single word, narrower than free-form pasted prose. Trim is
// applied client-side; the server validates the trimmed value.
export const updateOrganizationProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Organisation name must be at least 2 characters.")
    .max(120, "Organisation name must be 120 characters or fewer."),
  // ── Owner-statement auto-send schedule ──────────────────────────────────────
  // WHEN the just-ended month's frozen statements are released to owners, read by
  // the send cron in the ORG'S OWN timezone. Optional so an existing name-only
  // PATCH keeps working unchanged.
  //
  // Bounds MIRROR the DB CHECK constraints (migration
  // 20260801000000_owner_statement_send_schedule) — if you widen one, widen both,
  // or a valid-looking payload 500s on a constraint violation.
  //
  // The day cap of 28 is deliberate, not arbitrary: February has no 29th in common
  // years, so a send day of 29-31 would make the statement silently never go out in
  // those months — a missing-money-document bug that reports as "nothing happened".
  ownerStatementSendDay: z
    .number()
    .int("Send day must be a whole number.")
    .min(1, "Send day must be between 1 and 28.")
    .max(28, "Send day must be between 1 and 28 (so every month has one — February has no 29th).")
    .optional(),
  ownerStatementSendHour: z
    .number()
    .int("Send hour must be a whole number.")
    .min(0, "Send hour must be between 0 and 23.")
    .max(23, "Send hour must be between 0 and 23.")
    .optional(),
});
