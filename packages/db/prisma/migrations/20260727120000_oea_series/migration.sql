-- Owner Expense Advice (OEA-) document series for every existing organization.
--
-- Additive + idempotent. ensureChargeCategorySeeds also creates this lazily per org
-- (create-only, same as RCPT/EXP/EB), so this migration only front-loads it
-- deterministically for orgs that already exist — it is belt-and-braces, not the sole
-- provisioning path. Re-running is a no-op via the NOT EXISTS guard, and no existing
-- DocumentSeries row is read, updated, or deleted.
--
-- Rollback: DELETE FROM "DocumentSeries" WHERE "code" = 'OEA';
-- Safe only while no BillingDocument references the series (i.e. before any OEA has
-- been issued). Roll back the routing change first if unwinding both.
INSERT INTO "DocumentSeries" ("id", "organizationId", "code", "prefix", "padding", "includeYear", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."id", 'OEA', 'OEA', 4, false, true, NOW(), NOW()
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "DocumentSeries" ds
  WHERE ds."organizationId" = o."id" AND ds."code" = 'OEA'
);
