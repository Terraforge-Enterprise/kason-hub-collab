import { useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Banknote,
  CalendarDays,
  Mail,
  Phone,
  UserCircle2,
  UserCog,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDate } from "@/components/format";
import type { LucideIcon } from "lucide-react";
import { useAgentDetail } from "./use-agent-detail";

// "Manager" is the staff User.role; agentLevel="leader" reads as "Leader".
const LEVEL_LABELS: Record<string, string> = {
  leader: "Leader",
  pre_leader: "Pre Leader",
  new_agent: "New Agent",
};

function humanizeLevel(level: string | null | undefined): string {
  if (!level) return "Unassigned";
  return LEVEL_LABELS[level] ?? level.replace(/_/g, " ");
}

function levelBadge(level: string | null | undefined) {
  switch (level) {
    case "leader": return { variant: "gold" as const, label: "Leader" };
    case "pre_leader": return { variant: "sky" as const, label: "Pre Leader" };
    case "new_agent": return { variant: "emerald" as const, label: "New Agent" };
    default: return { variant: "outline" as const, label: "Unassigned" };
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "active": return { variant: "emerald" as const, label: "Active" };
    case "blacklisted": return { variant: "rose" as const, label: "Blacklisted" };
    default: return { variant: "outline" as const, label: status };
  }
}

type AgentSummary = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  /** Pre-formatted phone for display, when available on the slim summary. */
  formattedPhone?: string | null;
  upline?: { id: string; displayName: string; agentLevel: string | null } | null;
  directDownlineCount: number;
  status: string;
  createdAt?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  agent: AgentSummary | null;
};

export function AgentDetailModal({ open, onClose, agent }: Props) {
  const navigate = useNavigate();
  // Fetch full party detail when a tree node is selected. The hierarchy
  // query is intentionally slim (id, displayName, agentLevel, status,
  // uplineId, directDownlineCount) — keeping it small lets it scale to
  // thousands of agents without ballooning the WebSocket payload. The
  // detail panel needs email/phone/bank, so we fetch on selection rather
  // than enriching the tree query. The hook is enabled iff `open` and we
  // have an id, so closed modals issue no requests.
  const detailQuery = useAgentDetail(open ? agent?.id : undefined);

  if (!agent) return null;

  const level = levelBadge(agent.agentLevel);
  const status = statusBadge(agent.status);
  const detail = detailQuery.data;

  // Prefer detail.* when loaded (carries primaryEmail/primaryPhone/
  // bankName); fall back to the slim tree node for fields it has. The
  // phone display prefers `formattedPhone` (server-pre-formatted) over the
  // raw canonical so we don't need libphonenumber-js on the client.
  const primaryEmail = detail?.primaryEmail ?? agent.primaryEmail ?? null;
  const primaryPhoneDisplay =
    detail?.formattedPhone ??
    detail?.primaryPhone ??
    agent.formattedPhone ??
    agent.primaryPhone ??
    null;
  const bankName = detail?.bank?.name ?? null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="md">
        <SheetHeader>
          <div className="flex items-start gap-3 pr-8">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <UserCircle2 className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-lg font-bold">
                {agent.displayName}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs">
                ID: {agent.id.slice(0, 8)}
              </SheetDescription>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant={level.variant}>{level.label}</Badge>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
        </SheetHeader>

        <SheetBody className="space-y-4">
          <DetailSection title="Contact">
            <DetailRow icon={Mail} label="Email" value={primaryEmail ?? "—"} />
            <DetailRow icon={Phone} label="Phone" value={primaryPhoneDisplay ?? "—"} />
          </DetailSection>

          <DetailSection title="Reporting line">
            <DetailRow
              icon={UserCog}
              label="Upline"
              value={
                agent.upline
                  ? `${agent.upline.displayName} · ${humanizeLevel(agent.upline.agentLevel)}`
                  : "Reports directly to organization"
              }
            />
            <DetailRow
              icon={Users}
              label="Direct downlines"
              value={String(agent.directDownlineCount)}
            />
          </DetailSection>

          <DetailSection title="Banking">
            <DetailRow icon={Banknote} label="Bank" value={bankName ?? "—"} />
          </DetailSection>

          {agent.createdAt && (
            <DetailSection title="Record">
              <DetailRow
                icon={CalendarDays}
                label="Joined"
                value={formatDate(agent.createdAt)}
              />
            </DetailSection>
          )}
        </SheetBody>

        <SheetFooter>
          <Button
            variant="gold"
            onClick={() => navigate(`/parties/agents/${agent.id}`)}
          >
            Open full detail
            <ArrowUpRight className="ml-1.5 h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-4 backdrop-blur-sm">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <dl className="space-y-2.5">{children}</dl>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </dt>
        <dd className="mt-0.5 break-words text-sm text-foreground">{value}</dd>
      </div>
    </div>
  );
}
