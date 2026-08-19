-- Per-org uniqueness for Party.primaryEmail and Party.primaryPhone.
--
-- Why partial indexes: both columns are nullable and many existing rows have
-- NULL/empty values. A plain UNIQUE would either reject every NULL collision
-- (Postgres treats multiple NULLs as distinct, so this part is OK) or, more
-- subtly, reject every empty-string collision (multiple rows with '' DO
-- collide). The empty-string filter keeps legacy/historical rows unaffected.
--
-- Why lower() on email: 'Foo@Bar.com' and 'foo@bar.com' should be the same
-- person. Phone normalization is left to the app layer (we trim) — phone
-- formats are too varied for a useful expression-index transform.
--
-- Scope: per-organization. Two different orgs can have parties with the same
-- email (e.g. shared service accounts across tenants).
--
-- The matching service-layer guard lives in
-- apps/api/src/modules/parties/parties.service.ts → checkContactUniqueness.
-- The DB index is the durable enforcement; the service layer exists to
-- return a friendly 409 with the conflicting party's identity.

CREATE UNIQUE INDEX "Party_org_email_unique"
  ON "Party" ("organizationId", lower("primaryEmail"))
  WHERE "primaryEmail" IS NOT NULL AND "primaryEmail" <> '';

CREATE UNIQUE INDEX "Party_org_phone_unique"
  ON "Party" ("organizationId", "primaryPhone")
  WHERE "primaryPhone" IS NOT NULL AND "primaryPhone" <> '';
