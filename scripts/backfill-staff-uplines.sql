-- Backfill existing staff Parties to inherit the org admin as upline so they
-- appear under the synthetic KAEN Properties root in the org chart instead
-- of as disconnected roots. Run once after the per-role hierarchy update.
--
-- Idempotent: only updates staff with NULL upline; admin stays at root.
DO $$
DECLARE
  admin_party_id UUID;
BEGIN
  SELECT u."partyId" INTO admin_party_id
  FROM "User" u
  WHERE u.role = 'admin' AND u."userType" = 'operator' AND u.status = 'active'
  ORDER BY u."createdAt" ASC
  LIMIT 1;

  IF admin_party_id IS NULL THEN
    RAISE NOTICE 'No admin Party found - skipping backfill';
    RETURN;
  END IF;

  UPDATE "Party" p
  SET "uplineId" = admin_party_id, "updatedAt" = NOW()
  WHERE p."partyType" = 'individual'
    AND p."uplineId" IS NULL
    AND p."id" != admin_party_id
    AND p."id" IN (
      SELECT u."partyId" FROM "User" u
      WHERE u.role IN ('manager', 'editor', 'viewer')
        AND u."userType" = 'operator'
    );
END $$;
