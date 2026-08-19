// Section 1 — Statement Details (header)
// Renders: report month, property name, owner identity, bank details.
// accountNumberMasked now carries the FULL account number from the backend — render as-is.
import { Building2, Calendar, CreditCard, User } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StatementHeader } from "@/api/owner-ledger";

interface Props {
  data: StatementHeader;
}

export function StatementSectionHeader({ data }: Props) {
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2" id="section-heading-details">
          <User className="h-5 w-5 text-primary" />
          Statement Details
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Report month */}
          <div className="rounded-lg border border-border/50 bg-background/40 p-4 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10 shrink-0">
              <Calendar className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Billing Month</p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">{data.reportMonth}</p>
            </div>
          </div>

          {/* Property */}
          <div className="rounded-lg border border-border/50 bg-background/40 p-4 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10 shrink-0">
              <Building2 className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Property</p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">{data.propertyName}</p>
            </div>
          </div>

          {/* Owner */}
          <div className="rounded-lg border border-border/50 bg-background/40 p-4 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10 shrink-0">
              <User className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Owner</p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">{data.ownerName}</p>
            </div>
          </div>

          {/* Bank details */}
          <div className="rounded-lg border border-border/50 bg-background/40 p-4 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-green-500/10 shrink-0">
              <CreditCard className="h-4 w-4 text-green-600" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Bank Account</p>
              {data.bankName || data.accountHolder || data.accountNumberMasked ? (
                <div className="mt-0.5 space-y-0.5">
                  {data.bankName && (
                    <p className="text-sm font-semibold text-foreground">{data.bankName}</p>
                  )}
                  {data.accountHolder && (
                    <p className="text-xs text-muted-foreground">{data.accountHolder}</p>
                  )}
                  {data.accountNumberMasked && (
                    <p className="text-xs font-mono text-muted-foreground">
                      {data.accountNumberMasked}
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground italic">Not set</p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
