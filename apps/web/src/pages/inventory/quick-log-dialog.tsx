// Quick-log dialog (M7 Task 9). Adds a unit history entry WITHOUT an existing
// open ticket — the API auto-creates a resolved ticket behind the scenes so
// every entry stays traceable (POST /units/:unitId/history). Same body as the
// resolve dialog (entry / occurredOn / mint-only uploads) plus optional
// title / category / warranty metadata for the auto-created ticket.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, TextAreaInput, TextInput } from "@/components/form-ui";
import { CategoryCombobox } from "@/components/category-combobox";
import { useQuickLog } from "@/api/tasks";
import { usePhase2AttachmentUpload } from "@/hooks/use-phase2-attachment-upload";
import { HistoryAttachmentPicker } from "./history-attachment-picker";

/**
 * Convert a yyyy-mm-dd date-input value to a Z-normalized ISO datetime.
 * The API's zod `.datetime()` REJECTS offset timestamps, so we anchor the
 * day at UTC midnight explicitly. (Duplicated per dialog file — react-refresh
 * forbids exporting non-component helpers from component files.)
 */
function toIsoFromDateInput(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

/** Today as a yyyy-mm-dd value for <input type="date"> defaults (UTC day). */
function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}

export function QuickLogDialog({
  open,
  onClose,
  unitId,
}: {
  open: boolean;
  onClose: () => void;
  unitId: string;
}) {
  const quickLog = useQuickLog(unitId);

  const [entry, setEntry] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayDateInput());
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [warrantyFlag, setWarrantyFlag] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const [entryError, setEntryError] = useState<string | null>(null);

  const upload = usePhase2AttachmentUpload({
    mintPath: `/units/${unitId}/history/attachments/upload-url`,
    completePath: null, // mint-only — keys ride in the quick-log body
    onUploaded: (storageKey) => setKeys((prev) => [...prev, storageKey]),
  });
  const { reset: resetUpload } = upload;

  useEffect(() => {
    if (!open) {
      // Close-without-submit: abort in-flight mint-only uploads (epoch bump)
      // so late completions can't leak keys into the next open cycle; the
      // already-collected keys are discarded with the dialog.
      resetUpload();
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open form snapshot; same pattern as task-drawer.
    setEntry("");
    setOccurredOn(todayDateInput());
    setTitle("");
    setCategory("");
    setWarrantyFlag(false);
    setKeys([]);
    setEntryError(null);
    resetUpload(); // epoch-safe: stale mints can't leak keys into this cycle
  }, [open, resetUpload]);

  function handleSubmit() {
    if (!entry.trim()) {
      setEntryError("Entry is required.");
      return;
    }
    quickLog.mutate(
      {
        entry: entry.trim(),
        occurredOn: toIsoFromDateInput(occurredOn),
        attachmentKeys: keys,
        warrantyFlag,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success("History entry added.");
          resetUpload();
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="sm"
      title="Add history entry"
      description="Log work that's already done for this unit."
      onSubmit={handleSubmit}
      submit={{
        label: "Add entry",
        pendingLabel: "Adding…",
        variant: "gold",
        pending: quickLog.isPending,
        disabled: upload.isUploading,
      }}
    >
      <div className="grid gap-4">
        <Callout variant="info">
          Creates a resolved ticket behind the scenes so every entry stays traceable.
        </Callout>

        <Field label="Entry" error={entryError}>
          <TextAreaInput
            value={entry}
            onChange={(e) => {
              setEntry(e.target.value);
              setEntryError(null);
            }}
            placeholder="What was done…"
            rows={3}
            required
          />
        </Field>

        <Field label="Occurred on">
          <TextInput
            type="date"
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" hint="Optional — names the backing ticket.">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Aircond service"
            />
          </Field>
          <CategoryCombobox value={category} onChange={setCategory} label="Category" hint="Pick a category, or Other for free text." />
        </div>

        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <Checkbox
            aria-label="Warranty item"
            checked={warrantyFlag}
            onCheckedChange={(checked) => setWarrantyFlag(checked === true)}
          />
          <span>Warranty item</span>
        </label>

        <div className="space-y-1.5">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Evidence (photos / PDFs)
          </span>
          <HistoryAttachmentPicker
            items={upload.items}
            keys={keys}
            onPick={(files) => upload.enqueue(files)}
            onRetry={upload.retry}
            onRemoveKey={(key) => setKeys((prev) => prev.filter((k) => k !== key))}
          />
        </div>
      </div>
    </FormDrawer>
  );
}
