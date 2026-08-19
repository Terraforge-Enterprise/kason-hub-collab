import { z } from "zod";
import { normalizeMyPhone } from "../utils/phone";

/**
 * Zod schema for a required Malaysian mobile phone.
 * Accepts any reasonable input; transforms to canonical "60XXXXXXXXX".
 *
 * IMPORTANT: route handlers must serialize errors via `.flatten()` (or strip
 * `issue.input` manually) — Zod 4 attaches the raw input to issues, which
 * leaks PII if echoed back to clients.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((input, ctx) => {
    const canonical = normalizeMyPhone(input);
    if (!canonical) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid Malaysian mobile number",
      });
      return z.NEVER;
    }
    return canonical;
  });

/**
 * Optional-or-empty variant. Empty string / null / undefined → null.
 *
 * Preprocess collapses empty/null/undefined → `null` BEFORE the inner schema
 * runs, then delegates to `phoneSchema.nullable()` so non-empty invalid input
 * (e.g. `"xyz"`) surfaces the canonical "Enter a valid Malaysian mobile
 * number" error instead of Zod's generic union-fallthrough message.
 */
export const optionalPhoneSchema = z.preprocess(
  (v) => (v === "" || v === undefined ? null : v),
  phoneSchema.nullable(),
);
