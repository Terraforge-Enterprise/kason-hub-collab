import { Link } from "react-router-dom";
import { formatNumber } from "@/components/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  ArrowUpRight,
  Building2,
  CreditCard,
  FileText,
} from "lucide-react";

type RecentActivityProps = {
  vacantUnitCount: number;
  draftChargeCount: number;
  paymentCount: number;
};

export function RecentActivity({
  vacantUnitCount,
  draftChargeCount,
  paymentCount,
}: RecentActivityProps) {
  const items = [
    {
      label: "Vacant units",
      value: vacantUnitCount,
      priority: vacantUnitCount > 0 ? ("medium" as const) : ("low" as const),
      icon: Building2,
      href: "/inventory",
      description:
        vacantUnitCount > 0
          ? "Find tenants for these units"
          : "All units occupied",
    },
    {
      label: "Draft charges",
      value: draftChargeCount,
      priority: draftChargeCount > 0 ? ("high" as const) : ("low" as const),
      icon: FileText,
      href: "/billing/charges",
      description:
        draftChargeCount > 0
          ? "Post to activate billing"
          : "All charges posted",
    },
    {
      label: "Payments received",
      value: paymentCount,
      priority: "low" as const,
      icon: CreditCard,
      href: "/billing/payments",
      description: "Total payments recorded",
    },
  ];

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-primary" />
          Needs Attention
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => (
          <Link
            key={item.label}
            to={item.href}
            className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <item.icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <span className="text-sm text-foreground block">
                  {item.label}
                </span>
                <span className="text-xs text-muted-foreground block">
                  {item.description}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant={
                  item.priority === "high"
                    ? "destructive"
                    : item.priority === "medium"
                      ? "amber"
                      : "emerald"
                }
              >
                {formatNumber(item.value)}
              </Badge>
              <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
