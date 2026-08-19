/**
 * Portal owner-statements route — OWN-DATA-ONLY (Task 2c-4).
 *
 * Mounted at /portal-api/owner (see portal/index.ts), so:
 *   GET /portal-api/owner/statements/:id/sections → { data: YannieSections }
 *
 * Mirrors the admin GET /owner-billing/statements/:id/sections, but owner-scoped:
 * the logged-in portal owner can read ONLY their OWN statement.
 *
 * Security (owner-privacy / money boundary):
 *   - portalUserTypeGuard("owner") (applied in portal/index.ts) restricts the
 *     surface to owner sessions; agents/tenants get 403.
 *   - ENABLE_PHASE2_OWNER_BILLING flag gate → 404 while the module is dark
 *     (canonical no-shape-leak, sibling owner-ledger precedent).
 *   - OWNERSHIP GUARD: the statement (Invoice) is loaded scoped to BOTH
 *     organizationId AND ownerPartyId === session.partyId. A statement that
 *     belongs to a different owner — or does not exist — yields an identical
 *     404 (no 403-vs-404 existence leak, never another owner's payload).
 *   - POST-ONLY GATE (defense-in-depth): owners may only read a statement that
 *     has been POSTED (sent/approved/paid/partial). Draft figures are still
 *     in flux; serving them risks disputes. The gate returns the identical
 *     { error: "not_found" } 404 — no status-leak, same shape as not-owned.
 *   - The assembler ctx is built from the SESSION, never from client input.
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getDb } from "@kason/db";
import type { PortalEnv, PortalSessionPayload } from "../auth/portal.auth.types";
import { ownerLedgerFlagGate } from "../../owner-ledger/owner-ledger.gate";
import { assembleYannieStatement, filterWebVisibleExpenses } from "../../owner-billing/owner-statement-sections";
import { isPhase2FlagEnabled } from "../../../lib/feature-flags";
import { listExpenseProofUrlsService } from "../../owner-billing/owner-expense-proof.service";
import { buildProofPackPdf } from "../../owner-billing/proof-pack.service";
import {
  resolveOwnerStatementsInRange,
  streamMonthRangeZip,
  validateExportRange,
} from "../../owner-billing/multi-month-export.service";
import { PORTAL_VISIBLE_STATEMENT_STATUSES } from "../../owner-billing/owner-statement-visibility";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

// POST-only visible statuses (sent/approved/paid/partial; draft/void excluded) now
// live in the shared owner-statement-visibility module — imported above so the
// portal reads + the multi-month export share ONE source of truth.

const portalOwnerStatementsRoutes = new Hono<PortalEnv>();

// Flag gate: 404 while ENABLE_PHASE2_OWNER_BILLING is dark (no shape leak).
portalOwnerStatementsRoutes.use("*", ownerLedgerFlagGate);

/** The proof scope a gated statement resolves to (owner is always the session owner). */
interface VisibleStatement {
  id: string;
  /** First-of-month UTC billing period, or null for a legacy statement (→ 404). */
  periodMonth: Date | null;
  /** Per-apartment scope (Invoice.apartmentId); null = legacy combined statement. */
  apartmentId: string | null;
}

/**
 * Load a statement the SESSION owner is allowed to see, applying BOTH guards in one
 * place (shared by the sections + proof reads so they can never drift):
 *   - OWNERSHIP: organizationId === session.orgId AND ownerPartyId === session.partyId
 *     (cross-owner / cross-org / unknown → not matched).
 *   - POST-ONLY: status ∈ PORTAL_VISIBLE_STATEMENT_STATUSES (a draft/void month is
 *     still in flux — owners must not pull in-flux figures OR their evidence).
 * Returns null for ANY failure so every caller emits the IDENTICAL { error:
 * "not_found" } 404 — no 403-vs-404 / status / existence leak.
 */
async function loadVisibleOwnerStatement(
  session: PortalSessionPayload,
  statementId: string,
): Promise<VisibleStatement | null> {
  const owned = await getDb().invoice.findFirst({
    where: {
      id: statementId,
      organizationId: session.orgId,
      ownerPartyId: session.partyId,
      invoiceType: "owner_statement",
    },
    select: { id: true, status: true, periodMonth: true, apartmentId: true },
  });
  if (!owned) return null;
  if (!PORTAL_VISIBLE_STATEMENT_STATUSES.has(owned.status)) return null;
  return { id: owned.id, periodMonth: owned.periodMonth, apartmentId: owned.apartmentId };
}

/** "YYYY-MM" from a first-of-month UTC Date (the proof store's keyed month). */
function monthKey(periodMonth: Date): string {
  return periodMonth.toISOString().slice(0, 7);
}

/**
 * Build the owner-billing ctx from the SESSION (never client input). The downstream
 * reads use only ctx.orgId; actorRole is an unused least-privilege placeholder
 * (portal owners are not admins) — mirrors the agent-home portal precedent of
 * synthesizing an AdminRole to call a shared admin-shaped fn.
 */
function portalCtx(session: PortalSessionPayload): OwnerBillingActorCtx {
  return { orgId: session.orgId, actorUserId: session.userId, actorRole: "editor" };
}

