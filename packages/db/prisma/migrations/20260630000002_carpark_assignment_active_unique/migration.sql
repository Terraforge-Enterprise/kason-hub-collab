-- DB-level guarantee: only ONE active assignment per carpark bay.
-- This closes the TOCTOU race that the app-layer pre-check alone cannot prevent
-- under concurrent requests.
--
-- Prisma 7 cannot express a partial unique index in @@unique; this index lives
-- only in the migration SQL. A comment above model CarparkAssignment in
-- schema.prisma documents its existence.
CREATE UNIQUE INDEX "CarparkAssignment_carparkId_active_key"
    ON "CarparkAssignment"("carparkId")
    WHERE "status" = 'active';
