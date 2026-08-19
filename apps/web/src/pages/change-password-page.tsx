import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useChangeAdminPassword } from "@/api/admin-auth";
import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";

export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const change = useChangeAdminPassword();
  const { clearAuth } = useAuth();
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
        onSuccess: async () => {
          // Sign out and return to the login page so the user re-authenticates
          // with their new password. This also sidesteps the must-change guard:
          // navigating to a guarded route here would read the still-cached
          // (unobserved, therefore un-refetched) mustChangePassword=true session
          // and bounce back to this page. Mirrors DashboardLayout.handleLogout.
          toast.success("Password changed. Please sign in with your new password.");
          try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
          clearAuth();
          navigate("/login", { replace: true });
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
