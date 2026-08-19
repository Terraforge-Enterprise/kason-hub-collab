import { fileURLToPath } from "node:url";
import { purgeExpiredAudit } from "./audit.service";

/**
 * Invoke the audit-log purge with the standard 10-day retention.
 * Returns the number of rows deleted so the caller can log / alert.
 */
export async function runAuditPurge(): Promise<number> {
  const result = await purgeExpiredAudit(10);
  return result.count;
}

// Allow direct CLI invocation (scheduled worker / GitHub Actions cron).
// ESM equivalent of `require.main === module`.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runAuditPurge()
    .then((n) => {
      console.log(`audit-purge: deleted ${n} rows`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
