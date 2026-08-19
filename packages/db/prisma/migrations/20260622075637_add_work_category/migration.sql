-- CreateTable
CREATE TABLE "WorkCategory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkCategory_organizationId_isActive_sortOrder_idx" ON "WorkCategory"("organizationId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "WorkCategory_organizationId_name_key" ON "WorkCategory"("organizationId", "name");

-- AddForeignKey
ALTER TABLE "WorkCategory" ADD CONSTRAINT "WorkCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the existing canonical categories for every org (Other = UI affordance, not seeded)
INSERT INTO "WorkCategory" ("id", "organizationId", "name", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(), o."id", c.name, c.ord, true, now(), now()
FROM "Organization" o
CROSS JOIN (VALUES
  ('Plumbing', 0), ('Lighting', 1), ('Electrical', 2), ('Aircond/HVAC', 3), ('Appliance', 4),
  ('Furniture/Fittings', 5), ('Wifi/Internet', 6), ('Pest', 7), ('Cleaning', 8),
  ('Locks/Access', 9), ('Structural', 10), ('Painting', 11)
) AS c(name, ord)
ON CONFLICT ("organizationId", "name") DO NOTHING;
