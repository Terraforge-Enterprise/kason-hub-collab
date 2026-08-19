-- Adds the Party.uplineId self-FK that backs the agent hierarchy (upline/downline).
-- The schema.prisma field was introduced in commit 626be7a but no migration file
-- was created, so prod Supabase diverged from the Prisma schema. Every query
-- selecting `upline` (portal /team, admin /parties/agents, /parties/agents/hierarchy)
-- was 500-ing with P2022 ColumnNotFound until this migration landed.
--
-- Additive + nullable: no existing row is touched.

ALTER TABLE "Party" ADD COLUMN "uplineId" uuid;

ALTER TABLE "Party"
  ADD CONSTRAINT "Party_uplineId_fkey"
  FOREIGN KEY ("uplineId") REFERENCES "Party"(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX "Party_organizationId_uplineId_idx"
  ON "Party"("organizationId", "uplineId");