// ─── GET /statements/:id/sections ─────────────────────────────────────────────

portalOwnerStatementsRoutes.get("/statements/:id/sections", async (c) => {
  const session = c.get("session");
  const statementId = c.req.param("id");

  // Owner-scoped + POST-only gate (shared helper). Any failure → identical 404.
  const stmt = await loadVisibleOwnerStatement(session, statementId);
  if (!stmt) return c.json({ error: "not_found" }, 404);

  const sections = await assembleYannieStatement(portalCtx(session), statementId);
  if (!sections) {
    // Statement exists but cannot be assembled (no owner/period) — 404.
    return c.json({ error: "not_found" }, 404);
  }

  // WEB-ONLY expense visibility (money-visibility). Flag OFF ⇒ same expense rows as
  // before (plus an inert additive `sourceType` field). Flag ON ⇒ the owner sees only tenant-recharge
  // utilities the tenant fully paid; owner-borne costs are hidden here. This is the
  // portal JSON surface ONLY — the owner PDF and the /statements/export ZIP
  // re-assemble their own sections and ALWAYS show every expense.
  const data = isPhase2FlagEnabled("ENABLE_OWNER_WEB_EXPENSE_HIDE")
    ? filterWebVisibleExpenses(sections)
    : sections;

  return c.json({ data });
});

// ─── GET /statements/:id/proofs — owner-scoped, POST-only (C2) ────────────────
// The supporting BILLS for a statement, grouped by category with short-lived
// signed (inline) view URLs. Owner-scoped + POST-only via the SAME gate as the
// sections read above: a draft month, another owner's statement, an unknown id, or
// a cross-org statement all return the identical { error: "not_found" } 404. The
// owner is ALWAYS the session owner — never client input — and the (month,
// apartment) proof scope is derived from the trusted gated Invoice.
portalOwnerStatementsRoutes.get("/statements/:id/proofs", async (c) => {
  const session = c.get("session");
  const stmt = await loadVisibleOwnerStatement(session, c.req.param("id"));
  if (!stmt || !stmt.periodMonth) return c.json({ error: "not_found" }, 404);

  const result = await listExpenseProofUrlsService(
    portalCtx(session),
    session.partyId,
    monthKey(stmt.periodMonth),
    stmt.apartmentId,
  );
  if (!result.ok) return c.json({ error: "not_found" }, 404);
  return c.json({ data: result.data });
});

// ─── GET /statements/:id/proof-pack — owner-scoped, POST-only (C2) ────────────
// The merged proof-pack PDF (C1) for the statement's (owner, month, apartment),
// streamed as application/pdf. Same gate as above; null pack (no usable bills) →
// 404. Owner forced to the session owner; scope from the trusted gated Invoice.
portalOwnerStatementsRoutes.get("/statements/:id/proof-pack", async (c) => {
  const session = c.get("session");
  const stmt = await loadVisibleOwnerStatement(session, c.req.param("id"));
  if (!stmt || !stmt.periodMonth) return c.json({ error: "not_found" }, 404);

  const bytes = await buildProofPackPdf(
    portalCtx(session),
    session.partyId,
    monthKey(stmt.periodMonth),
    stmt.apartmentId,
  );
  if (!bytes) return c.json({ error: "not_found" }, 404);

  const filename = `proof-pack-${monthKey(stmt.periodMonth)}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ─── GET /statements/export — owner-scoped, POST-only multi-month ZIP (D1) ────
// Stream a ZIP of THIS owner's CLEAN statement PDFs across [fromMonth, toMonth]
// (includeProof=1 also bundles each month's separate proof pack). The owner is
// ALWAYS the SESSION owner — never a client param — so owner B can never pull owner
// A's statements (B's empty range → identical 404). Range capped ≤24 months AND
// from ≤ to (else 400); only POST-only statements are included (drafts/void
// excluded via the shared status set). Flag-dark → 404 via the module gate above.
portalOwnerStatementsRoutes.get("/statements/export", async (c) => {
  const session = c.get("session");
  const fromMonth = c.req.query("fromMonth") ?? "";
  const toMonth = c.req.query("toMonth") ?? "";
  const includeProof = c.req.query("includeProof") === "1" || c.req.query("includeProof") === "true";

  const range = validateExportRange(fromMonth, toMonth);
  if (!range.ok) return c.json({ error: range.error }, 400);

  // Owner FORCED to the session owner (never client input). An owner with no
  // POST-only statements in range (incl. another owner's data) → identical 404.
  const ownerPartyId = session.partyId;
  const statements = await resolveOwnerStatementsInRange(portalCtx(session), ownerPartyId, fromMonth, toMonth);
  if (statements.length === 0) return c.json({ error: "not_found" }, 404);

  c.header("Content-Type", "application/zip");
  c.header("Content-Disposition", `attachment; filename="owner-statements-${fromMonth}_to_${toMonth}.zip"`);
  return stream(c, async (s) => {
    await streamMonthRangeZip(portalCtx(session), { ownerPartyId, fromMonth, toMonth, includeProof }, s);
  });
});

export { portalOwnerStatementsRoutes };
