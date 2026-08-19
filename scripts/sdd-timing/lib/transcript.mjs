// Observational SDD timing — transcript + meta parser.
// Spec: docs/superpowers/specs/2026-07-19-sdd-timing-instrumentation.md §0/§1/§4.
// Reads the REAL agent transcript shape (verified 2026-07-19):
//   line = { type: "user"|"assistant"|"attachment", timestamp: ISO, message?, ... }
//   assistant message.usage = { input_tokens, output_tokens,
//                               cache_read_input_tokens, cache_creation_input_tokens }
//   tool_use  block (assistant content) = { type:"tool_use", id, name }
//   tool_result block (user content)    = { type:"tool_result", tool_use_id }
// Pure functions; no side effects on the SDD workflow.

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

export function isoToEpochMs(ts) {
  if (typeof ts !== "string") return null;
  const v = Date.parse(ts);
  return Number.isNaN(v) ? null : v;
}

function parseLines(jsonlText) {
  const objs = [];
  let malformedLines = 0;
  for (const raw of String(jsonlText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try { objs.push(JSON.parse(line)); } catch { malformedLines++; }
  }
  return { objs, malformedLines };
}

function unionLengthMs(intervals) {
  if (!intervals.length) return 0;
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = s[0];
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i];
    if (a <= ce) ce = Math.max(ce, b);
    else { total += ce - cs; cs = a; ce = b; }
  }
  return total + (ce - cs);
}

const R = (stage, agentRole, taskId, confidence, src) => ({
  stage, agentRole, taskId, confidence, note: `inferred from ${src}`,
});

/**
 * Conservative stage/task inference (§5). Exact patterns → inferred + confidence
 * + explanation; unmatched/ambiguous → unknown (never force-placed). Never reads
 * outcomes or findings from prose — that is out of scope for this parser entirely.
 */
export function inferRoleFromMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return { stage: "unknown", agentRole: "unknown", taskId: null, confidence: null,
      note: "no meta file; stage/task not inferable" };
  }
  const desc = typeof meta.description === "string" ? meta.description : "";
  const name = typeof meta.name === "string" ? meta.name
    : (typeof meta.agentType === "string" ? meta.agentType : "");
  const taskFrom = (s) => { const m = /task\s*#?\s*(\d+)/i.exec(s); return m ? `task-${parseInt(m[1], 10)}` : null; };

  let m;
  // 1) explicit name-label conventions (medium)
  if ((m = /^task(\d+)-impl/i.exec(name))) return R("implement", "implementer", `task-${+m[1]}`, "medium", `name label '${name}'`);
  if ((m = /^task(\d+)-adv/i.exec(name))) return R("review-adversarial", "reviewer", `task-${+m[1]}`, "medium", `name label '${name}'`);
  if ((m = /^task(\d+)-(review|std)/i.exec(name))) return R("review-standard", "reviewer", `task-${+m[1]}`, "medium", `name label '${name}'`);
  if (/^final-integ/i.test(name)) return R("integration-gate", "gate-runner", null, "medium", `name label '${name}'`);
  if (/^rereview/i.test(name)) return R("re-review", "reviewer", null, "medium", `name label '${name}'`);

  // 2) description prose
  if (/adversarial\s+review/i.test(desc)) return R("review-adversarial", "reviewer", taskFrom(desc), "medium", `description "${desc}"`);
  if (/standard\s+review/i.test(desc)) return R("review-standard", "reviewer", taskFrom(desc), "medium", `description "${desc}"`);
  if (/re-?review/i.test(desc)) return R("re-review", "reviewer", taskFrom(desc), "low", `description "${desc}"`);
  if (/\bimplement(?:ation)?\b/i.test(desc)) return R("implement", "implementer", taskFrom(desc), "medium", `description "${desc}"`);
  if (/\bfix\b/i.test(desc)) return R("fix", "fixer", taskFrom(desc), "low", `description "${desc}"`);
  if (/integration\s+gate|full\s+suite/i.test(desc)) return R("integration-gate", "gate-runner", taskFrom(desc), "low", `description "${desc}"`);
  // weak generic "review" — LOW confidence, grouped as review-ambiguous and excluded
  // from stage-specific comparisons by default (§5 heuristic; surfaced in report).
  if (/\breview\b/i.test(desc)) return R("review-ambiguous", "reviewer", taskFrom(desc), "low", `weak generic 'review' in description "${desc}"`);

  // 3) ambiguous/unmatched → unknown
  return { stage: "unknown", agentRole: "unknown", taskId: null, confidence: null,
    note: `label not matched (name="${name}", desc="${desc.slice(0, 48)}")` };
}

