import { Link } from "react-router-dom";
import { formatNumber } from "@/components/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  ArrowUpRight,
  Building2,
  CreditCard,
  FileText,
  ShieldCheck,
  Zap,
} from "lucide-react";

type Props = {
  draftChargeCount: number;
};

export function QuickActions({ draftChargeCount }: Props) {
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Quick Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {[
          ...(draftChargeCount > 0
            ? [
                {
                  label: `Post ${formatNumber(draftChargeCount)} draft charge${draftChargeCount !== 1 ? "s" : ""}`,
                  href: "/billing/charges",
                  icon: FileText,
                  urgent: true,
                },
              ]
            : []),
          {
            label: "Add a property",
            href: "/inventory",
            icon: Building2,
            urgent: false,
          },
          {
            label: "Record a payment",
            href: "/billing/payments",
            icon: CreditCard,
            urgent: false,
          },
          {
            label: "Create a tenancy",
            href: "/tenancy/tenancies",
            icon: ShieldCheck,
            urgent: false,
          },
        ].map((action) => (
          <Link
            key={action.label}
            to={action.href}
            className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3 text-sm font-medium backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
          >
            <div
              className={`p-1.5 rounded-lg ${action.urgent ? "bg-orange-500/10" : "bg-muted"}`}
            >
              <action.icon
                className={`h-3.5 w-3.5 ${action.urgent ? "text-orange-600" : "text-muted-foreground"} group-hover:text-primary transition-colors`}
              />
            </div>
            <span
              className={`flex-1 ${action.urgent ? "text-orange-700 dark:text-orange-400" : "text-foreground"}`}
            >
              {action.label}
            </span>
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
