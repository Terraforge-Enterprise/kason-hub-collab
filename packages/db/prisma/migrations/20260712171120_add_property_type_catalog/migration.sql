-- CreateTable
CREATE TABLE "PropertyType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyType_organizationId_isActive_sortOrder_idx" ON "PropertyType"("organizationId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyType_organizationId_name_key" ON "PropertyType"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "PropertyType" ADD CONSTRAINT "PropertyType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS (deny-all posture, no CREATE POLICY — the Hono API connects as the
-- postgres superuser; RLS is defense-in-depth vs direct anon/authenticated access).
ALTER TABLE "PropertyType" ENABLE ROW LEVEL SECURITY;

-- Seed the catalog from each org's existing distinct Property.propertyType values.
-- GROUP BY (not SELECT DISTINCT) so gen_random_uuid()/now() evaluate once per group
-- and yield exactly one fresh row per (organizationId, propertyType) pair.
-- ON CONFLICT DO NOTHING makes the step idempotent under migrate reset.
INSERT INTO "PropertyType" ("id","organizationId","name","sortOrder","isActive","createdAt","updatedAt")
SELECT gen_random_uuid(), p."organizationId", p."propertyType", 0, true, now(), now()
FROM "Property" p
GROUP BY p."organizationId", p."propertyType"
ON CONFLICT ("organizationId","name") DO NOTHING;
