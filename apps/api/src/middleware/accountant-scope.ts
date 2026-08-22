import { createMiddleware } from "hono/factory";
import type { SessionPayload } from "../lib/auth";

// Exact (method, path-matcher) allowlist. The accountant is DEFAULT-DENIED on
// every /api/* route except these. Extended per plan as accounting surfaces are
// built: P2 (receipt reads ride the existing GET /api/billing-documents rules),
// P3 (POST /api/payments/record-and-allocate, GET /api/payments/:id/proof-urls,
// POST /api/billing-documents/invoices, POST/DELETE /api/billing-documents/refund-proofs),
// P4 (POST /api/billing-documents/credit-notes). Keep this list EXACT — a bare
// "/api/payments" prefix would leak reverse/status/post/fpx-cancel.
type Rule = { method: string; test: (path: string) => boolean };

const prefix = (method: string, base: string): Rule => ({
  method,
  test: (p) => p === base || p.startsWith(base + "/"),
});
const exact = (method: string, path: string): Rule => ({ method, test: (p) => p === path });

export const ACCOUNTING_ALLOW: Rule[] = [
  // Documents register + detail + pdf (P1; receipts list through the same routes in P2)
  prefix("GET", "/api/billing-documents"),
  exact("GET", "/api/charge-categories"),
  // P3: the invoice-create form's series/category dropdowns.
  exact("GET", "/api/charge-categories/series"),
  prefix("GET", "/api/dashboard"),
  // Finance owns import/final reconciliation. These routes still pass through
  // their own capability middleware; this wall only allows them to reach it.
  prefix("GET", "/api/bank-reconciliation"),
  prefix("GET", "/api/profitability"),
  exact("POST", "/api/bank-reconciliation/accounts"),
  exact("POST", "/api/bank-reconciliation/imports"),
  exact("POST", "/api/bank-reconciliation/imports/preview"),
  { method: "PATCH", test: (p: string) => /^\/api\/bank-reconciliation\/transactions\/[^/]+\/categorize$/.test(p) },
  // Read-only filing export: documents, charges, payments, expenses, owner ledger
  // and bank movements. The route itself is accounting-workspace gated.
  exact("GET", "/api/accounting-export/all-transactions.xlsx"),
  // P3 record-and-allocate (Transfer-from-Invoice). EXACT — a bare /api/payments
  // prefix would leak reverse/status/post/fpx-cancel.
  exact("POST", "/api/payments/record-and-allocate"),
  // P3 slip proof-urls: GET /api/payments/:id/proof-urls. Prefix-safe because the
  // ONLY /api/payments/*/proof-urls route is this read; the mutating siblings are
  // /reverse, /status, /post — different terminal segments, never matched here.
  { method: "GET", test: (p: string) => /^\/api\/payments\/[^/]+\/proof-urls$/.test(p) },
  // P3 manual invoice create + slip refund-proof upload/cleanup.
  exact("POST", "/api/billing-documents/invoices"),
  exact("POST", "/api/billing-documents/refund-proofs"),
  exact("DELETE", "/api/billing-documents/refund-proofs"),
  // P4 (spec R12): manual overpayment Credit Note create. Row-locked + idempotent
  // in overpayment-cn.service; the CN flows into the existing apply-credit path.
  exact("POST", "/api/billing-documents/credit-notes"),
  // Phase 3.1: charge-scoped CREATE credit/debit note (partial amounts), tenant-only.
  // Row-locked + idempotent in charge-adjustment.service, mirroring the credit-notes rule.
  exact("POST", "/api/billing-documents/charge-adjustments"),
  // Phase 4.1: VOID a charge-scoped credit/debit note, tenant-only, safe-default BLOCK.
  // Anchored-regex (NOT prefix) — a bare /api/billing-documents prefix would leak :id
  // reads, /pdf, /apply-credit, /invoices, /credit-notes, /refund-proofs.
  { method: "POST", test: (p: string) => /^\/api\/billing-documents\/[^/]+\/void$/.test(p) },
  // Phase-2 owner-remittance (Task 6): GC8 authz admits the accounting
  // workspace for POST /owner-remittances — the router's own
  // requireWorkspaceOrRank("accounting","manager") already grants an
  // accountant via the workspace path; without this entry the request never
  // reaches that check (default-denied at this wall first).
  exact("POST", "/api/owner-remittances"),
  // Phase-2 owner-remittance (Task 7): later allocation of a
  // PRE_STATEMENT_REMITTANCE. A DIFFERENT literal path from the exact rule
  // above (exact() matches ONLY "/api/owner-remittances", never its
  // sub-paths) — anchored regex, not prefix, matching the void/reverse/
  // status precedent above.
  { method: "POST", test: (p: string) => /^\/api\/owner-remittances\/[^/]+\/allocate$/.test(p) },
  // Phase-2 owner-remittance (Task 8): POST /owner-receivable-offsets — a
  // DIFFERENT literal base path from /api/owner-remittances (exact() matches
  // only that ONE path above, never this one). Same GC8 rationale as Task 6's
  // entry: the router's own requireWorkspaceOrRank("accounting","manager")
  // already grants an accountant via the workspace path; without this entry
  // the request never reaches that check (default-denied at this wall first).
  exact("POST", "/api/owner-receivable-offsets"),
  // Phase-2 owner-remittance (Task 9): append-only reversal of a remittance
  // or an offset. TWO DIFFERENT literal base paths (mirrors Task 6/8's own
  // exact() entries above) — anchored regex, POST-only, terminal /reverse
  // segment, same shape as Task 7's /:id/allocate entry (NOT a bare prefix,
  // which would leak any future GET/PATCH sub-route under /:id).
  { method: "POST", test: (p: string) => /^\/api\/owner-remittances\/[^/]+\/reverse$/.test(p) },
  { method: "POST", test: (p: string) => /^\/api\/owner-receivable-offsets\/[^/]+\/reverse$/.test(p) },
  // Phase-2 owner-remittance (Task 10): read-only owner-account view. GET,
  // unlike every entry above — the wall fires on (method, path) for ALL
  // methods, not just POST, so this needs its OWN entry even though the
  // router's own requireWorkspaceOrRank("accounting","manager") already
  // grants an accountant via the workspace path. Anchored regex, GET-only,
  // mirrors the /:id/allocate and /:id/reverse entries' shape exactly — NOT
  // a bare prefix (this file's own header warns against exactly that leak).
  { method: "GET", test: (p: string) => /^\/api\/owner-remittances\/owner\/[^/]+$/.test(p) },
  // Phase-1 correctness (R9): void-correction + append-only allocation-reverse + payment-void/status.
  // Anchored-regex, NOT prefix — a bare /api/payments or /api/billing/charges would leak :id reads,
  // bare create, /post, apply-credit, fpx-cancel.
  { method: "POST", test: (p: string) => /^\/api\/billing\/charges\/[^/]+\/void$/.test(p) },
  { method: "POST", test: (p: string) => /^\/api\/payments\/[^/]+\/allocations\/[^/]+\/reverse$/.test(p) },
  { method: "PUT", test: (p: string) => /^\/api\/payments\/[^/]+\/status$/.test(p) },
];

export const accountantScope = createMiddleware<{ Variables: { session: SessionPayload } }>(
  async (c, next) => {
    const session = c.get("session");
    if (session?.role !== "accountant") return next(); // only scopes the accountant
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    const allowed = ACCOUNTING_ALLOW.some((r) => r.method === method && r.test(path));
    if (!allowed) return c.json({ error: "workspace_forbidden" }, 403);
    return next();
  },
);
