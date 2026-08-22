-- KAEN PROPERTIES MANAGEMENT SDN BHD does not retain tenant deposits.
-- Convert legacy held rows and make the owner-payable state the database default.
UPDATE "Deposit"
SET "status" = 'released_to_owner'
WHERE "status" = 'held';

ALTER TABLE "Deposit"
ALTER COLUMN "status" SET DEFAULT 'released_to_owner';
