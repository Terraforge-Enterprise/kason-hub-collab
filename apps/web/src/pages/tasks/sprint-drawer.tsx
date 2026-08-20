// Sprint create/edit drawer. FormDrawer + reset-on-open form snapshot
// (mirrors task-drawer.tsx). Dates anchored to UTC midnight because the API's
// zod .datetime() rejects offset timestamps.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { UpdateSprintInput } from "@kason/shared";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Field, TextAreaInput, TextInput } from "@/components/form-ui";
import { useCreateSprint, useUpdateSprint, type SprintRow } from "@/api/tasks";

type FormState = { name: string; goal: string; startsOn: string; endsOn: string };

function toIsoFromDateInput(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

function blankForm(): FormState {
  return { name: "", goal: "", startsOn: "", endsOn: "" };
}

function formFromSprint(s: SprintRow): FormState {
  return {
    name: s.name ?? "",
    goal: s.goal ?? "",
    startsOn: s.startsOn ? s.startsOn.slice(0, 10) : "",
    endsOn: s.endsOn ? s.endsOn.slice(0, 10) : "",
  };
}

export function SprintDrawer({
  open,
  onClose,
  mode,
  sprint,
}: {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  sprint?: SprintRow;
}) {
  const createSprint = useCreateSprint();
  const updateSprint = useUpdateSprint();
  const [form, setForm] = useState<FormState>(() => blankForm());

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open snapshot; same pattern as task-drawer.tsx.
      setForm(mode === "edit" && sprint ? formFromSprint(sprint) : blankForm());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, sprint?.id]);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit() {
    if (mode === "create") {
      createSprint.mutate(
        {
          ...(form.name.trim() ? { name: form.name.trim() } : {}),
          ...(form.goal.trim() ? { goal: form.goal.trim() } : {}),
          ...(form.startsOn ? { startsOn: toIsoFromDateInput(form.startsOn) } : {}),
          ...(form.endsOn ? { endsOn: toIsoFromDateInput(form.endsOn) } : {}),
        },
        {
          onSuccess: () => {
            toast.success("Sprint created");
            onClose();
          },
          onError: (err) => toast.error(err.message),
        },
      );
      return;
    }

    if (!sprint) return;
    // Send only changed fields; cleared text → null (updateSprintSchema nullable).
    const patch: Partial<Omit<UpdateSprintInput, "sprintId" | "updatedAt">> = {};
    const name = form.name.trim() || null;
    if (name !== (sprint.name ?? null)) patch.name = name;
    const goal = form.goal.trim() || null;
    if (goal !== (sprint.goal ?? null)) patch.goal = goal;
    const startsOn = form.startsOn ? toIsoFromDateInput(form.startsOn) : null;
    const currentStarts = sprint.startsOn ? toIsoFromDateInput(sprint.startsOn.slice(0, 10)) : null;
    if (startsOn !== currentStarts) patch.startsOn = startsOn;
    const endsOn = form.endsOn ? toIsoFromDateInput(form.endsOn) : null;
    const currentEnds = sprint.endsOn ? toIsoFromDateInput(sprint.endsOn.slice(0, 10)) : null;
    if (endsOn !== currentEnds) patch.endsOn = endsOn;

    updateSprint.mutate(
      { sprintId: sprint.id, updatedAt: sprint.updatedAt, ...patch },
      {
        onSuccess: () => {
          toast.success("Sprint updated");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  const isPending = createSprint.isPending || updateSprint.isPending;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title={mode === "create" ? "New sprint" : "Edit sprint"}
      description={
        mode === "create"
          ? "Plan a sprint. It starts in the Backlog until you Start it."
          : sprint?.name ?? `Sprint ${sprint?.seq ?? ""}`
      }
      onSubmit={handleSubmit}
      submit={{
        label: mode === "create" ? "Create sprint" : "Save sprint",
        pendingLabel: mode === "create" ? "Creating…" : "Saving…",
        variant: "gold",
        pending: isPending,
      }}
    >
      <div className="grid gap-4" data-testid="sprint-drawer">
        <Field label="Name" hint="Optional — defaults to “Sprint N”.">
          <TextInput
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Sprint name"
            autoFocus={mode === "create"}
          />
        </Field>
        <Field label="Goal">
          <TextAreaInput
            value={form.goal}
            onChange={(e) => set("goal", e.target.value)}
            placeholder="Sprint goal (optional)"
            rows={3}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts on">
            <TextInput
              type="date"
              value={form.startsOn}
              onChange={(e) => set("startsOn", e.target.value)}
            />
          </Field>
          <Field label="Ends on" hint="Defaults to 14 days after start.">
            <TextInput
              type="date"
              value={form.endsOn}
              onChange={(e) => set("endsOn", e.target.value)}
            />
          </Field>
        </div>
      </div>
    </FormDrawer>
  );
}
