// A 3-level process tree (parent -> child -> grandchild), mimicking npm -> runner -> worker.
// Each level records its pid to <dir>/pid-<depth> and stays alive. No signal handlers, so a
// group signal (SIGTERM) terminates the whole tree — used to prove no orphaned descendants.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const depth = Number(process.argv[3] || "0");
writeFileSync(join(dir, `pid-${depth}`), String(process.pid));
if (depth < 2) spawn(process.execPath, [process.argv[1], dir, String(depth + 1)], { stdio: "inherit" });
setInterval(() => {}, 1000);
