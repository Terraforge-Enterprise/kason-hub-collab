import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getDb } from "@kason/db";
import { runImport } from "./service";

// Load env from cwd AND repo root (mirrors apps/api/src/index.ts) so the CLI works
// whether invoked from the repo root or the apps/api workspace dir (npm --workspace).
dotenv.config({ path: resolve(process.cwd(), ".env") });
dotenv.config({ path: resolve(process.cwd(), "../../.env") });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (k: string): string | undefined => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dryRun = !args.includes("--commit");
  const orgId = flag("--org");
  const actor = flag("--actor");
  if (!orgId || !actor) {
    throw new Error(
      "Usage: npm run import:tenants -- --org <orgId> --actor <adminUserId> [--commit] [--file <path>] [--agent-map <csv>] [--room-map <csv>]",
    );
  }
  const db = getDb();
  const user = await db.user.findFirst({
    where: { id: actor, organizationId: orgId },
    select: { id: true, role: true },
  });
  if (!user) throw new Error(`actor user ${actor} not found in org ${orgId}`);

  const session = { orgId, userId: user.id, role: "admin" as const, userType: "operator" as const };
  const res = await runImport(session, {
    dryRun,
    filePath: flag("--file"),
    agentMapCsv: flag("--agent-map"),
    roomMapCsv: flag("--room-map"),
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    })
    .finally(() => {
      getDb().$disconnect().catch(() => {
        // disconnect is best-effort; swallow errors
      });
    });
}
