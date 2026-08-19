import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { createSalesEntry, type CreateSalesEntryPayload } from "@/api/portal-sales-entries";
import { ProjectSection, type ProjectInput } from "./project-section";
import { UnitSection } from "./unit-section";
import { PropertyProfileSection } from "./property-profile-section";
import { RenovationSection, type RenovationInput } from "./renovation-section";

type Props = {
  open: boolean;
  onClose: () => void;
};

type FormState = {
  project: ProjectInput;
  unitNumber: string;
  ownerPartyId: string;
  ownerDisplayName: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  purchasePrice: string;
  bedrooms: string;
  bathrooms: string;
  parkingLots: string;
  expectedRental: string;
  renovation: RenovationInput | null;
};

const TODAY_ISO = new Date().toISOString().slice(0, 10);

const INITIAL: FormState = {
  project: { mode: "existing", id: "" },
  unitNumber: "",
  ownerPartyId: "",
  ownerDisplayName: "",
  salesDate: TODAY_ISO,
  purpose: "own_stay",
  purchasePrice: "",
  bedrooms: "",
  bathrooms: "",
  parkingLots: "0",
  expectedRental: "",
  renovation: null,
};

export function SalesEntryDrawer({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(INITIAL);

  const submit = useMutation({
    mutationFn: createSalesEntry,
    onSuccess: () => {
      toast.success("Sales Entry submitted");
      qc.invalidateQueries({ queryKey: ["portal-sales-units"] });
      qc.invalidateQueries({ queryKey: ["portal-projects"] });
      qc.invalidateQueries({ queryKey: ["portal-sales-claims"] });
      qc.invalidateQueries({ queryKey: ["portal-renovation-claims"] });
      onClose();
      setForm(INITIAL);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function buildPayload(): CreateSalesEntryPayload | null {
    const purchasePrice = Number(form.purchasePrice);
    const bedrooms = Number(form.bedrooms);
    const bathrooms = Number(form.bathrooms);
    const parkingLots = Number(form.parkingLots);
    const expectedRental = form.expectedRental ? Number(form.expectedRental) : undefined;

    if (form.project.mode === "existing" && !form.project.id) {
      toast.error("Select a project."); return null;
    }
    if (form.project.mode === "new" && (!form.project.name || !form.project.developer)) {
      toast.error("Project name and developer are required."); return null;
    }
    if (!form.unitNumber.trim()) { toast.error("Unit number is required."); return null; }
    if (!form.ownerPartyId) { toast.error("Owner is required."); return null; }
    if (!isFinite(purchasePrice) || purchasePrice <= 0) {
      toast.error("Purchase price is required."); return null;
    }
    if (!isFinite(bedrooms) || !isFinite(bathrooms)) {
      toast.error("Bedrooms and bathrooms are required."); return null;
    }
    if (form.purpose === "rent" && (!expectedRental || expectedRental <= 0)) {
      toast.error("Expected rental is required when purpose is Rent."); return null;
    }

    return {
      project: form.project,
      unitNumber: form.unitNumber.trim(),
      ownerPartyId: form.ownerPartyId,
      salesDate: new Date(form.salesDate).toISOString(),
      purpose: form.purpose,
      purchasePrice,
      bedrooms,
      bathrooms,
      parkingLots,
      expectedRental,
      renovation: form.renovation
        ? {
            packageId: form.renovation.packageId,
            packagePrice: form.renovation.packagePrice,
            paymentType: form.renovation.paymentType,
            monthlyOffsetAmount: form.renovation.monthlyOffsetAmount,
            splits: form.renovation.splits,
            notes: form.renovation.notes,
            documents: form.renovation.documents,
          }
        : undefined,
    };
  }

  function handleSubmit() {
    const payload = buildPayload();
    if (payload) submit.mutate(payload);
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="lg"
      title="New Sales Entry"
      description="Files the unit into the pipeline. Auto-creates a sales-commission claim. Optional renovation block creates a renovation claim and seeds construction tracking."
      onSubmit={handleSubmit}
      submit={{
        label: "Submit Entry",
        pendingLabel: "Submitting…",
        variant: "gold",
        pending: submit.isPending,
      }}
    >
      <div className="space-y-6">
        <ProjectSection
          value={form.project}
          onChange={(project) => setForm((f) => ({ ...f, project }))}
        />
        <UnitSection
          unitNumber={form.unitNumber}
          ownerPartyId={form.ownerPartyId}
          ownerDisplayName={form.ownerDisplayName}
          salesDate={form.salesDate}
          purpose={form.purpose}
          purchasePrice={form.purchasePrice}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />
        <PropertyProfileSection
          bedrooms={form.bedrooms}
          bathrooms={form.bathrooms}
          parkingLots={form.parkingLots}
          expectedRental={form.expectedRental}
          purpose={form.purpose}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />
        <RenovationSection
          value={form.renovation}
          onChange={(renovation) => setForm((f) => ({ ...f, renovation }))}
        />
      </div>
    </FormDrawer>
  );
}
