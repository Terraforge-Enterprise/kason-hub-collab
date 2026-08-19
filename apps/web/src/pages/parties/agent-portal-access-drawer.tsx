import { useEffect, useState } from "react";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { StatusPill } from "@/components/ui";
import { useAgentActions } from "./use-agent-actions";
import type { AgentListItem } from "./agents-table";

export type AgentPortalMode = "grant" | "revoke";

type Props = {
  open: boolean;
  mode: AgentPortalMode;
  agent: AgentListItem;
  onClose: () => void;
};

type GrantForm = {
  email: string;
  password: string;
  fullName: string;
};

export function AgentPortalAccessDrawer({ open, mode, agent, onClose }: Props) {
  const { grantPortal, revokePortal } = useAgentActions();
  const [form, setForm] = useState<GrantForm>({ email: "", password: "", fullName: "" });
  const [errors, setErrors] = useState<Partial<GrantForm>>({});

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setForm({
        email: agent.primaryEmail ?? "",
        password: "",
        fullName: agent.displayName ?? "",
      });
      setErrors({});
    }
  }, [open, mode, agent.id]);

  function set(field: keyof GrantForm) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    };
  }

  const isPending = grantPortal.isPending || revokePortal.isPending;

  function handleGrantSubmit() {
    const errs: Partial<GrantForm> = {};
    if (!form.email.trim()) errs.email = "Email is required.";
    if (!form.password) errs.password = "Password is required.";
    else if (form.password.length < 6)
      errs.password = "Password must be at least 6 characters.";
    if (!form.fullName.trim()) errs.fullName = "Full name is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    grantPortal.mutate(
      {
        id: agent.id,
        email: form.email.trim(),
        password: form.password,
        fullName: form.fullName.trim(),
      },
      { onSuccess: onClose },
    );
  }

  function handleRevokeSubmit() {
    if (!agent.portalUser) return;
    revokePortal.mutate(
      { id: agent.id, updatedAt: agent.portalUser.updatedAt },
      { onSuccess: onClose },
    );
  }

  if (mode === "grant") {
    return (
      <FormDrawer
        open={open}
        onClose={onClose}
        size="md"
        title="Grant portal access"
        description={`Create portal login credentials for ${agent.displayName}.`}
        onSubmit={handleGrantSubmit}
        submit={{
          label: "Grant portal access",
          pendingLabel: "Granting…",
          variant: "gold",
          pending: isPending,
        }}
      >
        <div className="grid gap-4">
          <Field label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="agent@example.com"
              required
            />
            {errors.email && (
              <p className="mt-1 text-xs text-rose-500">{errors.email}</p>
            )}
          </Field>

          <Callout variant="info">
            This is a temporary password. The agent will be required to change it on first login.
          </Callout>

          <Field label="Password">
            <TextInput
              type="password"
              value={form.password}
              onChange={set("password")}
              placeholder="Minimum 6 characters"
              required
            />
            {errors.password && (
              <p className="mt-1 text-xs text-rose-500">{errors.password}</p>
            )}
          </Field>

          <Field label="Full name">
            <TextInput
              value={form.fullName}
              onChange={set("fullName")}
              placeholder="Jane Realty"
              required
            />
            {errors.fullName && (
              <p className="mt-1 text-xs text-rose-500">{errors.fullName}</p>
            )}
          </Field>
        </div>
      </FormDrawer>
    );
  }

  // mode === "revoke"
  const portalEmail = agent.portalUser?.email ?? agent.primaryEmail ?? "—";
  const portalStatus = agent.portalUser?.status ?? "unknown";

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title="Revoke portal access"
      description="The user will be signed out immediately and can no longer log in."
      onSubmit={handleRevokeSubmit}
      submit={{
        label: "Revoke portal access",
        pendingLabel: "Revoking…",
        variant: "destructive",
        pending: isPending,
        confirm: {
          title: "Revoke portal access?",
          body: <RevokePortalConfirmBody agent={agent} />,
          confirmLabel: "Revoke access",
          destructive: true,
        },
      }}
    >
      <div className="rounded-lg border border-border/50 bg-background/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground truncate">
              {agent.displayName}
            </p>
            <p className="text-sm text-muted-foreground">{portalEmail}</p>
          </div>
          <StatusPill tone={portalStatus === "active" ? "emerald" : "rose"}>
            {portalStatus}
          </StatusPill>
        </div>
      </div>
    </FormDrawer>
  );
}

function RevokePortalConfirmBody({ agent }: { agent: AgentListItem }) {
  return (
    <span>
      Revoke portal access for <strong>{agent.displayName}</strong>? The user
      will be signed out immediately and can no longer log in.
    </span>
  );
}
