import { Hono } from "hono";
import type { PortalEnv } from "../auth/portal.auth.types";
import { buildAgentHomeSummary, type AgentHomeDeps } from "./portal.agent-home.service";
import type { SalesUnitStatus } from "./portal.agent-home.types";
import { getSalesUnitsService } from "../../sales";
import { listClaimsService as listSalesClaimsService } from "../../sales-claims";
import { listClaimsService as listRenovationClaimsService } from "../../renovation-claims";
import { dashboardService } from "../commissions/portal.commissions.service";
import type { SalesUnitRow } from "../../sales/sales.types";
import type { SalesClaimRow } from "../../sales-claims/sales-claims.types";
import type { RenovationClaimRow } from "../../renovation-claims/renovation-claims.types";
import type { AdminRole } from "../../../lib/rbac";

// Local minimal session shape — matches the convention in
// portal.commissions.service.ts and portal.agent-home.service.ts.
type PortalSession = { userId: string; orgId: string; userType: string; partyId: string; role?: string };

// SYNC: This must match the web-side definitions verbatim. If you change either,
// update both.
//   - apps/web/src/api/portal-sales.ts: POST_APPROVAL_REBIND_NOTE
//   - apps/web/src/api/portal-sales.ts: deriveSalesUnitStatus
const POST_APPROVAL_REBIND_NOTE = "Edited by agent post-approval";
function deriveSalesUnitStatus(u: SalesUnitRow): SalesUnitStatus {
  if (u.sourcingApproved) return "approved";
  if (u.amendmentNotes === POST_APPROVAL_REBIND_NOTE) return "edited_post_approval";
  if (u.amendmentNotes && u.amendmentNotes.trim().length > 0) return "needs_amendment";
  return "pending_review";
}

function latest(...dates: Array<Date | string | null | undefined>): string {
  let best = 0;
  for (const d of dates) {
    if (!d) continue;
    const t = typeof d === "string" ? Date.parse(d) : d.getTime();
    if (Number.isFinite(t) && t > best) best = t;
  }
  return new Date(best || Date.now()).toISOString();
}

function unitToItem(u: SalesUnitRow) {
  return {
    id: u.id,
    status: deriveSalesUnitStatus(u),
    updatedAt: latest(u.updatedAt),
    unitNumber: u.unitNumber,
  };
}

function salesClaimToItem(c: SalesClaimRow) {
  return {
    id: c.id,
    status: c.status,
    totalAmount: c.computedAmount ?? 0,
    approvedAt: c.status === "approved" && c.reviewedAt ? c.reviewedAt.toISOString() : null,
    updatedAt: latest(c.reviewedAt, c.submittedAt),
    title: c.id.slice(0, 8),
  };
}

function renovationClaimToItem(c: RenovationClaimRow) {
  return {
    id: c.id,
    status: c.status,
    totalAmount: c.packagePrice ?? 0,
    approvedAt: c.status === "approved" && c.reviewedAt ? c.reviewedAt.toISOString() : null,
    updatedAt: latest(c.reviewedAt, c.submittedAt),
    title: c.id.slice(0, 8),
  };
}

function buildProductionDeps(): AgentHomeDeps {
  const editorRole: AdminRole = "editor";
  return {
    listSalesUnits: async (s: PortalSession) => {
      const r = await getSalesUnitsService(
        { orgId: s.orgId, role: editorRole },
        { agentPartyIdEq: s.partyId },
      );
      return { items: r.ok ? r.data.map(unitToItem) : [] };
    },
    listSalesClaims: async (s: PortalSession) => {
      const ctx = {
        orgId: s.orgId,
        actorUserId: s.userId,
        actorRole: editorRole,
        ip: undefined as string | undefined,
        userAgent: undefined as string | undefined,
      };
      const r = await listSalesClaimsService(ctx, { submittedByEq: s.userId }, { forceFullSelect: true });
      return { items: r.ok ? r.data.map(salesClaimToItem) : [] };
    },
    listRenovationClaims: async (s: PortalSession) => {
      const ctx = {
        orgId: s.orgId,
        actorUserId: s.userId,
        actorRole: editorRole,
        ip: undefined as string | undefined,
        userAgent: undefined as string | undefined,
      };
      const r = await listRenovationClaimsService(ctx, { submittedByEq: s.userId }, { forceFullSelect: true });
      return { items: r.ok ? r.data.map(renovationClaimToItem) : [] };
    },
    commissionsDashboard: async (s: PortalSession) => {
      const data = await dashboardService(s);
      return { summary: data.summary };
    },
    now: () => new Date(),
  };
}

/**
 * Factory pattern lets tests inject deps. Production binding lives below.
 */
export function createPortalAgentHomeRoutes(deps: AgentHomeDeps) {
  const app = new Hono<PortalEnv>();
  app.get("/summary", async (c) => {
    const session = c.get("session");
    const data = await buildAgentHomeSummary(session, deps);
    return c.json({ data });
  });
  return app;
}

export const portalAgentHomeRoutes = createPortalAgentHomeRoutes(buildProductionDeps());
