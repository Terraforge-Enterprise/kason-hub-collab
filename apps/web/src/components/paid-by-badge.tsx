import { Badge } from "@/components/ui/badge";

type PaidBy = "kaen" | "owner" | "tenant" | "developer" | "other";

interface PaidByBadgeProps {
  paidBy: PaidBy | string;
}

const LABEL_MAP: Record<string, string> = {
  kaen: "Paid by KAEN",
  owner: "Paid by you",
  tenant: "Paid by Tenant",
  developer: "Paid by Developer",
};

function getLabel(paidBy: string): string {
  return LABEL_MAP[paidBy.toLowerCase()] ?? `Paid by ${paidBy}`;
}

type BadgeVariant = "emerald" | "amber" | "secondary";

function getVariant(paidBy: string): BadgeVariant {
  const key = paidBy.toLowerCase();
  if (key === "kaen") return "emerald";
  if (key === "owner") return "amber";
  return "secondary";
}

export function PaidByBadge({ paidBy }: PaidByBadgeProps) {
  return (
    <Badge variant={getVariant(paidBy)} className="text-xs whitespace-nowrap">
      {getLabel(paidBy)}
    </Badge>
  );
}
