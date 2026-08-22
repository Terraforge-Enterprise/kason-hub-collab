ALTER TABLE "User"
ADD COLUMN "permission_overrides" JSONB NOT NULL DEFAULT '{}';
