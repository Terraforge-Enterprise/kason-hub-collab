import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Callout } from "@/components/ui/callout";
import { ActionButton, Field, SelectInput } from "@/components/form-ui";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { getApartmentsByProperty, updateApartmentShared } from "@/api/inventory-units-batch";
import type { PropertyListItem } from "@/pages/inventory/property-row";

// Fallback for non-ApiError failures (network drops, thrown TypeErrors) that
// still carry a usable .message via the Error prototype — never crashes,
// never silently no-ops. Mirrors assign-tenant-to-unit-dialog.tsx.
function genericMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

export function AssignOwnerToUnitDialog({
  owner,
  open,
  onOpenChange,
}: {
  owner: { id: string; displayName: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const [propertyId, setPropertyId] = useState("");
  const [apartmentId, setApartmentId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  // Synchronous double-fire guard. `submit.isPending` is not enough: two
  // fireEvent.click calls in the same tick both read isPending===false
  // because React hasn't flushed the mutation's first setState yet. A ref
  // is mutated synchronously, so the second click sees the lock immediately.
  const submitLockRef = useRef(false);

  function resetAll() {
    setPropertyId("");
    setApartmentId("");
    setConfirmOpen(false);
    setBannerError(null);
    submitLockRef.current = false;
  }

  function handleOpenChange(v: boolean) {
    if (!v) resetAll();
    onOpenChange(v);
  }

  const propertiesQuery = useQuery({
    queryKey: ["inventory", "properties"],
    queryFn: () => apiFetch<{ data: PropertyListItem[] }>("/inventory/properties"),
    enabled: open,
  });
  const properties = propertiesQuery.data?.data ?? [];

  const apartmentsQuery = useQuery({
    queryKey: ["inventory", "apartments-by-property", propertyId],
    queryFn: () => getApartmentsByProperty(propertyId),
    enabled: open && !!propertyId,
  });
  // R5 — the apartment picker is deliberately NOT owner-filtered: re-pointing
  // ownership is the whole point, so every apartment in the property is
  // pickable regardless of its current ownerPartyId.
  const apartments = apartmentsQuery.data ?? [];

  const submit = useMutation({
    mutationFn: () => updateApartmentShared(apartmentId, { ownerPartyId: owner.id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      toast.success("Owner assigned to apartment.");
      resetAll();
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      // Dialog-level banner only — this dialog has no free-text fields to
      // attach a field-specific error to, unlike the tenant dialog.
      setConfirmOpen(false); // back to the picker; dialog stays open
      setBannerError(err instanceof ApiError ? err.message : genericMsg(err));
    },
    onSettled: () => {
      submitLockRef.current = false;
    },
  });

  function handlePropertyChange(id: string) {
    setPropertyId(id);
    // A stale apartment picked under the previous property must never ride
    // along with a switched propertyId — that would PATCH a cross-property
    // apartment id.
    setApartmentId("");
  }

  function handleConfirm() {
    // Defense-in-depth: the confirm's own button has no `disabled` prop in
    // the ConfirmAlert API, so a rapid double-click before React re-renders
    // could otherwise double-fire the PATCH. `submit.isPending` alone is not
    // enough — two synchronous clicks in the same tick both read isPending
    // as false, since React hasn't flushed the first mutate()'s state yet.
    // The ref lock is set synchronously, so the second click sees it.
    if (submitLockRef.current || submit.isPending) return;
    submitLockRef.current = true;
    submit.mutate();
  }

  const canSubmit = !!apartmentId;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          {/* Deliberately says "a unit" not "an apartment" — the latter would
              collide with the "Apartment" field's accessible name, since
              RTL's getByLabelText also matches this aria-labelledby target. */}
          <DialogTitle>Assign {owner.displayName} to a unit</DialogTitle>
          <DialogDescription>
            Pick an apartment to re-point its ownership to {owner.displayName}.
          </DialogDescription>
        </DialogHeader>

        {bannerError && (
          <Callout variant="danger" title="Couldn't assign owner">
            {bannerError}
          </Callout>
        )}

        <div className="grid gap-4">
          <Field label="Property">
            <SelectInput
              value={propertyId}
              onChange={(e) => handlePropertyChange(e.target.value)}
              disabled={propertiesQuery.isLoading}
            >
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          {propertiesQuery.isError && (
            <Callout variant="danger" title="Couldn't load properties">
              <span className="mr-2">Try again.</span>
              <ActionButton
                type="button"
                variant="secondary"
                onClick={() => propertiesQuery.refetch()}
              >
                Retry
              </ActionButton>
            </Callout>
          )}

          {propertyId &&
            (apartmentsQuery.isLoading ? (
              <p className="text-sm text-[var(--text-muted)]">Loading apartments…</p>
            ) : apartmentsQuery.isError ? (
              <Callout variant="danger" title="Couldn't load apartments for this property">
                <ActionButton
                  type="button"
                  variant="secondary"
                  onClick={() => apartmentsQuery.refetch()}
                >
                  Retry
                </ActionButton>
              </Callout>
            ) : apartments.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                No apartments in this property.
              </p>
            ) : (
              <Field label="Apartment">
                <SelectInput
                  value={apartmentId}
                  onChange={(e) => setApartmentId(e.target.value)}
                >
                  <option value="">Select apartment…</option>
                  {apartments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.unitCode}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            ))}
        </div>

        <DialogFooter>
          <ActionButton
            type="button"
            variant="primary"
            disabled={!canSubmit || submit.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            Assign to unit
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => handleOpenChange(false)}
            disabled={submit.isPending}
          >
            Cancel
          </ActionButton>
        </DialogFooter>
      </DialogContent>

      <ConfirmAlert
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        title="Re-point this apartment's owner?"
        body={
          <span>
            Changing the owner re-points <strong>every room in this apartment</strong>{" "}
            and <strong>every active carpark bay</strong> to{" "}
            <strong>{owner.displayName || "the new owner"}</strong>, and re-materialises
            both the previous and the new owner&apos;s ledgers. This applies
            immediately.
          </span>
        }
        confirmLabel="Re-point owner"
      />
    </Dialog>
  );
}
