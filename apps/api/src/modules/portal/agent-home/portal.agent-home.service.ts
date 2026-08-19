import type {
  AgentHomeDomain,
  AgentHomeFeedRow,
  AgentHomeSummary,
  SalesUnitStatus,
} from "./portal.agent-home.types";
import type { SalesClaimStatus } from "../../sales-claims/sales-claims.types";
import type { RenovationClaimStatus } from "../../renovation-claims/renovation-claims.types";

// Minimal session shape required by this service. Matches the local convention
// used in portal.commissions.service.ts — the structural subset of
// PortalSessionPayload that downstream domain services actually consume.
type PortalSession = { userId: string; orgId: string; userType: string; partyId: string; role?: string };

interface SalesUnitLike {
  id: string;
  status: SalesUnitStatus;
  updatedAt: string;
  unitNumber: string;
}

interface SalesClaimLike {
  id: string;
  status: SalesClaimStatus;
  updatedAt: string;
  totalAmount: number;
  approvedAt: string | null;
  title: string;
}

interface RenovationClaimLike {
  id: string;
  status: RenovationClaimStatus;
  updatedAt: string;
  totalAmount: number;
  approvedAt: string | null;
  title: string;
}

export interface AgentHomeDeps {
  listSalesUnits: (s: PortalSession) => Promise<{ items: SalesUnitLike[] }>;
  listSalesClaims: (s: PortalSession) => Promise<{ items: SalesClaimLike[] }>;
  listRenovationClaims: (s: PortalSession) => Promise<{ items: RenovationClaimLike[] }>;
  commissionsDashboard: (s: PortalSession) => Promise<{
    summary: { totalEarned: number; thisMonthEarned: number; thisYearEarned: number; submitted: number };
  }>;
  now: () => Date;
}

const SALES_UNIT_PENDING: ReadonlySet<string> = new Set(["needs_amendment"]);
const CLAIM_PENDING: ReadonlySet<string> = new Set(["needs_amendment", "rejected"]);

function isSameMonth(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

function tally<S extends string, T extends { status: S }>(items: T[]): Partial<Record<S, number>> {
  const counts = {} as Partial<Record<S, number>>;
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return counts;
}

function toFeedRow(domain: AgentHomeDomain, item: { id: string; updatedAt: string }, label: string, href: string): AgentHomeFeedRow {
  return { domain, id: item.id, label, href, updatedAt: item.updatedAt };
}

const makePipelineRow = (u: SalesUnitLike): AgentHomeFeedRow =>
  toFeedRow("pipeline", u, `Sales unit ${u.unitNumber} — ${u.status}`, `/portal/sales-pipeline?unit=${u.id}`);

const makeSalesClaimRow = (c: SalesClaimLike): AgentHomeFeedRow =>
  toFeedRow("sales-claim", c, `Sales claim ${c.title} — ${c.status}`, `/portal/sales-claims?id=${c.id}`);

const makeRenovationClaimRow = (c: RenovationClaimLike): AgentHomeFeedRow =>
  toFeedRow("renovation-claim", c, `Renovation claim ${c.title} — ${c.status}`, `/portal/renovation-claims?id=${c.id}`);

export async function buildAgentHomeSummary(
  session: PortalSession,
  deps: AgentHomeDeps,
): Promise<AgentHomeSummary> {
  const errors: AgentHomeDomain[] = [];
  const settled = await Promise.allSettled([
    deps.listSalesUnits(session),
    deps.listSalesClaims(session),
    deps.listRenovationClaims(session),
    deps.commissionsDashboard(session),
  ]);
  const [unitsR, salesR, renoR, commR] = settled;

  const now = deps.now();

  let pipeline: AgentHomeSummary["pipeline"] = null;
  let pipelinePending: AgentHomeFeedRow[] = [];
  let pipelineActivity: AgentHomeFeedRow[] = [];
  if (unitsR.status === "fulfilled") {
    const items = unitsR.value.items;
    pipeline = { counts: tally(items) };
    pipelineActivity = items.map(makePipelineRow);
    pipelinePending = items.filter((u) => SALES_UNIT_PENDING.has(u.status)).map(makePipelineRow);
  } else {
    errors.push("pipeline");
  }

  let salesClaims: AgentHomeSummary["salesClaims"] = null;
  let salesPending: AgentHomeFeedRow[] = [];
  let salesActivity: AgentHomeFeedRow[] = [];
  if (salesR.status === "fulfilled") {
    const items = salesR.value.items;
    salesClaims = {
      counts: tally(items),
      approvedThisMonth: items
        .filter((c) => c.status === "approved" && isSameMonth(c.approvedAt, now))
        .reduce((s, c) => s + c.totalAmount, 0),
    };
    salesActivity = items.map(makeSalesClaimRow);
    salesPending = items.filter((c) => CLAIM_PENDING.has(c.status)).map(makeSalesClaimRow);
  } else {
    errors.push("sales-claim");
  }

  let renovationClaims: AgentHomeSummary["renovationClaims"] = null;
  let renoPending: AgentHomeFeedRow[] = [];
  let renoActivity: AgentHomeFeedRow[] = [];
  if (renoR.status === "fulfilled") {
    const items = renoR.value.items;
    renovationClaims = {
      counts: tally(items),
      approvedThisMonth: items
        .filter((c) => c.status === "approved" && isSameMonth(c.approvedAt, now))
        .reduce((s, c) => s + c.totalAmount, 0),
    };
    renoActivity = items.map(makeRenovationClaimRow);
    renoPending = items.filter((c) => CLAIM_PENDING.has(c.status)).map(makeRenovationClaimRow);
  } else {
    errors.push("renovation-claim");
  }

  let commission: AgentHomeSummary["commission"] = null;
  if (commR.status === "fulfilled") {
    commission = {
      earnedThisMonth: commR.value.summary.thisMonthEarned,
      submittedPending: commR.value.summary.submitted,
    };
  } else {
    errors.push("commission");
  }

  const pendingActions = [...pipelinePending, ...salesPending, ...renoPending]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const recentActivity = [...pipelineActivity, ...salesActivity, ...renoActivity]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);

  return { pendingActions, pipeline, salesClaims, renovationClaims, commission, recentActivity, errors };
}
