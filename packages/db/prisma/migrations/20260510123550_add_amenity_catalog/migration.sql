-- CreateTable
CREATE TABLE "Amenity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Amenity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Amenity_organizationId_isActive_sortOrder_idx" ON "Amenity"("organizationId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "Amenity_organizationId_createdAt_idx" ON "Amenity"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Amenity" ADD CONSTRAINT "Amenity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Case-insensitive unique on (organizationId, LOWER(TRIM(name))).
-- Prisma can't express functional unique indexes natively, so we declare
-- it as raw SQL. TRIM catches " Gym " vs "gym" collisions even though
-- Zod's .trim() strips whitespace at the API edge — defense in depth.
CREATE UNIQUE INDEX "Amenity_organizationId_nameCi_key"
  ON "Amenity" ("organizationId", LOWER(TRIM(name)));

-- RLS lockdown: deny-all baseline (no policies). API connects as `postgres`
-- (Prisma DATABASE_URL) and bypasses RLS; Supabase `anon` / `authenticated`
-- roles are subject to RLS and get nothing. Matches the bootstrap pattern
-- from 20260506000000_rls_lockdown_deny_all for every public table.
ALTER TABLE "Amenity" ENABLE ROW LEVEL SECURITY;
