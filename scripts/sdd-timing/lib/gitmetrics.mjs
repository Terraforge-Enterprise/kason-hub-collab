// Observational SDD timing — git diff metrics for a span's base..head range.
// Historical spans have no recorded range (§2) → status "unknown", never fabricated.
import { execFileSync } from "node:child_process";

export function diffMetrics({ repoDir, baseCommit, headCommit } = {}) {
  if (!baseCommit || !headCommit) {
    return { filesChanged: null, insertions: null, deletions: null, status: "unknown",
      reason: "no base..head range recorded (historical; §2)" };
  }
  try {
    const out = execFileSync("git", ["-C", repoDir, "diff", "--numstat", `${baseCommit}..${headCommit}`], { encoding: "utf8" });
    let filesChanged = 0, insertions = 0, deletions = 0;
    for (const line of out.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      filesChanged++;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
    }
    return { filesChanged, insertions, deletions, status: "authoritative", reason: null };
  } catch (e) {
    return { filesChanged: null, insertions: null, deletions: null, status: "unavailable",
      reason: `git diff failed: ${String(e && e.message || e).slice(0, 80)}` };
  }
}
