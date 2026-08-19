// Section 3 — Payout Summary
// Shows the waterfall lines (gross rental → deductions → net) and highlights
// the final net payout to owner in a prominent GlowCard figure.
import { DollarSign, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { formatRM } from "@/components/format";
import type { YannieSections } from "@/api/owner-ledger";

interface Props {
  data: YannieSections["payoutSummary"];
}

export function StatementSectionPayoutSummary({ data }: Props) {
  // DEV guard: required fields per frontend-design rule #16
  if (import.meta.env.DEV) {
    if (data.netPayoutToOwner === undefined)
      console.warn("[owner-statement/payout-summary] missing netPayoutToOwner from API response");
    if (data.lines === undefined)
      console.warn("[owner-statement/payout-summary] missing lines from API response");
  }

  const net = Number(data.netPayoutToOwner);
  const isNegative = !isNaN(net) && net < 0;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2" id="section-heading-payout">
          <TrendingUp className="h-5 w-5 text-primary" />
          Payout Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Waterfall lines */}
        <div className="rounded-lg border border-border/50 bg-background/40 overflow-hidden">
          <div className="divide-y divide-border/30">
            {data.lines.map((line, i) => {
              const amount = Number(line.amount);
              const isDeduction = !isNaN(amount) && amount < 0;
              const isTotal = line.isTotal;
              return (
                <div
                  key={`payout-line-${i}`}
                  className={`flex items-center justify-between px-4 py-3 ${isTotal ? "bg-background/60 font-bold" : ""}`}
                >
                  <span
                    className={`text-sm ${isTotal ? "font-bold text-foreground" : "text-muted-foreground"}`}
                  >
                    {line.label}
                    {line.isNonIncome && (
                      <span className="ml-2 text-xs text-muted-foreground">(non-income)</span>
                    )}
                  </span>
                  <span
                    className={`text-sm tabular-nums font-semibold ${
                      isDeduction
                        ? "text-rose-600 dark:text-rose-400"
                        : isTotal
                          ? "text-amber-600 dark:text-amber-500 text-base"
                          : "text-emerald-600 dark:text-emerald-500"
                    }`}
                  >
                    {formatRM(Math.abs(isNaN(amount) ? 0 : amount))}
                    {isDeduction && <span className="ml-0.5 text-xs">(deducted)</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Net payout highlight card */}
        <GlowCard
          glowColor="gold"
          className="p-5 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Net Payout to Owner</p>
              <p
                className={`text-3xl font-bold tabular-nums ${
                  isNegative ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-500"
                }`}
              >
                {isNaN(net) ? "RM 0.00" : formatRM(net)}
              </p>
              {isNegative && (
                <p className="text-xs text-rose-600 dark:text-rose-400">
                  Negative — KAEN has fronted the shortfall
                </p>
              )}
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <DollarSign className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
      </CardContent>
    </Card>
  );
}
