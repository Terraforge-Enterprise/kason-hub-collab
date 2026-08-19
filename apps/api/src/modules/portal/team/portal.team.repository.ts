import { getDb } from "@kason/db";
import type {
  PortalTeamResponse,
  PortalTeamCard,
  PortalUplineChainResponse,
  PortalUplineNode,
  PortalDownlinesResponse,
  PortalDownlineNode,
} from "./portal.team.types";

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  return `${email.slice(0, atIdx)}@***`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  // If we don't have at least 10 digits, return no digits — avoids leaking
  // short/partial/test numbers in full.
  if (digits.length < 10) return "··";
  return `·· ${digits.slice(-4)}`;
}

function toCard(p: {
  id: string; displayName: string; agentLevel: string | null;
  primaryEmail: string | null; primaryPhone: string | null;
}): PortalTeamCard {
  return {
    id: p.id,
    displayName: p.displayName,
    agentLevel: p.agentLevel,
    emailMasked: maskEmail(p.primaryEmail),
    phoneMasked: maskPhone(p.primaryPhone),
  };
}

export async function getPortalTeam(partyId: string, orgId: string): Promise<PortalTeamResponse> {
  const db = getDb();

  // Single query — upline and downlines come back in one round-trip via nested select.
  const me = await db.party.findFirst({
    where: { id: partyId, organizationId: orgId },
    select: {
      id: true,
      uplineId: true,
      upline: {
        select: { id: true, displayName: true, agentLevel: true,
                  primaryEmail: true, primaryPhone: true, status: true },
      },
      downlines: {
        where: { status: { not: "blacklisted" }, partyType: "agent" },
        select: { id: true, displayName: true, agentLevel: true,
                  primaryEmail: true, primaryPhone: true },
        orderBy: { displayName: "asc" },
      },
    },
  });

  if (!me) return { upline: null, directDownlines: [] };

  // If the caller's upline has been blacklisted, hide it from the portal — the
  // agent shouldn't see a blacklisted parent's contact. Admin will reassign.
  const uplineVisible = me.upline && me.upline.status !== "blacklisted";

  return {
    upline: uplineVisible ? toCard(me.upline!) : null,
    directDownlines: me.downlines.map(toCard),
  };
}

// ── Splittable-agents typeahead ─────────────────────────────────────────────
//
// Returns the slim list of agents that the caller can name on a claim split:
// self + full upline chain + direct downlines, deduplicated, name-sorted.
// Used by the portal sales-claims and renovation-claims drawers to wire a
// real `partyPartyId` FK on each split row instead of free-text only.
//
// Privacy: ids + display names + agent levels only. No contact info — a
// claim form doesn't need it, and the team page exposes contact via a
// separate, clearly-scoped endpoint.
//
// Scope choice: limiting the picker to upline + self + direct downlines
// matches how commission splits work in practice (you share with people
// you actually work with). External collaborators can still be entered as
// free text — `partyPartyId` is optional in the schema, `partyDisplayName`
// remains required.

export type SplittableAgent = {
  id: string;
  displayName: string;
  agentLevel: string | null;
};

export async function listSplittableAgents(
  partyId: string,
  orgId: string,
): Promise<SplittableAgent[]> {
  const db = getDb();

  // Self + upline chain via the same recursive CTE getPortalUplineChain
  // uses; depth-cap 20 to be safe against legacy cycles.
  const uplineRows = await db.$queryRawUnsafe<
    { id: string; displayName: string; agentLevel: string | null }[]
  >(
    `
    WITH RECURSIVE chain AS (
      SELECT "id", "displayName", "agentLevel", "uplineId"
      FROM "Party"
      WHERE "id"::text = $2 AND "organizationId"::text = $1
        AND "partyType" = 'agent' AND "status" != 'blacklisted'
      UNION
      SELECT p."id", p."displayName", p."agentLevel", p."uplineId"
      FROM "Party" p
      JOIN chain c ON c."uplineId" = p."id"
      WHERE p."organizationId"::text = $1
        AND p."partyType" = 'agent' AND p."status" != 'blacklisted'
    )
    SELECT "id", "displayName", "agentLevel"
    FROM chain
    LIMIT 50
    `,
    orgId,
    partyId,
  );

  const downlineRows = await db.party.findMany({
    where: {
      organizationId: orgId,
      uplineId: partyId,
      partyType: "agent",
      status: { not: "blacklisted" },
    },
    select: { id: true, displayName: true, agentLevel: true },
  });

  // Dedupe by id (self could appear in both halves of a malformed graph)
  // and sort by displayName for a stable picker order.
  const byId = new Map<string, SplittableAgent>();
  for (const r of uplineRows) byId.set(r.id, r);
  for (const r of downlineRows) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

// ── Upline chain ────────────────────────────────────────────────────────────
//
// Walk from `partyId` UP to the org root and return the chain root-first.
// The portal renders this as a vertical org-chart "breadcrumb" — see
// apps/web/src/pages/portal/team/portal-team-page.tsx.
//
// Why not just reuse parties.repository.getAncestors? That function is in the
// admin (parties) module and excludes the caller themselves from the chain
// (it walks via uplineId only). The portal needs the *self* node included,
// because it's the leaf and gets highlighted. We use the same recursive-CTE
// shape for cycle-safety + depth cap.

type ChainRow = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  uplineId: string | null;
  depth: number;
};