/**
 * Parse one span from an agent transcript + optional meta.
 * Returns a span object; missing/unreliable data becomes null + a dataQuality entry.
 */
export function parseTranscript({ jsonlText = "", meta = null, spanId } = {}) {
  const { objs, malformedLines } = parseLines(jsonlText);
  const missingFields = [];
  const inferenceNotes = [];
  const errors = [];
  if (malformedLines) errors.push(`${malformedLines} malformed JSONL line(s) skipped`);

  // timestamps (min/max of parseable) — no reliable ts ⇒ null + flag (§6)
  const epochs = objs.map((o) => isoToEpochMs(o.timestamp)).filter((v) => v != null);
  let startedAtEpochMs = null, endedAtEpochMs = null;
  if (epochs.length) { startedAtEpochMs = Math.min(...epochs); endedAtEpochMs = Math.max(...epochs); }
  else {
    missingFields.push({ field: "startedAtEpochMs", reason: "no parseable timestamp in transcript" });
    missingFields.push({ field: "endedAtEpochMs", reason: "no parseable timestamp in transcript" });
  }

  // tokens + model
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
  const models = new Map();
  for (const o of objs) {
    const msg = o && o.message;
    if (o.type === "assistant" && msg && typeof msg === "object") {
      const u = msg.usage;
      if (u && typeof u === "object") {
        inputTokens += num(u.input_tokens);
        outputTokens += num(u.output_tokens);
        cacheReadTokens += num(u.cache_read_input_tokens);
        cacheCreationTokens += num(u.cache_creation_input_tokens);
      }
      if (typeof msg.model === "string") models.set(msg.model, (models.get(msg.model) || 0) + 1);
    }
  }
  const model = models.size ? [...models.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  if (!model) missingFields.push({ field: "model", reason: "no assistant message carried a model" });

  // tool_use ↔ tool_result matching by id
  const toolUses = new Map();   // id -> startMs
  const toolResults = new Map(); // id -> endMs
  let toolCalls = 0;
  for (const o of objs) {
    const ts = isoToEpochMs(o.timestamp);
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      if (blk.type === "tool_use" && blk.id != null) {
        toolCalls++;
        if (!toolUses.has(blk.id)) toolUses.set(blk.id, ts);
      }
      if (blk.type === "tool_result" && blk.tool_use_id != null) {
        if (!toolResults.has(blk.tool_use_id)) toolResults.set(blk.tool_use_id, ts);
      }
    }
  }
  const intervals = [];
  let unmatchedToolUses = 0;
  for (const [id, startMs] of toolUses) {
    const endMs = toolResults.get(id);
    if (startMs == null || endMs == null || endMs < startMs) { unmatchedToolUses++; continue; }
    intervals.push([startMs, endMs]);
  }
  let unmatchedToolResults = 0;
  for (const id of toolResults.keys()) if (!toolUses.has(id)) unmatchedToolResults++;
  if (unmatchedToolUses) errors.push(`${unmatchedToolUses} tool call(s) had no matching result (interrupted)`);
  if (unmatchedToolResults) errors.push(`${unmatchedToolResults} tool result(s) had no matching call`);

  // §7: report BOTH — summed (double-counts overlap) and union-elapsed (overlap merged)
  const summedToolMs = intervals.reduce((a, [s, e]) => a + (e - s), 0);
  const unionElapsedToolMs = unionLengthMs(intervals);

  const role = inferRoleFromMeta(meta);
  if (role.note) inferenceNotes.push({ field: "stage", note: role.note, confidence: role.confidence });

  return {
    spanId,
    stage: role.stage,
    taskId: role.taskId,
    agentRole: role.agentRole,
    stageClass: role.stage === "unknown" ? "unknown" : "inferred",
    stageConfidence: role.confidence,
    startedAtEpochMs, endedAtEpochMs, durationClock: "epoch",
    model,
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    toolCalls, summedToolMs, unionElapsedToolMs, unmatchedToolUses, unmatchedToolResults,
    // base/head are unknown historically (verified: no commit field in artifacts, §2)
    baseCommit: null, headCommit: null,
    baseHeadClass: "unknown",
    dataQuality: {
      confidence: errors.length ? "low" : (model && epochs.length ? "medium" : "low"),
      missingFields, inferenceNotes, instrumentationErrors: [], errors, malformedLines,
    },
  };
}
