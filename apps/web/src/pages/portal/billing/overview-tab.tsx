import { Link } from "react-router-dom";
import { Receipt } from "lucide-react";
import type { PortalDashboardResponse } from "@kason/shared";
import { formatRM } from "@/components/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Balance = PortalDashboardResponse["balance"];

/**
 * Billing Overview breakdown (Appendix A §3). Consumes only the dashboard's
 * `balance` summary — no itemized charge lines (those live on the Invoices &
 * Charges tab, T6).
 */
export function OverviewTab({ balance }: { balance: Balance }) {
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          Billing breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <BreakdownRow label="Total billed" value={formatRM(balance.totalCharges)} />
        <BreakdownRow label="Credits / adjustments" value={formatRM(-balance.totalCredits)} />
        <BreakdownRow label="Payments received" value={formatRM(-balance.totalPayments)} />

        <div className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 p-4 mt-2">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Amount to pay</p>
            <p className="mt-1 text-2xl font-bold text-foreground">{formatRM(balance.netBalance)}</p>
          </div>
          <Link to="/portal/pay">
            <Button variant="gold">Pay {formatRM(balance.netBalance)}</Button>
          </Link>
        </div>

        {/* Unspent credit, shown BELOW the amount due and never subtracted from
            it. It is money the tenant holds for FUTURE bills — netting it into
            "Amount to pay" would understate what is owed today and invite a
            short payment. Rendered only when they actually hold some. */}
        {balance.creditAvailable > 0 && (
          <div
            className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"
            data-testid="credit-available"
          >
            <div>
              <p className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                Credit on your account
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Automatically deducted from your next bill.
              </p>
            </div>
            <p className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
              {formatRM(balance.creditAvailable)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BreakdownRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3">
      <span className="text-sm text-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
