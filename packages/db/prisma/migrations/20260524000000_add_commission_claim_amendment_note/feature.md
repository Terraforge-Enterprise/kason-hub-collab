# add_commission_claim_amendment_note

Adds optional `amendmentNote` text column on `commission_claim` for the
admin "Send back for amendment" flow. Nullable; no backfill. Mirrors the
existing `unit_submission.amendmentNote` and `property_submission.amendmentNote`
column shape (but on a different table — no shared column).

**UAT deploy gated** by `apps/api/.claude/uat-migration-allowed` (see UAT freeze in
`apps/api/CLAUDE.md`). This migration is local-only at authoring time.

**Local apply:** Migration file authored manually because `prisma migrate dev`
hit pre-existing drift on a previous migration (`inventory_three_table_refactor`
was patched after apply) and would have requested a destructive local DB reset.
Authoring the SQL by hand sidesteps the reset. To apply locally once the drift
is resolved: `cd packages/db && npx prisma migrate dev`.

Spec: `docs/superpowers/specs/2026-05-24-commission-claim-admin-amend-design.md`
