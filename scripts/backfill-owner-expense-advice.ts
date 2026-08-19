// scripts/backfill-owner-expense-advice.ts
//
// Thin CLI wrapper. The logic lives in apps/api/src/modules/bills-grid/oea-backfill.ts so
// it sits inside the api workspace's typecheck and can be integration-tested directly;
// scripts/ is outside every workspace tsconfig.
//
// Run manually PER ENVIRONMENT — deliberately NOT part of the schema migration, so a
// failed backfill can never block a deploy.
//
//   Dry run (default, writes nothing):
//     DATABASE_URL=… npx tsx scripts/backfill-owner-expense-advice.ts
//
//   Apply (requires a real user id for BillingDocument.issuedById):
//     DATABASE_URL=… npx tsx scripts/backfill-owner-expense-advice.ts --apply --actor <uuid>
//
//   Restrict to one org:
//     … --org <uuid>
//
// Rollback:
//   DELETE FROM "BillingDocument" WHERE "docType"='owner_expense_advice'
//     AND "idempotencyKey" LIKE 'oea-backfill:%';
//   No ledger rows are ever written, so nothing else unwinds.
import { runOeaBackfill } from "../apps/api/src/modules/billing-documents/oea-backfill";

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

runOeaBackfill({
  apply: process.argv.includes("--apply"),
  orgId: flagValue("--org"),
  actorUserId: flagValue("--actor"),
})
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
