import { useState } from "react";
import { Pencil } from "lucide-react";
import { EditOwnerDialog } from "@/pages/parties/owners-action-dialogs";
import type { OwnerListItem } from "@/pages/parties/owners-table";

export function OwnerConfirmCard({
  ownerId,
  ownerName,
  ownerPhone,
  onChange,
}: {
  ownerId?: string | null;
  ownerName: string;
  ownerPhone?: string | null;
  onChange: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const editableOwner: OwnerListItem | null = ownerId ? {
    id: ownerId,
    displayName: ownerName,
    legalName: null,
    primaryEmail: null,
    primaryPhone: ownerPhone ?? null,
    formattedPhone: ownerPhone ?? null,
    nationality: null,
    status: "active",
    isBlacklisted: false,
    createdAt: "",
    bankName: null,
    bankAccountHolder: null,
    bankAccountNumber: null,
    idType: null,
    idNumber: null,
    blacklistReason: null,
    deletable: false,
  } : null;
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-800">{ownerName}</span>
        <div className="flex items-center gap-3">
          {editableOwner && (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--navy)] hover:underline"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit details
            </button>
          )}
          <button
            type="button"
            onClick={onChange}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Change owner
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Phone</dt>
        <dd className="font-mono">{ownerPhone ?? "—"}</dd>
      </dl>
      {editableOwner && (
        <EditOwnerDialog owner={editableOwner} open={editOpen} onOpenChange={setEditOpen} />
      )}
    </div>
  );
}
