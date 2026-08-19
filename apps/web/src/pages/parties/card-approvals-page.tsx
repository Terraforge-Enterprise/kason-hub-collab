/**
 * Card Approvals — admin queue.
 *
 * Per spec §7.1, the admin moderation surface for pending agent
 * e-namecard submissions. Composition (top to bottom):
 *
 *   1. AgentsAreaTabs strip (consistent on all three Agents sub-routes)
 *   2. Page header with `<ClipboardList>` icon + amber `<Badge>` showing
 *      pending count
 *   3. Single content `<Card>` (glassmorphism per design system) holding
 *      the queue table. Each row → click anywhere → opens the diff Sheet.
 *      Row also has a `⋯` `<DropdownMenu>` (per CRUD pattern §15) with a
 *      "Review →" item — same destination, kept so future row actions
 *      (e.g. "Open agent profile") have a natural home.
 *
 * The diff + decision UI lives in `<CardApprovalSheet>` (sibling file)
 * so this page stays narrow.
 *
 * Loading: skeleton matching the row layout (per design system §10).
 * Empty:   `<EmptyState>` with reassuring copy ("queue is clear").
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, MoreHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/empty-state";
import { useAgentCardsList } from "@/api/agent-cards";
import { AgentsAreaTabs } from "./agents-area-tabs";
import { CardApprovalSheet } from "./card-approval-sheet";

export default function CardApprovalsPage() {
  const [reviewVersionId, setReviewVersionId] = useState<string | null>(null);
  const { data, isLoading, isError } = useAgentCardsList({ status: "pending" });
  const versions = data?.data ?? [];
  const total = data?.pagination?.total ?? 0;

  return (
    <div className="space-y-6">
      <AgentsAreaTabs activeTab="card-approvals" />

      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <ClipboardList className="h-8 w-8 text-primary" />
          Card Approvals
          {total > 0 && (
            <Badge variant="amber" className="ml-1 h-6 px-2 text-xs">
              {total} pending
            </Badge>
          )}
        </h1>
        <p className="text-muted-foreground mt-1">
          Review pending e-namecard submissions from agents and managers.
        </p>
      </div>

      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            Pending queue
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isError ? (
            <div className="text-center py-12 text-muted-foreground">
              Could not load the queue. Try refreshing the page.
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              <div className="h-10 bg-muted rounded animate-pulse" />
              <div className="h-10 bg-muted rounded animate-pulse" />
              <div className="h-10 bg-muted rounded animate-pulse" />
            </div>
          ) : versions.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No pending submissions"
              description="Nothing to review. New agent edits show up here for approval."
            />
          ) : (
            <div className="rounded-lg border border-border/50 overflow-x-auto">
              <table className="w-full">
                <thead className="bg-background/40 border-b border-border/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                      Agent
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                      Submitted
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                      By
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                      Title (proposed)
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => {
                    const createdLabel = formatRelative(v.createdAt);
                    return (
                      <tr
                        key={v.id}
                        className="border-b border-border/30 last:border-b-0 hover:bg-background/40 transition cursor-pointer"
                        onClick={() => setReviewVersionId(v.id)}
                      >
                        <td className="px-4 py-3.5 text-sm text-foreground">
                          <Link
                            to={`/parties/agents/${v.partyId}`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-primary transition-colors"
                          >
                            {v.displayName}
                          </Link>
                        </td>
                        <td className="px-4 py-3.5 text-sm text-muted-foreground">
                          {createdLabel}
                        </td>
                        <td className="px-4 py-3.5 text-sm">
                          <Badge
                            variant={
                              v.submittedByType === "agent" ? "sky" : "outline"
                            }
                          >
                            {v.submittedByType}
                          </Badge>
                        </td>
                        <td className="px-4 py-3.5 text-sm font-medium text-foreground">
                          {v.title}
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={(props) => (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Actions for ${v.displayName}'s submission`}
                                  {...props}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    props.onClick?.(e);
                                  }}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              )}
                            />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => setReviewVersionId(v.id)}
                              >
                                Review →
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sheet stays mounted so closing animations + state preserve cleanly. */}
      <CardApprovalSheet
        versionId={reviewVersionId}
        open={!!reviewVersionId}
        onOpenChange={(open) => {
          if (!open) setReviewVersionId(null);
        }}
      />
    </div>
  );
}

/**
 * Tiny relative-time formatter — `date-fns` is not in the web bundle and
 * adding it for one cell is overkill. Buckets: <1m → "just now",
 * <60m → "Nm ago", <24h → "Nh ago", <30d → "Nd ago", else date.
 * Falls back to the raw ISO when the input doesn't parse.
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "just now";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)}d ago`;
  return new Date(t).toLocaleDateString();
}
