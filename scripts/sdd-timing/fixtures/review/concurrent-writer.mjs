// A standalone worker that publishes one ReviewResult, for real multi-process race tests.
// argv: <dir> <variant> <spanId>. variant "same" => identical content across workers (should
// resolve idempotently); a numeric variant => distinct content (should conflict).
import { buildReviewResult, writeReviewResult } from "../../lib/review-result.mjs";
const [dir, variant, spanId] = process.argv.slice(2);
const findings = variant === "same"
  ? [{ findingId: "F1", severity: "high", category: "money" }]
  : [{ findingId: "F" + variant, severity: "low", category: "style", summary: "variant " + variant }];
const art = buildReviewResult(
  { runId: "run", taskId: "task", reviewSpanId: spanId, reviewerRole: "adversarial", outcome: "changes-requested", findings },
  { now: variant === "same" ? 1 : Number(variant) }
);
const res = writeReviewResult(dir, art);
process.stdout.write(JSON.stringify({ variant, ok: res.ok, idempotent: !!res.idempotent, reason: res.reason || null }));
