import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { createRentalEntry, type CreateRentalEntryPayload } from "@/api/portal-rental-entries";
import { ListingSection, type RentalEntryFields } from "./listing-section";

type Props = {
  open: boolean;
  onClose: () => void;
};

const INITIAL: RentalEntryFields = {
  propertyId: "",
  unitCode: "",
  unitType: "apartment",
  bedrooms: "",
  bathrooms: "",
  furnishingLevel: "",
  baseRentAmount: "",
  depositMonths: "",
  utilitiesDepositMonths: "",
  publishedTitle: "",
  publishedDescription: "",
};

export function RentalEntryDrawer({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<RentalEntryFields>(INITIAL);

  const submit = useMutation({
    mutationFn: createRentalEntry,
    onSuccess: () => {
      toast.success("Rental Entry submitted");
      // Match the queryKey used by rentals-tab.tsx so the new listing
      // appears once it's approved (or as pending on admin side).
      qc.invalidateQueries({ queryKey: ["portal-own-units"] });
      onClose();
      setForm(INITIAL);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function build(): CreateRentalEntryPayload | null {
    if (!form.propertyId) { toast.error("Property is required."); return null; }
    if (!form.unitCode.trim()) { toast.error("Unit code is required."); return null; }
    if (!form.unitType.trim()) { toast.error("Unit type is required."); return null; }
    if (form.depositMonths === "") { toast.error("Rental deposit (months) is required."); return null; }
    if (form.utilitiesDepositMonths === "") { toast.error("Utilities deposit (months) is required."); return null; }
    return {
      propertyId: form.propertyId,
      unitCode: form.unitCode.trim(),
      unitType: form.unitType.trim(),
      bedrooms: form.bedrooms ? Number(form.bedrooms) : undefined,
      bathrooms: form.bathrooms ? Number(form.bathrooms) : undefined,
      furnishingLevel: form.furnishingLevel || undefined,
      baseRentAmount: form.baseRentAmount ? Number(form.baseRentAmount) : undefined,
      depositMonths: Number(form.depositMonths),
      utilitiesDepositMonths: Number(form.utilitiesDepositMonths),
      publishedTitle: form.publishedTitle || undefined,
      publishedDescription: form.publishedDescription || undefined,
    };
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title="New Rental Entry"
      description="List a unit for rent. Goes through admin approval before publishing. You become the unit's PIC."
      onSubmit={() => {
        const payload = build();
        if (payload) submit.mutate(payload);
      }}
      submit={{
        label: "Submit Listing",
        pendingLabel: "Submitting…",
        variant: "gold",
        pending: submit.isPending,
      }}
    >
      <ListingSection value={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
    </FormDrawer>
  );
}
