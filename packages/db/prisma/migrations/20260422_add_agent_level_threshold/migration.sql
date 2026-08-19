-- AgentLevelThreshold backs the "how much cumulative commission does an
-- agent need to earn to reach the next tier" lookup used by the commission
-- engine. The model was added in commit 9fcaa2b but no migration file was
-- ever committed, so prod Supabase didn't have the table.

CREATE TABLE "AgentLevelThreshold" (
  "id"                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"           uuid           NOT NULL,
  "agentLevel"               text           NOT NULL,
  "minCumulativeCommission"  numeric(12,2)  NOT NULL,
  "createdAt"                timestamp(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                timestamp(3)   NOT NULL
);

CREATE UNIQUE INDEX "AgentLevelThreshold_organizationId_agentLevel_key"
  ON "AgentLevelThreshold"("organizationId", "agentLevel");

CREATE INDEX "AgentLevelThreshold_organizationId_minCumulativeCommission_idx"
  ON "AgentLevelThreshold"("organizationId", "minCumulativeCommission");

ALTER TABLE "AgentLevelThreshold"
  ADD CONSTRAINT "AgentLevelThreshold_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"(id)
  ON UPDATE CASCADE ON DELETE CASCADE;
