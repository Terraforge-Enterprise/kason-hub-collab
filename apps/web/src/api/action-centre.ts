import { apiFetch } from "@/lib/api-client";

export type ActionCategory = "billing" | "collections" | "costs" | "bank" | "payout";
export type ActionSeverity = "critical" | "warning" | "review";
export type ActionCentreItem = {
  id: string; category: ActionCategory; title: string; description: string;
  severity: ActionSeverity; count: number; amount: number | null; href: string; cta: string;
  breakdown: Array<{ id: string; label: string; detail: string; amount: number | null }>;
};
export type ActionCentreData = {
  generatedAt: string; periodMonth: string;
  summary: { total: number; critical: number; warning: number; review: number };
  items: ActionCentreItem[];
};

export async function getActionCentre() {
  return (await apiFetch<{ data: ActionCentreData }>("/dashboard/actions")).data;
}
