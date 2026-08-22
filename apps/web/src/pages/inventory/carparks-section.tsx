// CarparksSection — apartment-scoped carpark-bay management UI.
//
// Renders inside EditApartmentShell, once, below the room tabs — bays belong to
// the apartment, not to any one room — so the admin can list, add, and
// deactivate carpark bays without leaving the Edit-apartment dialog.
//
// Owns its own React Query fetch (useCarparksByApartment) rather than hoisting
// the list into the parent, keeping the apartment-form state separate from the
// bay list state. Uses `type="button"` on every internal button so clicks do
// NOT trigger the surrounding <form> submission.
//
// Owner shown read-only: the bay inherits the apartment's owner server-side
// (propagated by registerCarparkService). Admin cannot change it here.
//
// Spec: docs/superpowers/specs/2026-06-30-carpark-redesign.md Task 2.2

import { useState } from "react";
import { toast } from "sonner";
import {
  useCarparksByApartment,
  useCreateCarpark,
  useDeactivateCarpark,
} from "@/api/carparks";
import { Car } from "lucide-react";
import { FormSection } from "./unit-form-fields";
import { CollapsibleSection } from "./collapsible-section";
import { cn } from "@/lib/utils";

export function CarparksSection({
  apartmentId,
  propertyId: _propertyId,
  collapsible = false,
}: {
  apartmentId: string;
  /** propertyId reserved for future cross-property picker; kept as a prop for
   *  consistency with the Task 2.2 interface contract. */
  propertyId: string;
  /** Fold behind a summary row (Edit-apartment shell). Default off keeps the
   *  always-open FormSection used by the component's isolation tests. */
  collapsible?: boolean;
}) {
  const { data, isLoading } = useCarparksByApartment(apartmentId);
  const bays = data?.data ?? [];

  const createMutation = useCreateCarpark();
  const deactivateMutation = useDeactivateCarpark();

  const [newLabel, setNewLabel] = useState("");
  const [newRate, setNewRate] = useState("");

  function handleAdd() {
    const label = newLabel.trim();
    const monthlyRate = newRate.trim();
    if (!label || !monthlyRate) return;

    createMutation.mutate(
      { apartmentId, label, monthlyRate },
      {
        onSuccess: () => {
          toast.success("Carpark bay added.");
          setNewLabel("");
          setNewRate("");
        },
        onError: (err: Error) => {
          toast.error(err.message || "Failed to add carpark.");
        },
      },
    );
  }

  function handleDeactivate(id: string) {
    deactivateMutation.mutate(id, {
      onSuccess: () => toast.success("Bay deactivated."),
      onError: (err: Error) => {
        toast.error(err.message || "Failed to deactivate — the bay may have an active rental.");
      },
    });
  }

  const body = (
    <>
      {/* Bay list */}
      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading carparks…</p>
      )}

      {!isLoading && bays.length === 0 && (
        <p className="text-sm italic text-muted-foreground">
          No carparks registered for this apartment.
        </p>
      )}

      {bays.map((bay) => (
        <div
          key={bay.id}
          className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2.5"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{bay.label}</p>
            <p className="text-xs text-muted-foreground">
              RM&nbsp;{bay.monthlyRate}/month ·{" "}
              <span className="italic">{bay.ownerName ?? "No owner"}</span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1",
                bay.status === "available"
                  ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/30"
                  : bay.status === "rented"
                    ? "bg-amber-500/10 text-amber-400 ring-amber-500/30"
                    : "bg-muted/40 text-muted-foreground ring-border/60",
              )}
            >
              {bay.status}
            </span>
            <button
              type="button"
              onClick={() => handleDeactivate(bay.id)}
              disabled={deactivateMutation.isPending || bay.status === "inactive"}
              className="text-xs text-rose-400 hover:text-rose-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Deactivate
            </button>
          </div>
        </div>
      ))}

      {/* Inline add row */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Bay label e.g. B1"
          className="min-h-9 flex-1 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <input
          type="number"
          min={0}
          step="0.01"
          value={newRate}
          onChange={(e) => setNewRate(e.target.value)}
          placeholder="Monthly rate (RM)"
          className="min-h-9 w-36 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={
            !newLabel.trim() || !newRate.trim() || createMutation.isPending
          }
          className="shrink-0 rounded-lg bg-[var(--primary)]/10 px-3 py-1.5 text-xs font-medium text-[var(--primary)] hover:bg-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {createMutation.isPending ? "Adding…" : "Add bay"}
        </button>
      </div>
    </>
  );

  if (collapsible) {
    return (
      <CollapsibleSection
        title="Carparks"
        icon={<Car className="h-3.5 w-3.5" />}
        summary={
          isLoading
            ? "Loading…"
            : bays.length
              ? `${bays.length} bay${bays.length === 1 ? "" : "s"}`
              : "No bays yet"
        }
      >
        {body}
      </CollapsibleSection>
    );
  }

  return <FormSection title="Carparks">{body}</FormSection>;
}
