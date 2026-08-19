-- ─────────────────────────────────────────────────────────────────────────────
-- READ-ONLY scoping query for the "primary bill counted as a debit note against
-- its own charge" defect.
--
-- ⚠️ THE DEFECT IS STILL LIVE ON THIS BRANCH. The remedy — an
-- `originalDocumentId: { not: null }` filter in
-- owner-ledger/net-adjustments-by-charge.ts and
-- billing-documents/adjustment-sums.ts — lives on branch
-- `worktree-adjustment-money-fixes` and is deliberately not duplicated here.
-- This script is the SCOPING half: it measures the damage and is valid whether
-- or not that fix has landed. Run it before AND after that branch deploys.
--
-- A PRIMARY tenant bill for any pay_back_landlord category (rental, aircond,
-- carpark, deposits, utility_*) is minted `docType: "debit_note"` and its line
-- carries the chargeId it bills. The two adjustment helpers matched on docType
-- alone, so each such bill was netted as an adjustment to its own charge and the
-- owner-ledger collected amount DOUBLED.
--
-- This script only SELECTs. Run it before any re-sync to size the damage and —
-- critically — to split it by whether the owner-month is FROZEN, because
-- syncMonthService REFUSES to rebuild a frozen month (it returns skipped:1;
-- frozen rows are immutable and corrections must flow forward instead).
--
--   psql "$DSN" -f scripts/owner-ledger-primary-note-inflation.sql
-- ─────────────────────────────────────────────────────────────────────────────

\echo '── 1. Inflated ACTIVE owner-ledger rows, split by period status ─────────'

WITH primary_note_lines AS (
  -- Lines whose parent document is a PRIMARY bill (no originalDocumentId) that
  -- nonetheless carries a note docType — exactly what the helpers used to net in.
  SELECT
    l."chargeId",
    SUM(CASE WHEN d."docType" = 'debit_note' THEN l.amount ELSE -l.amount END) AS inflation
  FROM "BillingDocumentLine" l
  JOIN "BillingDocument" d ON d.id = l."documentId"
  WHERE l."chargeId" IS NOT NULL
    AND d."docType" IN ('credit_note', 'debit_note')
    AND d."originalDocumentId" IS NULL
    AND d."documentStatus" = 'ISSUED'
  GROUP BY l."chargeId"
),
affected AS (
  SELECT
    e."organizationId",
    e."ownerPartyId",
    e."statementMonth",
    e.id            AS ledger_entry_id,
    e.amount        AS booked_amount,
    p.inflation,
    COALESCE(per.status, 'open') AS period_status
  FROM primary_note_lines p
  JOIN "OwnerLedgerEntry" e
    ON e."sourceChargeId" = p."chargeId"
   AND e.status = 'active'
  LEFT JOIN "OwnerStatementPeriod" per
    ON per."organizationId" = e."organizationId"
   AND per."ownerPartyId"   = e."ownerPartyId"
   AND per."apartmentId"    IS NULL
   AND per."periodMonth"    = e."statementMonth"
)
SELECT
  period_status,
  COUNT(*)                          AS ledger_rows,
  COUNT(DISTINCT "ownerPartyId")    AS owners,
  COUNT(DISTINCT ("ownerPartyId", "statementMonth")) AS owner_months,
  SUM(booked_amount)                AS booked_total,
  SUM(inflation)                    AS overstated_by,
  SUM(booked_amount) - SUM(inflation) AS corrected_total
FROM affected
GROUP BY period_status
ORDER BY period_status;

\echo ''
\echo '── 2. The (owner, month) pairs a re-sync must cover — OPEN periods only ─'

