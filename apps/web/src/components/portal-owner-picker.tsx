import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import {
  searchPortalOwners,
  createPortalOwner,
  type PortalOwner,
} from "@/api/portal-owners";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

type Props = {
  value: string | null;
  displayName: string;
  onChange: (next: { partyId: string; displayName: string }) => void;
  disabled?: boolean;
};

export function PortalOwnerPicker({ value, displayName, onChange, disabled }: Props) {
  const [q, setQ] = useState(displayName);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ displayName: "", primaryPhone: "", primaryEmail: "" });

  const search = useQuery({
    queryKey: ["portal-owners", "search", q],
    queryFn: () => searchPortalOwners(q),
    enabled: q.trim().length > 0 && open,
    staleTime: 5_000,
  });

  const create = useMutation({
    mutationFn: createPortalOwner,
    onSuccess: ({ data }) => {
      onChange({ partyId: data.id, displayName: data.displayName });
      setQ(data.displayName);
      setOpen(false);
      setCreating(false);
      setDraft({ displayName: "", primaryPhone: "", primaryEmail: "" });
      toast.success("Owner added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSelect(o: PortalOwner) {
    onChange({ partyId: o.id, displayName: o.displayName });
    setQ(o.displayName);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search owner by name, phone, or email"
        disabled={disabled}
        className={`w-full ${INPUT_BASE}`}
      />
      {value && !open && (
        <button
          type="button"
          onClick={() => { setQ(""); onChange({ partyId: "", displayName: "" }); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          aria-label="Clear"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {open && q.trim().length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg max-h-64 overflow-auto">
          {search.isLoading ? (
            <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Searching…</div>
          ) : creating ? (
            <CreateOwnerForm
              draft={draft}
              setDraft={setDraft}
              onCancel={() => setCreating(false)}
              onSubmit={() => create.mutate({
                displayName: (draft.displayName.trim() || q.trim()),
                primaryPhone: draft.primaryPhone.trim() || undefined,
                primaryEmail: draft.primaryEmail.trim() || undefined,
              })}
              isPending={create.isPending}
            />
          ) : (
            <>
              {(search.data?.data ?? []).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => handleSelect(o)}
                  className="block w-full px-3 py-2 text-left hover:bg-[var(--page-bg)]"
                >
                  <p className="text-sm text-[var(--text-primary)]">{o.displayName}</p>
                  {(o.primaryPhone || o.primaryEmail) && (
                    <p className="text-xs text-[var(--text-muted)]">
                      {o.formattedPhone ?? o.primaryPhone}
                      {o.primaryPhone && o.primaryEmail ? " · " : ""}
                      {o.primaryEmail}
                    </p>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setCreating(true); setDraft({ displayName: q, primaryPhone: "", primaryEmail: "" }); }}
                className="w-full px-3 py-2 text-left text-sm text-[var(--gold)] hover:bg-[var(--page-bg)] border-t border-[var(--card-border)]"
              >
                <Plus className="inline h-3 w-3 mr-1" /> Add new owner: "{q}"
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CreateOwnerForm({
  draft,
  setDraft,
  onCancel,
  onSubmit,
  isPending,
}: {
  draft: { displayName: string; primaryPhone: string; primaryEmail: string };
  setDraft: (d: { displayName: string; primaryPhone: string; primaryEmail: string }) => void;
  onCancel: () => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <div className="p-3 space-y-2">
      <input
        type="text"
        value={draft.displayName}
        onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
        placeholder="Full name"
        className={`w-full ${INPUT_BASE}`}
      />
      <input
        type="text"
        value={draft.primaryPhone}
        onChange={(e) => setDraft({ ...draft, primaryPhone: e.target.value })}
        placeholder="Phone (optional)"
        className={`w-full ${INPUT_BASE}`}
      />
      <input
        type="email"
        value={draft.primaryEmail}
        onChange={(e) => setDraft({ ...draft, primaryEmail: e.target.value })}
        placeholder="Email (optional)"
        className={`w-full ${INPUT_BASE}`}
      />
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button
          variant="gold"
          size="sm"
          onClick={onSubmit}
          disabled={isPending}
        >
          {isPending ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}