export async function getPortalUplineChain(
  partyId: string,
  orgId: string,
): Promise<PortalUplineChainResponse | null> {
  const db = getDb();

  // Recursive CTE: start at self (depth 0), walk up via uplineId, depth-cap 20.
  // UNION (not UNION ALL) so any malformed cycle in legacy data dedupes itself
  // instead of exploding row counts.
  const rows = await db.$queryRawUnsafe<ChainRow[]>(
    `
    WITH RECURSIVE chain AS (
      SELECT "id", "displayName", "agentLevel", "uplineId", 0 AS depth
      FROM "Party"
      WHERE "id"::text = $2 AND "organizationId"::text = $1
        AND "partyType" = 'agent'
      UNION
      SELECT p."id", p."displayName", p."agentLevel", p."uplineId", c.depth + 1
      FROM "Party" p
      JOIN chain c ON c."uplineId" = p."id"
      WHERE p."organizationId"::text = $1 AND p."partyType" = 'agent' AND c.depth < 20
    )
    SELECT "id", "displayName", "agentLevel", "uplineId", depth
    FROM chain
    ORDER BY depth DESC
    `,
    orgId,
    partyId,
  );

  // Caller doesn't exist in this org as an agent — surface that distinctly.
  if (rows.length === 0) return null;

  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true },
  });

  if (!org) return null;

  // rows are already root-first (highest depth first → depth 0 last). The
  // depth-0 node is the caller — flag it so the UI can highlight it.
  const chain: PortalUplineNode[] = rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    agentLevel: r.agentLevel,
    isSelf: r.id === partyId,
  }));

  return {
    organization: { id: org.id, name: org.name },
    chain,
  };
}

// ── Downline subtree ────────────────────────────────────────────────────────
//
// Recursive walk DOWN from `partyId` via the uplineId graph, returning every
// agent in the caller's subtree as a flat list. Used by the portal "My Team"
// page so Leaders/Pre-Leaders can see and contact everyone below them.
//
// Why full contact info here (vs masked on /team)? Leaders need to actually
// reach their team — masking phones for the person who is supposed to be
// managing them would be backwards. The legacy /team endpoint that masks
// fields is unused by the current portal UI and stays around for back-compat.
//
// Cycle safety: UNION (not UNION ALL) so any malformed cycle dedupes itself,
// plus an explicit depth cap of 20.

type SubtreeRow = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  uplineId: string;
  depth: number;
};

export async function getPortalDownlineSubtree(
  partyId: string,
  orgId: string,
): Promise<PortalDownlinesResponse> {
  const db = getDb();

  const rows = await db.$queryRawUnsafe<SubtreeRow[]>(
    `
    WITH RECURSIVE tree AS (
      -- Level 1: direct downlines of the caller.
      SELECT p."id", p."displayName", p."agentLevel",
             p."primaryEmail", p."primaryPhone",
             p."uplineId", 1 AS depth
      FROM "Party" p
      WHERE p."organizationId"::text = $1
        AND p."uplineId"::text = $2
        AND p."partyType" = 'agent'
        AND p."status" != 'blacklisted'
      UNION
      -- Subsequent levels: anyone whose upline is already in the tree.
      SELECT p."id", p."displayName", p."agentLevel",
             p."primaryEmail", p."primaryPhone",
             p."uplineId", t.depth + 1
      FROM "Party" p
      JOIN tree t ON p."uplineId" = t."id"
      WHERE p."organizationId"::text = $1
        AND p."partyType" = 'agent'
        AND p."status" != 'blacklisted'
        AND t.depth < 20
    )
    SELECT "id", "displayName", "agentLevel",
           "primaryEmail", "primaryPhone",
           "uplineId", depth
    FROM tree
    ORDER BY depth ASC, "displayName" ASC
    `,
    orgId,
    partyId,
  );

  const downlines: PortalDownlineNode[] = rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    agentLevel: r.agentLevel,
    primaryEmail: r.primaryEmail,
    primaryPhone: r.primaryPhone,
    uplineId: r.uplineId,
    depth: Number(r.depth),
  }));

  return { downlines };
}
