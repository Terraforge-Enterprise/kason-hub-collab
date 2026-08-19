// packages/shared/src/constants/phase2-flags.ts
/**
 * Phase-2 feature flags (foundation §4) — default OFF everywhere.
 * API reads process.env[flag]; web reads import.meta.env[`VITE_${flag}`].
 * Each gates its module's routes + nav so foundation merges/promotes dark.
 */
export const PHASE2_FLAGS = [
  "ENABLE_PHASE2_TENANT_TRACKER",
  "ENABLE_PHASE2_METER",
  "ENABLE_PHASE2_MULTI_PAY",
  "ENABLE_PHASE2_FPX",
  "ENABLE_PHASE2_AUTODRAFT",
  "ENABLE_PHASE2_OWNER_BILLING",
  "ENABLE_PHASE2_TASKS",
  "ENABLE_PHASE2_PWA_PUSH",
  "ENABLE_PHASE2_SPRINTS",
  "ENABLE_PHASE2_UNIT_ANALYTICS",
  "ENABLE_PHASE2_BILLING_DOCS",
  "ENABLE_UNIT_MONTH_LEDGER",
  "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
  "ENABLE_PHASE2_BILLS_GRID",
  "ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER",
  "ENABLE_PHASE2_RENT_RECLASSIFICATION",
  "ENABLE_PHASE2_OWNER_REMITTANCE",
  // R4 — prior-period-adjustment backend spike. Default OFF (flag-dark); gates ONLY
  // the PPA admin endpoint (POST /api/owner-ledger/prior-period-adjustments) + its
  // service. Independent of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER.
  "ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT",
  // Phase 3.1 — charge-scoped CREATE credit/debit note (partial amounts), tenant-only.
  // Gates ONLY POST /api/billing-documents/charge-adjustments; independent of every
  // other Phase-2 flag (layered ON TOP of the module-wide ENABLE_PHASE2_BILLING_DOCS
  // gate already applied to every route in that router).
  "ENABLE_PHASE2_INVOICE_ADJUSTMENTS",
  // Bill-expenses feature (spec R1-R5) — mints one payable Charge per active
  // GridExpense at Bill issuance, co-grouped with that party's utility charges.
  // Independent of ENABLE_PHASE2_BILLING_DOCS's caller seam (nested inside it).
  "ENABLE_BILL_EXPENSES_AS_CHARGES",
  // Read-time union of GridAttachment onto the owner-statement Bills & Proof panel. P1
  // presentational only (no payout impact); off ⇒ statement shows manual proofs exactly as today.
  "ENABLE_GRID_BILLS_ON_OWNER_STATEMENT",
  // Accounting-doc redesign P3 — the internal Expense (EXP-) module: create a
  // SupplierExpense + its Borne-By allocations. Default OFF; gates POST /api/expenses.
  "ENABLE_SUPPLIER_EXPENSES",
  // ENABLE_OWNER_BORNE_DEDUCT was REMOVED (2026-08-16, operator decision). It gated a
  // SECOND, competing way to make an owner bear a grid expense: don't invoice them at
  // all (an OEA advice) and deduct it at ledger-sync time instead. KAEN wants the
  // opposite and always did — the expense must SHOW as an IVOWN line the owner can see,
  // and be netted out of the payout when the rent is collected. That is exactly what
  // auto-offset-on-rent.hook.ts does, so the flag was redundant machinery guarding a
  // model nobody wanted. Owner-borne expenses now always stay IVOWN lines.
  // Accounting-doc redesign P4 — tenant-borne bills-grid expense charges (chargeType
  // "expense", sourceGridExpenseId set) route to their OWN "Expense Bill" (EB-) document
  // instead of co-grouping onto the tenant's IVTEN — recovering a tenant-borne expense is
  // not KAEN service revenue. Default OFF: the charge stays on IVTEN (today's behavior).
  // ON: issue-grouped.ts routes the charge's group onto the EB- series (own document),
  // so IVTEN carries only KAEN-service charges — XOR, never both. mintExpenseChargesTx
  // itself is unchanged; only the downstream grouping/issuance fate changes. The
  // owner-side twin of this flag was removed — see the note above.
  "ENABLE_EXPENSE_BILL",
  // Accounting-doc redesign P6 — the KAEN agency's own operating-expense ledger
  // (software subscriptions, office rent, bank charges, etc. — never owner/tenant
  // money). Default OFF: a borneBy:"kaen" SupplierExpenseAllocation just sits
  // recoveryStatus:"pending" with no destination (today's behavior). ON:
  // createSupplierExpenseService also creates a KaenOperatingExpense row per kaen
  // allocation (same tx, idempotent on sourceExpenseAllocationId). Independent of
  // every other Phase-2 flag.
  "ENABLE_KAEN_OPEX",
  // Accounting-doc redesign P7 (reshaped, 2026-07-23) — Owner Funding Request: a
  // DELIBERATE admin-issued ask for the owner to fund KAEN (e.g. a big repair far
  // exceeds the rent collected). NOT an auto-derived "owner owes" status and NOT a
  // BillingDocument/invoice — the already-carried-forward negative owner running
  // balance stays silent/automatic (no payout-math change). Default OFF: gates
  // POST/GET /api/owner-funding-requests. Independent of every other Phase-2 flag.
  "ENABLE_OWNER_FUNDING_REQUEST",
  // Accounting-doc redesign P1 (2026-07-23) — human-facing sequential DISPLAY
  // numbers for Owner Statements (OST-) and Owner Remittances (REM-), minted
  // from the existing DocumentSeries/mintDocumentNumberTx machinery (same
  // mechanism as EXP-/RCPT-). Additive only: Invoice.statementNumber /
  // OwnerLedgerEntry.remittanceNumber are NEW nullable columns that never
  // replace an existing identity/dedupe key (OS- invoiceNumber slug,
  // OwnerLedgerEntry idempotencyKey). Default OFF: columns stay null, zero
  // behavior change. Independent of every other Phase-2 flag.
  "ENABLE_OWNER_DOC_NUMBERING",
  // Accounting-doc redesign (2026-07-23) — per-charge Expense/Profit nature routing.
  // Default OFF. ON: a TENANT charge with nature "expense" routes to EB instead of
  // IVTEN as revenue (depends on ENABLE_EXPENSE_BILL). An OWNER charge stays an IVOWN
  // line whatever its nature — the owner-side deduction destination was removed with
  // ENABLE_OWNER_BORNE_DEDUCT (see above), and with it the Bill-time fail-closed throw
  // that fired when nature routing was on without it.
  "ENABLE_CHARGE_NATURE_ROUTING",
  // Task 2 (2026-07-24) — month-close auto-issue of owner-statement Invoices. ON:
  // the freeze-owner-statements cron calls generateStatementService for each owner's
  // COMBINED scope ONLY (never per-unit — a per-unit statement is a strict subset of
  // the combined one, so it would find every charge already minted and ClosedPeriod-
  // Error against the already-frozen combined period; the per-unit FREEZE still
  // snapshots correctly on its own) immediately BEFORE freezing that scope, so the
  // statement Invoice + its mgmt/cleaning charges + PDF are minted automatically at
  // month-end instead of requiring ~1000 manual "Issue statement" clicks. Also gated
  // to a strictly-past billing month (real wall clock). API-only (cron); no web/portal
  // surface. Default OFF (safety valve). Independent of
  // ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER — do NOT ride that flag; it is already
  // ON in UAT/prod, so riding it would auto-mint statements for every owner on the
  // next deploy. OFF: the cron behaves exactly as before this flag existed (freeze
  // only; generateStatementService is never called).
  // HARD-DEPENDS on ENABLE_PHASE2_OWNER_BILLING: generateStatementService's owner-
  // ledger sync (syncOwnerLedgerForCharges) is itself ENABLE_PHASE2_OWNER_BILLING-
  // gated. If auto-issue is ON but OWNER_BILLING is OFF, that sync no-ops, so the
  // frozen snapshot OMITS the mgmt/cleaning deductions and OVER-STATES the owner
  // payout — always enable OWNER_BILLING alongside this flag.
  "ENABLE_OWNER_STATEMENT_AUTO_ISSUE",
  // Owner WEB statement expense visibility (money-visibility). Default OFF ⇒ the
  // owner portal shows every expense exactly as before (the response gains only an
  // inert additive `sourceType` field per row, which existing consumers ignore). ON ⇒ the
  // portal JSON route (/portal-api/owner/statements/:id/sections) hides all expense
  // rows EXCEPT tenant-recharge utilities the tenant has FULLY paid — so the owner
  // only sees expenses KAEN actually holds tenant money for. Owner-borne costs
  // (cleaning/cukai/repairs/Source-6), the KAEN fee, and reversals are hidden on the
  // web. WEB-ONLY: the owner PDF (buildYanniePdfHtml, re-assembled separately) and
  // the portal PDF export ALWAYS show every expense, regardless of this flag.
  "ENABLE_OWNER_WEB_EXPENSE_HIDE",
  // Auto-settle the owner's open IVOWN receivable lines when a tenant's RENT is
  // fully paid. KAEN already nets the management fee and owner-borne expenses out
  // of the rent before remitting — the owner ledger deducts them — but the IVOWN
  // invoice document itself stayed "Unpaid" forever, so the paperwork disagreed
  // with the money. ON ⇒ afterPaymentSettled records an OWNER_RECEIVABLE_OFFSET
  // (the SAME non-cash settlement an admin can post by hand at
  // POST /api/owner-receivable-offsets), settling those lines paid / partially
  // paid. Default OFF.
  //
  // DELIBERATELY NOT gated on ENABLE_PHASE2_OWNER_REMITTANCE: that flag also opens
  // the cash-remittance endpoints and carries its own open enablement gate. This
  // hook calls recordOffsetService directly (the SERVICE is not flag-gated — only
  // the HTTP routes are), so the two enable independently.
  //
  // Settlement is capped by the owner's available payable (OFFSET_EXCEEDS_PAYABLE)
  // — you can only net what KAEN actually owes the owner. In a letting-commission
  // month the payable is zero, so nothing settles. That is correct, not a fault.
  // ENABLE_AUTO_OFFSET_ON_RENT was REMOVED (2026-08-16, operator decision: "when payout,
  // IT MUST DEDUCT the expenses from the current IVOWN"). The hook it gated is now
  // unconditional — see auto-offset-on-rent.hook.ts. Default OFF meant the deduction KAEN
  // has always performed in practice never happened in the system, leaving owners' IVOWN
  // invoices Unpaid forever.
  // Month-end owner-statement AUTO-SEND (apps/api/src/cron/send-owner-statements.ts).
  // Default OFF ⇒ the send cron is a hard no-op: it never opens a DB connection and
  // no statement's status is ever moved to "sent".
  //
  // ON ⇒ once the org's LOCAL clock passes (ownerStatementSendDay,
  // ownerStatementSendHour) of the month AFTER a frozen billing month, that month's
  // approved statements transition draft/approved → "sent".
  //
  // WHAT THIS DOES *NOT* DO (read before enabling): it does not email anybody.
  // sendStatementService has never sent an email — it flips Invoice.status and mints
  // a signed download URL. Owner PORTAL visibility does not depend on this flag or on
  // "sent" at all: portal.owner-statements.routes gates on sent/approved/paid/partial,
  // and the month-end freeze cron already auto-approves. So with this flag OFF the
  // owner can ALREADY see their frozen statement in the portal; turning it ON only
  // adds the "sent" bookkeeping transition and the emailOwnerStatement() seam.
  //
  // HARD-DEPENDS on ENABLE_OWNER_STATEMENT_AUTO_ISSUE + ENABLE_PHASE2_OWNER_STATEMENT_
  // LIVE_LEDGER: with no auto-issued, auto-approved statement there is nothing to send.
  "ENABLE_OWNER_STATEMENT_AUTO_SEND",
  // Tenancy DEPOSIT documents (rental deposit + utilities deposit) drafted once per
  // tenancy on assignment. Default OFF ⇒ createTenancyDepositsForTenancy is a hard
  // no-op: no Invoice, no Charge, no document, and the assignment paths behave exactly
  // as they did before this flag existed.
  //
  // ON ⇒ a move-in whose START DATE falls in the org-local CURRENT month, on an
  // apartment that is under KAEN management, drafts two deposit charges priced from
  // the TENANCY's own monthly rent (never the listing's asking rate). They land in the
  // ordinary draft-approval queue; approving mints one DEPO- document per charge.
  // DEPO-, NOT DEP-: deposits have their OWN series. DEP is the shared pool that also
  // carries aircond + the four utility debit notes, and both label maps key on the
  // series PREFIX, so titling DEP "RENTAL DEPOSITS" would retitle every one of them.
  // Both routing paths agree on DEPO — the category path (tenancy_rental_deposit /
  // tenancy_utility_deposit both carry seriesCode "DEPO", seed-categories.ts) and the
  // classification path (DEFAULT_SERIES_FOR_CLASSIFICATION returns "DEPO" for
  // DEPOSIT_INVOICE + PAYABLE_TO_OWNER, series-mapping.ts).
  //
  // Deposits are REFUNDABLE — money held for the landlord, not KAEN revenue. They are
  // deliberately absent from every owner-ledger chargeType allow-list, so a deposit
  // never becomes owner income and is never remitted in that month's payout.
  //
  // HARD-DEPENDS on ENABLE_PHASE2_BILLING_DOCS for the document half: with that flag
  // off, approval leaves the charges `draft` and mints nothing (postApprovedInvoiceChargesTx
  // returns early). The drafts are still created and still correct — they simply have
  // no DEPO- document until billing-docs is on.
  "ENABLE_TENANCY_DEPOSIT_DOCS",
  // Proforma invoices (spec 2026-08-10). Default OFF ⇒ byte-identical to today: the
  // bills grid issues IVTEN- `invoice` documents, no graduation hook runs, and no
  // proforma exists anywhere.
  //
  // ON ⇒ the grid's TENANT-family group is issued as `docType: "proforma"` from the PI
  // series instead. The proforma is explicitly provisional — a request for payment the
  // workflow may replace whole — and carries no money weight. When a payment settles
  // charges that sit on a proforma, a REAL `invoice` is minted for exactly the paid
  // lines (stamping proformaDocumentId → the proforma, NEVER originalDocumentId), and
  // the existing receipt hook then finds that invoice and issues the RCPT.
  //
  // The OWNER side is untouched at any flag value: IVOWN- stays `docType: "invoice"`.
  // Extending this to the owner side requires making owner-ledger Source 6 revision-
  // aware first, which risks double-booking owner deductions — deliberately deferred.
  //
  // NO BACKFILL: every IVTEN- already in the database stays an `invoice`. Flipping the
  // flag changes only what NEW grid bills mint; the register looks unchanged on day one.
  //
  // HARD-DEPENDS on ENABLE_PHASE2_BILLING_DOCS — with that off the grid mints no
  // documents at all, so there is nothing to route to a proforma.
  "ENABLE_PROFORMA_INVOICES",
] as const;

export type Phase2Flag = (typeof PHASE2_FLAGS)[number];
