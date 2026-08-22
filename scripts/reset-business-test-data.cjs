require("dotenv").config({ quiet: true });
const { Client } = require("pg");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const organizations = await client.query(`
    SELECT o.id, o.name,
      (SELECT count(*)::int FROM "Property" p WHERE p."organizationId" = o.id) AS properties,
      (SELECT count(*)::int FROM "Apartment" a WHERE a."organizationId" = o.id) AS units,
      (SELECT count(*)::int FROM "Party" p WHERE p."organizationId" = o.id) AS parties,
      (SELECT count(*)::int FROM "Tenancy" t WHERE t."organizationId" = o.id) AS tenancies
    FROM "Organization" o ORDER BY o."createdAt"
  `);
  console.log(JSON.stringify(organizations.rows, null, 2));
  const orgId = organizations.rows[0]?.id;
  if (orgId) {
    if (process.argv.includes("--verify")) {
      const preserved = await client.query(`SELECT
        (SELECT count(*)::int FROM "User" WHERE "organizationId"=$1) AS users,
        (SELECT count(*)::int FROM "Party" WHERE "organizationId"=$1) AS parties,
        (SELECT count(*)::int FROM "ChargeCategory" WHERE "organizationId"=$1) AS charge_categories,
        (SELECT count(*)::int FROM "DocumentSeries" WHERE "organizationId"=$1) AS document_series,
        (SELECT count(*)::int FROM "DraftConfig" WHERE "organizationId"=$1) AS draft_configs,
        (SELECT count(*)::int FROM "PropertyType" WHERE "organizationId"=$1) AS property_types,
        (SELECT count(*)::int FROM "BankReconciliationAccount" WHERE "organizationId"=$1) AS bank_accounts`, [orgId]);
      console.log(JSON.stringify(preserved.rows[0], null, 2));
      await client.end();
      return;
    }
    const parties = await client.query(`SELECT p.id, p."displayName", array_remove(array_agg(DISTINCT pr."roleType"), NULL) AS roles, count(DISTINCT u.id)::int AS users FROM "Party" p LEFT JOIN "PartyRole" pr ON pr."partyId" = p.id LEFT JOIN "User" u ON u."partyId" = p.id WHERE p."organizationId" = $1 GROUP BY p.id, p."displayName" ORDER BY p."displayName"`, [orgId]);
    console.log(JSON.stringify(parties.rows, null, 2));
    const tables = await client.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'organizationId' ORDER BY table_name`);
    const populated = [];
    for (const { table_name: table } of tables.rows) {
      const count = await client.query(`SELECT count(*)::int AS count FROM "${table.replaceAll('"', '""')}" WHERE "organizationId" = $1`, [orgId]);
      if (count.rows[0].count) populated.push({ table, count: count.rows[0].count });
    }
    console.log(JSON.stringify(populated, null, 2));
    if (process.argv.includes("--probe") || process.argv.includes("--apply")) {
      await client.query("BEGIN");
      try {
        await client.query(`DELETE FROM "User" WHERE "organizationId" = $1 AND "partyId" IN (SELECT pr."partyId" FROM "PartyRole" pr WHERE pr."organizationId" = $1 AND pr."roleType" IN ('owner','tenant'))`, [orgId]);
        const businessTables = [
          "NotificationQueue", "Notification", "BankCostAllocation", "BankReconciliationTransaction",
          "PaymentAllocation", "Payment", "ChargeEvent", "Charge", "BillingDocument", "Invoice", "Bill", "Deposit",
          "OwnerLedgerEntry", "CashMovement", "CommissionClaimItem", "CommissionClaim", "MaintenanceRequest",
          "DocumentLink", "Document", "InvoiceDraftRun", "GridExpense", "BillsGridSummaryNote", "UnitMonthLedger",
          "LandlordTenancy", "Project", "RecurringCharge", "Tenancy", "UnitBillsGridEntry",
        ];
        for (const table of businessTables) {
          const hasOrg = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='organizationId'`, [table]);
          if (hasOrg.rowCount) await client.query(`DELETE FROM "${table}" WHERE "organizationId" = $1`, [orgId]);
        }
        await client.query(`DELETE FROM "Property" WHERE "organizationId" = $1`, [orgId]);
        await client.query(`DELETE FROM "Party" WHERE "organizationId" = $1 AND id IN (SELECT pr."partyId" FROM "PartyRole" pr WHERE pr."organizationId" = $1 AND pr."roleType" IN ('owner','tenant'))`, [orgId]);
        if (process.argv.includes("--apply")) {
          await client.query("COMMIT");
          console.log("APPLY_OK");
        } else {
          await client.query("ROLLBACK");
          console.log("PROBE_OK");
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }
  await client.end();
}

main().catch((error) => { console.error(error.message); process.exit(1); });
