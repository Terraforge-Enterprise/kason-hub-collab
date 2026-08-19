-- Add amendmentNote column to commission_claim for the admin
-- "Send back for amendment" flow (needs_amendment ClaimStatus).
--
-- Mirrors UnitSubmission.amendmentNote and PropertySubmission.amendmentNote.
-- Nullable; no backfill needed. Cleared on agent resubmit.
--
-- Spec: docs/superpowers/specs/2026-05-24-commission-claim-admin-amend-design.md

ALTER TABLE "CommissionClaim" ADD COLUMN "amendmentNote" TEXT;
