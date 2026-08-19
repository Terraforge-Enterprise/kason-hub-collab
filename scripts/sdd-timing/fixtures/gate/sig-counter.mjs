// Counts how many times it receives SIGINT/SIGTERM. Writes <dir>/ready on start and
// <dir>/count on each signal. After the first signal it waits 250ms (to catch a possible
// SECOND delivery) then exits 0. Used to prove single vs double signal delivery.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
writeFileSync(join(dir, "ready"), "1");
let count = 0;
const onSig = () => { count += 1; writeFileSync(join(dir, "count"), String(count)); };
process.on("SIGINT", onSig);
process.on("SIGTERM", onSig);
setInterval(() => {}, 1000);
const iv = setInterval(() => { if (count > 0) { clearInterval(iv); setTimeout(() => process.exit(0), 250); } }, 20);
