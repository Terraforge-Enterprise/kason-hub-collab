import { useEffect, useState } from "react";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Field, TextAreaInput } from "@/components/form-ui";
import { StatusPill } from "@/components/ui";
import { ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import { useAgentActions } from "./use-agent-actions";
import type { AgentListItem } from "./agents-table";

export type AgentBlacklistMode = "blacklist" | "reactivate" | "deactivate" | "activate";

type Props = {
  open: boolean;
  mode: AgentBlacklistMode;
  agent: AgentListItem;
  onClose: () => void;
};

const LEVEL_LABELS: Record<string, string> = {
  new_agent: "New Agent",
  pre_leader: "Pre Leader",
  leader: "Leader",
};

export function AgentBlacklistDrawer({ open, mode, agent, onClose }: Props) {
  const { blacklist, reactivate, deactivate, activate } = useAgentActions();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setReason("");
    }
  }, [open, mode, agent.id]);

  const isPending =
    blacklist.isPending ||
    reactivate.isPending ||
    deactivate.isPending ||
    activate.isPending;
  const isReasonValid = reason.trim().length >= 10;

  function handleSubmit() {
    if (!isReasonValid) return;
    if (mode === "blacklist") {
      blacklist.mutate(
        { id: agent.id, reason: reason.trim(), updatedAt: agent.updatedAt },
        { onSuccess: onClose },
      );
      return;
    }
    const payload = { id: agent.id, note: reason.trim(), updatedAt: agent.updatedAt };
    const mutation =
      mode === "reactivate" ? reactivate : mode === "deactivate" ? deactivate : activate;
    mutation.mutate(payload, { onSuccess: onClose });
  }

  const title =
    mode === "blacklist"
      ? "Blacklist agent"
      : mode === "reactivate"
        ? "Reactivate agent"
        : mode === "deactivate"
          ? "Deactivate agent"
          : "Activate agent";

  const description =
    mode === "blacklist"
      ? "Blacklisting will auto-reject all draft and submitted claims for this agent."
      : mode === "reactivate"
        ? "Reactivating restores the agent's active status. Existing rejected claims are not reversed."
        : mode === "deactivate"
          ? "Soft retirement — blocks portal login and new commission assignment, but preserves downline, pending claims, and full history. Reversible."
          : "Returns the agent to active status and allows portal access again.";

  const reasonLabel =
    mode === "blacklist"
      ? "Reason for blacklisting"
      : mode === "reactivate"
        ? "Reason for reactivating"
        : mode === "deactivate"
          ? "Reason for deactivating"
          : "Reason for activating";

  const variant =
    mode === "blacklist" ? "destructive" : mode === "deactivate" ? "secondary" : "gold";

  // Only blacklist requires confirmation. The other three modes are reversible.
  const submitConfirm =
    mode === "blacklist"
      ? {
          title: "Blacklist this agent?",
          body: <BlacklistConfirmBody agent={agent} reason={reason.trim()} />,
          confirmLabel: "Blacklist agent",
          destructive: true,
        }
      : undefined;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title={title}
      description={description}
      onSubmit={handleSubmit}
      submit={{
        label: title,
        variant,
        disabled: !isReasonValid || isPending,
        pending: isPending,
        confirm: submitConfirm,
      }}
    >
      <div className="rounded-lg border border-border/50 bg-background/40 p-4 mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground truncate">
              {agent.displayName}
            </p>
            <p className="text-sm text-muted-foreground">
              {agent.agentLevel
                ? (LEVEL_LABELS[agent.agentLevel] ?? agent.agentLevel)
                : "No level set"}
              {agent.primaryEmail ? ` · ${agent.primaryEmail}` : ""}
            </p>
          </div>
          <StatusPill tone={agent.isBlacklisted ? "rose" : "emerald"}>
            <span className="inline-flex items-center gap-1">
              {agent.isBlacklisted ? (
                <ShieldOffIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {agent.isBlacklisted ? "blacklisted" : agent.status}
            </span>
          </StatusPill>
        </div>
      </div>

      <Field label={reasonLabel}>
        <TextAreaInput
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Provide a reason (minimum 10 characters)…"
          minLength={10}
          maxLength={500}
        />
        {reason.length > 0 && !isReasonValid && (
          <p className="mt-1 text-xs text-rose-500">
            Reason must be at least 10 characters.
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {reason.trim().length}/500 characters
        </p>
      </Field>
    </FormDrawer>
  );
}

function BlacklistConfirmBody({
  agent,
  reason,
}: {
  agent: AgentListItem;
  reason: string;
}) {
  return (
    <span>
      You're blacklisting <strong>{agent.displayName}</strong>. This will
      auto-reject all draft and submitted claims for this agent. Reason:{" "}
      <em>"{reason}"</em>
    </span>
  );
}
