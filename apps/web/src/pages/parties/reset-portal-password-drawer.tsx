import { useEffect, useState } from "react";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/form-ui";
import { useAgentActions } from "./use-agent-actions";
import type { AgentListItem } from "./agents-table";

type Props = {
  open: boolean;
  agent: AgentListItem;
  onClose: () => void;
};

export function ResetPortalPasswordDrawer({ open, agent, onClose }: Props) {
  const { resetPortal } = useAgentActions();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setPassword("");
      setError(null);
    }
  }, [open, agent.id]);

  function handleSubmit() {
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setError(null);
    resetPortal.mutate(
      { id: agent.id, password },
      { onSuccess: onClose },
    );
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title="Reset portal password"
      description={`Set a new temporary password for ${agent.displayName}.`}
      onSubmit={handleSubmit}
      submit={{
        label: "Reset password",
        pendingLabel: "Resetting…",
        variant: "gold",
        pending: resetPortal.isPending,
      }}
    >
      <div className="grid gap-4">
        <Callout variant="warning">
          This is a temporary password. The agent will be required to change it on first login.
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
