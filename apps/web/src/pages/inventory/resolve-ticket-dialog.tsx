// Resolve-ticket dialog (M7 Task 9). Captures the resolution narrative + an
// occurredOn date + optional photo/PDF evidence, then POSTs /tickets/:id/resolve.
// Evidence uses the MINT-ONLY upload flow (completePath null): the history row
// doesn't exist until resolve commits, so storage keys are collected locally
// and submitted inside the resolve body.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Field, TextAreaInput, TextInput } from "@/components/form-ui";
import {
  unitTicketsKey,
  useResolveTicket,
  type TicketRow,
} from "@/api/tasks";
import { usePhase2AttachmentUpload } from "@/hooks/use-phase2-attachment-upload";
import { HistoryAttachmentPicker } from "./history-attachment-picker";

/**
 * Convert a yyyy-mm-dd date-input value to a Z-normalized ISO datetime.
 * The API's zod `.datetime()` REJECTS offset timestamps, so we anchor the
 * day at UTC midnight explicitly instead of letting the runtime apply the
 * local timezone. (Duplicated per dialog file — react-refresh forbids
 * exporting non-component helpers from component files; task-drawer keeps
 * its copy private too.)
 */
function toIsoFromDateInput(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

/** Today as a yyyy-mm-dd value for <input type="date"> defaults (UTC day). */
function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ResolveTicketDialog({
  open,
  onClose,
  unitId,
  ticket,
  onResolved,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  unitId: string;
  ticket: TicketRow | null;
  /** Resolve landed — caller closes BOTH this dialog and the ticket drawer. */
  onResolved: () => void;
  /**
   * Resolve failed (typically a 409 stale-token conflict) — the caller
   * reseeds its ticket snapshot so this dialog's `ticket` prop carries a
   * fresh updatedAt and the retained entry/evidence can be re-submitted.
   */
  onConflict?: () => void;
}) {
  const qc = useQueryClient();
  const resolveTicket = useResolveTicket(unitId);

  const [entry, setEntry] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayDateInput());
  const [keys, setKeys] = useState<string[]>([]);
  const [entryError, setEntryError] = useState<string | null>(null);

  const upload = usePhase2AttachmentUpload({
    mintPath: `/units/${unitId}/history/attachments/upload-url`,
    completePath: null, // mint-only — keys ride in the resolve body
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
    setKeys([]);
    setEntryError(null);
    resetUpload(); // epoch-safe: stale mints can't leak keys into this cycle
  }, [open, resetUpload]);

  function handleSubmit() {
    if (!ticket) return;
    if (!entry.trim()) {
      setEntryError("Entry is required.");
      return;
    }
    resolveTicket.mutate(
      {
        ticketId: ticket.id,
        updatedAt: ticket.updatedAt,
        entry: entry.trim(),
        occurredOn: toIsoFromDateInput(occurredOn),
        attachmentKeys: keys,
      },
      {
        onSuccess: () => {
          toast.success("Resolved — history entry added");
          resetUpload();
          onResolved();
        },
        onError: (err) => {
          // Typically a 409 from the updatedAt concurrency check. Surface it,
          // refetch the list, AND let the drawer reseed its snapshot — without
          // the reseed every retry would re-send the same dead token while the
          // operator's entry/evidence sit captive in this dialog. Fired for
          // every error: a redundant reseed on non-409 failures is harmless.
          toast.error(err.message);
          qc.invalidateQueries({ queryKey: unitTicketsKey(unitId) });
          onConflict?.();
        },
      },
    );
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="sm"
      title="Resolve ticket"
      description={ticket?.title}
      onSubmit={handleSubmit}
      submit={{
        label: "Resolve ticket",
        pendingLabel: "Resolving…",
        variant: "gold",
        pending: resolveTicket.isPending,
        disabled: upload.isUploading,
      }}
    >
      <div className="grid gap-4">
        <Field label="Entry" error={entryError}>
          <TextAreaInput
            value={entry}
            onChange={(e) => {
              setEntry(e.target.value);
              setEntryError(null);
            }}
            placeholder="What was found and what was done…"
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
