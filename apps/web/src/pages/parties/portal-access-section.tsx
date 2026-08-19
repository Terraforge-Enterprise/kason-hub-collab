import { useState } from "react";
import { FormDrawer } from "@/components/ui/form-drawer";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/role-gate";
import { usePortalAccessActions } from "./use-portal-access-actions";
import { formatDate } from "@/components/format";

// ── Types ─────────────────────────────────────────────────────────────────────

type PortalUser = {
  email: string;
  status: string;
  lastLoginAt: string | null;
  updatedAt: string;
};

export type PortalAccessSectionProps = {
  partyId: string;
  kind: "owner" | "tenant";
  portalUser: PortalUser | null;
  defaultEmail: string | null;
  defaultFullName: string;
};

// ── LabelValue ─────────────────────────────────────────────────────────────────

function LabelValue({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-sm text-[var(--text-primary)]">{value ?? "—"}</p>
    </div>
  );
}

// ── Grant portal access drawer ─────────────────────────────────────────────────

type GrantDrawerProps = {
  open: boolean;
  onClose: () => void;
  defaultEmail: string | null;
  defaultFullName: string;
  kind: "owner" | "tenant";
  isPending: boolean;
  onGrant: (v: { email: string; password: string; fullName: string }) => void;
};

function GrantPortalAccessDrawer({
  open,
  onClose,
  defaultEmail,
  defaultFullName,
  kind,
  isPending,
  onGrant,
}: GrantDrawerProps) {
  const [form, setForm] = useState({ email: defaultEmail ?? "", password: "", fullName: defaultFullName });
  const [errors, setErrors] = useState<Partial<typeof form>>({});

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    };
  }

  function handleSubmit() {
    const errs: Partial<typeof form> = {};
    if (!form.email.trim()) errs.email = "Email is required.";
    if (!form.password) errs.password = "Password is required.";
    else if (form.password.length < 6)
      errs.password = "Password must be at least 6 characters.";
    if (!form.fullName.trim()) errs.fullName = "Full name is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onGrant({ email: form.email.trim(), password: form.password, fullName: form.fullName.trim() });
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title="Grant portal access"
      description={`Create portal login credentials for this ${kind}.`}
      onSubmit={handleSubmit}
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
            placeholder="user@example.com"
            required
          />
          {errors.email && (
            <p className="mt-1 text-xs text-rose-500">{errors.email}</p>
          )}
        </Field>

        <Callout variant="info">
          This is a temporary password. They'll be required to change it on first login.
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
            placeholder="Full name"
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

// ── Reset portal password drawer ───────────────────────────────────────────────

type ResetDrawerProps = {
  open: boolean;
  onClose: () => void;
  kind: "owner" | "tenant";
  isPending: boolean;
  onReset: (v: { password: string }) => void;
};

function ResetPortalPasswordDrawer({
  open,
  onClose,
  kind,
  isPending,
  onReset,
}: ResetDrawerProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setError(null);
    onReset({ password });
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title="Reset portal password"
      description={`Set a new temporary password for this ${kind}.`}
      onSubmit={handleSubmit}
      submit={{
        label: "Reset password",
        pendingLabel: "Resetting…",
        variant: "gold",
        pending: isPending,
      }}
    >
      <div className="grid gap-4">
        <Callout variant="warning">
          This is a temporary password. They'll be required to change it on first login.
        </Callout>

        <Field label="New temporary password">
          <TextInput
            type="text"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Minimum 6 characters"
            required
            autoFocus
          />
          {error && (
            <p className="mt-1 text-xs text-rose-500">{error}</p>
          )}
        </Field>
      </div>
    </FormDrawer>
  );
}

// ── PortalAccessSection ────────────────────────────────────────────────────────

/**
 * Party-neutral portal access section — renders grant/reset/revoke actions for
 * owners and tenants. Mirrors the agent `PortalAccessContent` pattern from
 * `agent-detail-page.tsx`. Use inside a GlassCard / CardSection wrapping.
 *
 * All mutation buttons are wrapped in `RoleGate min="manager"`.
 */
export function PortalAccessSection({
  partyId,
  kind,
  portalUser,
  defaultEmail,
  defaultFullName,
}: PortalAccessSectionProps) {
  const { grant, reset, revoke } = usePortalAccessActions(partyId, kind);
  const [grantOpen, setGrantOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);

  // ── No portal user: show "not granted" + grant action ─────────────────────

  if (!portalUser) {
    return (
      <>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1">
            <p className="text-sm text-[var(--text-primary)] font-medium">
              Not granted
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              No portal account has been created for this {kind}.
            </p>
          </div>

          <RoleGate min="manager">
            <Button
              variant="gold"
              size="sm"
              onClick={() => setGrantOpen(true)}
            >
              Grant portal access
            </Button>
          </RoleGate>
        </div>

        <GrantPortalAccessDrawer
          key={String(grantOpen)}
          open={grantOpen}
          onClose={() => setGrantOpen(false)}
          defaultEmail={defaultEmail}
          defaultFullName={defaultFullName}
          kind={kind}
          isPending={grant.isPending}
          onGrant={(v) =>
            grant.mutate(v, { onSuccess: () => setGrantOpen(false) })
          }
        />
      </>
    );
  }

  // ── Portal user exists: show details + reset / revoke ─────────────────────

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid gap-2 sm:grid-cols-3 flex-1">
          <LabelValue label="Email" value={portalUser.email} />
          <LabelValue label="Status" value={portalUser.status} />
          <LabelValue
            label="Last login"
            value={
              portalUser.lastLoginAt
                ? formatDate(portalUser.lastLoginAt)
                : "Never"
            }
          />
        </div>

        <RoleGate min="manager">
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setResetOpen(true)}
            >
              Reset password
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRevokeConfirmOpen(true)}
            >
              Revoke
            </Button>
          </div>
        </RoleGate>
      </div>

      <ResetPortalPasswordDrawer
        key={String(resetOpen)}
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        kind={kind}
        isPending={reset.isPending}
        onReset={(v) =>
          reset.mutate(v, { onSuccess: () => setResetOpen(false) })
        }
      />

      <ConfirmAlert
        open={revokeConfirmOpen}
        onCancel={() => setRevokeConfirmOpen(false)}
        onConfirm={() => {
          setRevokeConfirmOpen(false);
          revoke.mutate({ updatedAt: portalUser.updatedAt });
        }}
        title="Revoke portal access?"
        body={`This ${kind} will be signed out immediately and can no longer log in.`}
        confirmLabel="Revoke access"
        destructive
      />
    </>
  );
}
