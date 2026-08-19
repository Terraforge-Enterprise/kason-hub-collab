-- T6: one-active-tenancy-per-unit -- permanent DB invariant.
--
-- Pre-sweep: any unit that currently has MORE THAN ONE 'active' Tenancy
-- (should not happen going forward once the index below exists, but may
-- exist in historical data) is closed down to a single survivor -- the one
-- with the latest startDate (tie-broken by createdAt, then id, both DESC so
-- the choice is fully deterministic). Every non-survivor is flipped to
-- 'ended' with endDate = survivor.startDate, and one AuditLog row is written
-- per swept row, attributed to the org's earliest-created admin User (a real
-- actor -- AuditLog.actorUserId is a NOT NULL FK to User with ON DELETE
-- RESTRICT, so a sentinel string is not an option).
--
-- The LATERAL join is an INNER join deliberately: an org with duplicate
-- actives but no admin User is swept without an audit row (rare edge --
-- watch the affected-row count on the staging run).
--
-- Once the data is deterministically clean, CREATE UNIQUE INDEX enforces the
-- invariant going forward. Prisma 7 cannot express a partial (WHERE) unique
-- index in @@unique/@@index -- this index lives only here.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY "organizationId","unitId"
           ORDER BY "startDate" DESC, "createdAt" DESC, id DESC) AS rn,
         first_value("startDate") OVER (PARTITION BY "organizationId","unitId"
           ORDER BY "startDate" DESC, "createdAt" DESC, id DESC) AS survivor_start
  FROM "Tenancy" WHERE status = 'active'
),
swept AS (
  UPDATE "Tenancy" t
     SET status = 'ended', "endDate" = r.survivor_start, "updatedAt" = now()
    FROM ranked r
   WHERE t.id = r.id AND r.rn > 1
  RETURNING t.id, t."organizationId"
)
INSERT INTO "AuditLog" ("id","organizationId","actorUserId","actorRole","action","entityType","entityId","createdAt")
SELECT gen_random_uuid(), s."organizationId", u.id, 'admin',
       'tenancy.presweep_duplicate_active_closed', 'Tenancy', s.id, now()
FROM swept s
JOIN LATERAL (
  SELECT id FROM "User" WHERE "organizationId" = s."organizationId" AND role = 'admin'
  ORDER BY "createdAt" ASC LIMIT 1
) u ON true;

CREATE UNIQUE INDEX "tenancy_one_active_per_unit"
  ON "Tenancy" ("organizationId","unitId") WHERE status = 'active';