WITH primary_note_lines AS (
  SELECT l."chargeId",
         SUM(CASE WHEN d."docType" = 'debit_note' THEN l.amount ELSE -l.amount END) AS inflation
  FROM "BillingDocumentLine" l
  JOIN "BillingDocument" d ON d.id = l."documentId"
  WHERE l."chargeId" IS NOT NULL
    AND d."docType" IN ('credit_note', 'debit_note')
    AND d."originalDocumentId" IS NULL
    AND d."documentStatus" = 'ISSUED'
  GROUP BY l."chargeId"
)
SELECT
  e."organizationId",
  e."ownerPartyId",
  to_char(e."statementMonth", 'YYYY-MM') AS month,
  COUNT(*)          AS rows_to_fix,
  SUM(p.inflation)  AS overstated_by
FROM primary_note_lines p
JOIN "OwnerLedgerEntry" e
  ON e."sourceChargeId" = p."chargeId"
 AND e.status = 'active'
LEFT JOIN "OwnerStatementPeriod" per
  ON per."organizationId" = e."organizationId"
 AND per."ownerPartyId"   = e."ownerPartyId"
 AND per."apartmentId"    IS NULL
 AND per."periodMonth"    = e."statementMonth"
WHERE COALESCE(per.status, 'open') <> 'frozen'
GROUP BY 1, 2, 3
ORDER BY 3, 2;

\echo ''
\echo '── 3. FROZEN and therefore NOT re-syncable — needs a forward correction ─'
\echo '     (syncMonthService returns skipped:1 on a frozen period by design)'

WITH primary_note_lines AS (
  SELECT l."chargeId",
         SUM(CASE WHEN d."docType" = 'debit_note' THEN l.amount ELSE -l.amount END) AS inflation
  FROM "BillingDocumentLine" l
  JOIN "BillingDocument" d ON d.id = l."documentId"
  WHERE l."chargeId" IS NOT NULL
    AND d."docType" IN ('credit_note', 'debit_note')
    AND d."originalDocumentId" IS NULL
    AND d."documentStatus" = 'ISSUED'
  GROUP BY l."chargeId"
)
SELECT
  e."ownerPartyId",
  to_char(e."statementMonth", 'YYYY-MM') AS month,
  per."firstFrozenAt",
  COUNT(*)         AS stuck_rows,
  SUM(p.inflation) AS overstated_by
FROM primary_note_lines p
JOIN "OwnerLedgerEntry" e
  ON e."sourceChargeId" = p."chargeId"
 AND e.status = 'active'
JOIN "OwnerStatementPeriod" per
  ON per."organizationId" = e."organizationId"
 AND per."ownerPartyId"   = e."ownerPartyId"
 AND per."apartmentId"    IS NULL
 AND per."periodMonth"    = e."statementMonth"
WHERE per.status = 'frozen'
GROUP BY 1, 2, 3
ORDER BY 2, 1;

\echo ''
\echo '── 4. ADMIN-EDITED rows — a re-sync SKIPS these, they stay wrong ────────'
\echo '     (sync.ts:42-45: updatedById <> the sync sentinel => SKIP)'

WITH primary_note_lines AS (
  SELECT l."chargeId",
         SUM(CASE WHEN d."docType" = 'debit_note' THEN l.amount ELSE -l.amount END) AS inflation
  FROM "BillingDocumentLine" l
  JOIN "BillingDocument" d ON d.id = l."documentId"
  WHERE l."chargeId" IS NOT NULL
    AND d."docType" IN ('credit_note', 'debit_note')
    AND d."originalDocumentId" IS NULL
    AND d."documentStatus" = 'ISSUED'
  GROUP BY l."chargeId"
)
SELECT
  e."ownerPartyId",
  to_char(e."statementMonth", 'YYYY-MM') AS month,
  e.id                    AS ledger_entry_id,
  e."updatedById"         AS edited_by,
  e.amount                AS booked_amount,
  p.inflation             AS overstated_by,
  e.amount - p.inflation  AS should_be
FROM primary_note_lines p
JOIN "OwnerLedgerEntry" e
  ON e."sourceChargeId" = p."chargeId"
 AND e.status = 'active'
WHERE e."updatedById" <> '00000000-0000-4000-8000-00000000a0a0'  -- SYNC_ACTOR_ID
ORDER BY 2, 1;
