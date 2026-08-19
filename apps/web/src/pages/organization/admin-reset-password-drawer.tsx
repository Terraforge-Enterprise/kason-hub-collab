import { useEffect, useState } from "react";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { useResetUserPassword } from "@/api/users";
import type { OperatorUser } from "@/api/users";

type Props = {
  open: boolean;
  user: OperatorUser;
  onClose: () => void;
};

export function AdminResetPasswordDrawer({ open, user, onClose }: Props) {
  const resetPassword = useResetUserPassword();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setPassword("");
      setShowPassword(false);
      setError(null);
    }
  }, [open, user.id]);

  function handleSubmit() {
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setError(null);
    resetPassword.mutate({ id: user.id, password }, { onSuccess: onClose });
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title="Reset password"
      description={`Set a new temporary password for ${user.fullName}.`}
      onSubmit={handleSubmit}
      submit={{
        label: "Reset password",
        pendingLabel: "Resetting…",
        variant: "gold",
        pending: resetPassword.isPending,
      }}
    >
      <div className="grid gap-4">
        <Callout variant="info">
          This is a temporary password. The user will be required to change it on first login.
        </Callout>

        <Field label="New temporary password">
          <div className="relative">
            <TextInput
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Minimum 6 characters"
              required
              autoFocus
              className="pr-24"
            />
            <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                onClick={() => {
                  if (password) void navigator.clipboard.writeText(password);
                }}
              >
                Copy
              </button>
            </div>
          </div>
          {error && <p className="mt-1 text-xs text-rose-500">{error}</p>}
        </Field>
      </div>
    </FormDrawer>
  );
}
