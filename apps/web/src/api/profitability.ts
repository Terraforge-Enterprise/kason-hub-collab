import { apiFetch } from "@/lib/api-client";

export type ProfitDetail = { id: string; date: string; month: string; chargeNumber: string; category: string; description: string; property: string; unit: string; tenancyCode: string | null; chargedBeforeSst: string; sst: string; actualCost: string | null; grossProfit: string | null; collectedProfit: string | null; outstandingProfit: string | null; missingCost: boolean; costPaymentStatus: string; status: string };
export type ProfitRow = { partyId: string; partyName: string; units: string[]; itemCount: number; chargesBeforeSst: string; actualCost: string; grossProfit: string; collectedProfit: string; outstandingProfit: string; missingCostCount: number; details: ProfitDetail[] };
export type ProfitabilityData = { view: "owner" | "tenant"; month: string | null; rows: ProfitRow[]; totals: { chargesBeforeSst: string; actualCost: string; grossProfit: string; collectedProfit: string; outstandingProfit: string; missingCostCount: number } };
export async function getProfitability(view: "owner" | "tenant", month: string, q: string) {
  const params = new URLSearchParams({ view, ...(month ? { month } : {}), ...(q ? { q } : {}) });
  return (await apiFetch<{ data: ProfitabilityData }>(`/profitability?${params}`)).data;
}
