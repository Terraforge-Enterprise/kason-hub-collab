import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useChangePortalPassword, portalSessionKey, type PortalSession } from "@/api/portal-auth";
import { setPortalToken } from "@/lib/auth";

export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const change = useChangePortalPassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("New password and confirmation do not match.");
      return;
    }
    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: (res) => {
          // Carry the user straight into the portal. They authenticated with the
          // temporary password to get here and re-proved it in this form, so a
          // third round of credentials buys nothing — and a login screen at this
          // exact point is where first-login tenants drop off, not least because
          // the password manager re-fills the OLD temporary password and makes a
          // successful change look broken.
          //
          // The server rotated the session cookie; store the matching token for
          // the bearer fallback (iOS Safari drops the cross-site cookie). Only
          // when one came back — see the API's partyId note.
          if (res?.token) setPortalToken(res.token);

          // The guard reads this cache the moment the dashboard mounts. The
          // mutation's own invalidate can only MARK it stale — the query is
          // unobserved on this page, so nothing refetches — and the guard would
          // then read mustChangePassword=true and bounce us right back here.
          // Write the fact through: the 200 we just got IS the flag being
          // cleared server-side. The invalidate still refreshes it in the
          // background once the dashboard subscribes.
          queryClient.setQueryData<PortalSession>(portalSessionKey, (prev) =>
            prev ? { ...prev, mustChangePassword: false } : prev,
          );

          toast.success("Password updated.");
          navigate("/portal/dashboard", { replace: true });
        },
        onError: (e: unknown) => {
          const msg = e instanceof Error ? e.message : "Could not change password.";
          setError(msg);
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="mb-2 text-2xl font-semibold">Set a new password</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Your administrator set a temporary password. Choose a new one to continue.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="current" className="mb-1 block text-sm font-medium">Current password</label>
          <input
            id="current"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoFocus
            className="w-full rounded border bg-background px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor="new" className="mb-1 block text-sm font-medium">New password</label>
          <input
            id="new"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={6}
            className="w-full rounded border bg-background px-3 py-2"
          />
          <p className="mt-1 text-xs text-muted-foreground">Minimum 6 characters.</p>
        </div>
        <div>
          <label htmlFor="confirm" className="mb-1 block text-sm font-medium">Confirm new password</label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            className="w-full rounded border bg-background px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-rose-500">{error}</p>}
        <button
          type="submit"
          disabled={change.isPending}
          className="rounded bg-primary px-4 py-2 text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {change.isPending ? "Changing…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
