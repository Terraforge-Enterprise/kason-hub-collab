import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import type { AgentListItem } from "./agents-table";

/**
 * Full-detail shape returned by `GET /parties/agents/:id`. Mirrors the
 * server's `getAgentDetailService` response — kept in sync with
 * `apps/api/src/modules/parties/parties.service.ts`. The agent list query
 * (`GET /parties/agents`) returns a slim subset that drives the table; any
 * drawer that submits a PATCH must fetch via this hook so that fields the
 * user has not edited keep their server values in the optimistic cache.
 */
export type AgentDetail = {
  id: string;
  displayName: string;
  legalName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  /**
   * API-pre-formatted display value (e.g. "+60 12-345 6789"). Falls back to
   * `primaryPhone` for legacy/un-backfilled rows. See `getAgentDetailService`.
   */
  formattedPhone: string | null;
  idType: string | null;
  idNumber: string | null;
  nationality: string | null;
  agentLevel: string | null;
  bank: {
    name: string | null;
    accountHolder: string | null;
    accountNumber: string | null;
  };
  status: string;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  portalUser: {
    id: string;
    email: string;
    lastLoginAt: string | null;
    status: string;
    updatedAt: string;
  } | null;
  claimStats?: {
    submitted: number;
    approved: number;
    paid: number;
    rejected: number;
    totalPaidCommission: number;
  };
  uplineId?: string | null;
  upline?: { id: string; displayName: string; agentLevel: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Project the slim list-row shape onto the full-detail shape so we can
 * pre-fill the form instantly while the network request is in flight.
 * This is a *placeholder* — the real detail will overwrite once it lands.
 */
function projectListItemAsDetail(item: AgentListItem): AgentDetail {
  return {
    id: item.id,
    displayName: item.displayName,
    legalName: item.legalName,
    primaryEmail: item.primaryEmail,
    primaryPhone: item.primaryPhone,
    formattedPhone: item.formattedPhone,
    idType: item.idType,
    idNumber: item.idNumber,
    nationality: item.nationality,
    agentLevel: item.agentLevel,
    bank: {
      name: item.bankName,
      accountHolder: item.bankAccountHolder,
      accountNumber: item.bankAccountNumber,
    },
    status: item.status,
    isBlacklisted: item.isBlacklisted,
    blacklistReason: null,
    portalUser: item.portalUser
      ? {
          id: item.portalUser.id,
          email: item.portalUser.email,
          status: item.portalUser.status,
          updatedAt: item.portalUser.updatedAt,
          lastLoginAt: null,
        }
      : null,
    uplineId: item.uplineId ?? null,
    upline: item.upline
      ? { ...item.upline, agentLevel: null }
      : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Fetches the full agent record. Form drawers that PATCH an agent MUST use
 * this hook — the list query returns a subset, and pre-filling a PATCH
 * payload from the slim row guarantees fields-not-in-the-list get blanked
 * out on the server. The `placeholder` argument feeds `placeholderData` so
 * the UI never flashes empty: the slim row paints first, the full record
 * overwrites once it arrives.
 */
export function useAgentDetail(
  id: string | undefined,
  placeholder?: AgentListItem,
) {
  return useQuery<AgentDetail>({
    queryKey: ["parties", "agents", id],
    queryFn: async () => {
      const res = await apiFetch<{ data: AgentDetail }>(
        `/parties/agents/${id}`,
      );
      return res.data;
    },
    enabled: !!id,
    staleTime: 30_000,
    placeholderData: placeholder ? projectListItemAsDetail(placeholder) : undefined,
  });
}
