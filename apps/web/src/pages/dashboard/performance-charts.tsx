import { Link } from "react-router-dom";
import { CreditCard, FileText } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DonutChart } from "@/components/donut-chart";

type Props = {
  totalPaidAmt: number;
  totalUnpaidAmt: number;
  comingDueAmt: number;
  overdueAmt: number;
  currentMonth: string;
};

export function PerformanceCharts({
  totalPaidAmt,
  totalUnpaidAmt,
  comingDueAmt,
  overdueAmt,
  currentMonth,
}: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            Rental Collection
          </CardTitle>
          <Link
            to="/billing/charges"
            className="text-sm text-primary hover:underline"
          >
            Details
          </Link>
        </CardHeader>
        <CardContent>
          <div className="mb-2">
            <p className="text-sm font-semibold text-foreground">
              Paid vs Unpaid
            </p>
            <p className="text-xs text-muted-foreground">{currentMonth}</p>
          </div>
          <DonutChart
            data={[
              { name: "Paid", value: totalPaidAmt, color: "#10b981" },
              { name: "Unpaid", value: totalUnpaidAmt, color: "#d1d5db" },
            ]}
          />
        </CardContent>
      </Card>

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Invoice
          </CardTitle>
          <Link
            to="/billing/charges"
            className="text-sm text-primary hover:underline"
          >
            Details
          </Link>
        </CardHeader>
        <CardContent>
          <div className="mb-2">
            <p className="text-sm font-semibold text-foreground">
              Payment Status
            </p>
            <p className="text-xs text-muted-foreground">{currentMonth}</p>
          </div>
          <DonutChart
            data={[
              { name: "Coming Due", value: comingDueAmt, color: "#d1d5db" },
              { name: "Overdue", value: overdueAmt, color: "#ef4444" },
              { name: "Paid", value: totalPaidAmt, color: "#10b981" },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
