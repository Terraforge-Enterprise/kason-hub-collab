// Settings → Feature Flags (2026-08-06). ONE page of truth for THIS
// environment: every registry flag with the API's live value (from
// /api/feature-flags) next to this web bundle's baked VITE twin, and any
// web-ON/API-OFF split called out loudly. That silent split is how "expenses
// never reach the invoice" shipped — the UI acted like the feature worked
// while the server skipped it, and the warning banner was suppressed by the
// same skew. Open this page in local, UAT, or prod and the deployed truth of
// that environment is simply visible.
//
// Deliberately NOT flag-gated (a diagnostic that hides when flags are wrong is
// useless). Read-only; API is manager+, so editors see the access note.
import { useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { PHASE2_FLAGS, type Phase2Flag } from "@kason/shared";
import { PageHeader } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { apiFetch, ApiError } from "@/lib/api-client";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";

interface FlagsResponse {
  flags: { name: Phase2Flag; api: boolean }[];
}

const FLAGS_QK = ["feature-flags"] as const;

type RowState = "on" | "off" | "api_only" | "split";

function rowState(api: boolean, web: boolean): RowState {
  if (api && web) return "on";
  if (!api && !web) return "off";
  if (api && !web) return "api_only";
  return "split";
}

function ValueBadge({ on }: { on: boolean }) {
  return on ? <Badge variant="emerald">on</Badge> : <Badge variant="outline">off</Badge>;
}

function StateBadge({ state }: { state: RowState }) {
  switch (state) {
    case "on":
      return <Badge variant="emerald">on</Badge>;
    case "off":
      return <Badge variant="outline">off</Badge>;
    case "api_only":
      // Legal shape: cron/backend flags have no web surface to gate.
      return <Badge variant="amber">API-only</Badge>;
    case "split":
      return <Badge variant="rose">SPLIT — web on, API off</Badge>;
  }
}

export default function FeatureFlagsSection() {
  const query = useQuery<FlagsResponse, ApiError>({
    queryKey: FLAGS_QK,
    queryFn: () => apiFetch<FlagsResponse>("/feature-flags"),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-12 w-64 bg-muted rounded" />
        <div className="h-96 bg-muted rounded-xl" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Feature Flags" icon={Flag} description="Live flag state for this environment." />
        <Callout variant={query.error.status === 403 ? "info" : "danger"}>
          {query.error.status === 403
            ? "Reading flag state needs the manager role."
            : `Couldn't load the API flag state: ${query.error.message}`}
        </Callout>
      </div>
    );
  }

  const apiByName = new Map((query.data?.flags ?? []).map((f) => [f.name, f.api]));
  const rows = PHASE2_FLAGS.map((name) => {
    const api = apiByName.get(name) ?? false;
    const web = isPhase2FlagEnabled(name);
    return { name, api, web, state: rowState(api, web) };
  });
  const splits = rows.filter((r) => r.state === "split");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature Flags"
        icon={Flag}
        description="Live flag state for this environment — the API's runtime value beside this web build's baked value."
      />

      {splits.length > 0 ? (
        <Callout variant="danger" title="Split-brain detected">
          {splits.map((s) => s.name).join(", ")} {splits.length === 1 ? "is" : "are"} ON in the web
          build but OFF on the API — the UI will act like the feature works while the server
          silently skips it. Fix the deploy config for this environment.
        </Callout>
      ) : (
        <Callout variant="info">
          Rule: a web flag may be ON only when its API flag is ON. “API-only” is legal — backend
          and cron flags have no web surface. Values come from the deploy config (API: workflow
          env block · Web: baked at build), so a change here requires a redeploy.
        </Callout>
      )}

      <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
            <tr>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Flag</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">API</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Web</th>
              <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-[var(--border)] last:border-0 transition hover:bg-[var(--page-bg)]">
                <td className="px-4 py-3.5 text-sm text-[var(--text-primary)] font-mono">{row.name}</td>
                <td className="px-4 py-3.5"><ValueBadge on={row.api} /></td>
                <td className="px-4 py-3.5"><ValueBadge on={row.web} /></td>
                <td className="px-4 py-3.5"><StateBadge state={row.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        {rows.filter((r) => r.state === "on").length} on · {rows.filter((r) => r.state === "off").length} off ·{" "}
        {rows.filter((r) => r.state === "api_only").length} API-only · {splits.length} split
      </p>
    </div>
  );
}
