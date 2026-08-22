// apps/web/src/pages/portal/sales-pipeline.tsx
//
// W4a — Agent-facing Sales Pipeline page. Replaces the visual structure of
// `sales-mock/portal-sales-entry-page.tsx` with the real
// `/portal-api/sales/units` + `/portal-api/projects` endpoints (W2a/W2c).
//
// Routing + sidebar wiring is owned by W5 — this file only renders. Tests
// are owned by W6.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Building2,
  CheckCircle2,
  ClipboardEdit,
  ClipboardList,
  ClipboardX,
  Clock,
  FileText,
  Hammer,
  PlusCircle,
  Send,
  Sparkles,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GlowCard } from "@/components/ui/glow-card";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Segmented } from "@/components/ui/segmented";
import { Callout } from "@/components/ui/callout";
import { formatRM, formatDate } from "@/components/format";
import { PortalApiError } from "@/lib/portal-api";
import {
  createPortalProject,
  createPortalSalesUnit,
  deriveSalesUnitStatus,
  listPortalProjects,
  listPortalSalesUnits,
  SALES_UNIT_STATUS_LABEL,
  updatePortalSalesUnit,
  type CreatePortalProjectPayload,
  type CreatePortalSalesUnitPayload,
  type PortalProject,
  type PortalSalesUnit,
  type SalesPurpose,
  type SalesUnitStatus,
  type UpdatePortalSalesUnitPayload,
} from "@/api/portal-sales";

// ─── Status badge tones ─────────────────────────────────────────────────────

const STATUS_BADGE_VARIANT: Record<
  SalesUnitStatus,
  "amber" | "emerald" | "rose" | "sky"
> = {
  pending_review: "amber",
  approved: "emerald",
  needs_amendment: "rose",
  edited_post_approval: "sky",
};

// ─── Bedroom / bathroom encoding ────────────────────────────────────────────
//
// Backend encodes Studio as `-1` and "4+" as `4` (max), "3+" as `3` (max).
// We keep a single source of truth here so both the form and the detail
// renderer agree on the human label.

const BEDROOM_OPTIONS: Array<{ value: number; label: string }> = [
  { value: -1, label: "Studio" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4+" },
];

const BATHROOM_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3+" },
];

function bedroomLabel(value: number): string {
  return BEDROOM_OPTIONS.find((o) => o.value === value)?.label ?? String(value);
}

function bathroomLabel(value: number): string {
  return BATHROOM_OPTIONS.find((o) => o.value === value)?.label ?? String(value);
}

// ─── Form types ─────────────────────────────────────────────────────────────

type EntryFormState = {
  projectId: string;
  unitNumber: string;
  ownerPartyId: string;
  salesDate: string; // yyyy-mm-dd
  purpose: SalesPurpose;
  bedrooms: string;
  bathrooms: string;
  parkingLots: string;
  expectedRental: string;
  purchasePrice: string;
};

const EMPTY_FORM: EntryFormState = {
  projectId: "",
  unitNumber: "",
  ownerPartyId: "",
  salesDate: "",
  purpose: "rent",
  bedrooms: "",
  bathrooms: "",
  parkingLots: "0",
  expectedRental: "",
  purchasePrice: "",
};

type ProjectFormState = {
  name: string;
  developer: string;
  city: string;
  expectedHandover: string; // yyyy-mm-dd
  notes: string;
};

const EMPTY_PROJECT_FORM: ProjectFormState = {
  name: "",
  developer: "",
  city: "",
  expectedHandover: "",
  notes: "",
};

// ─── Form ↔ payload conversion ──────────────────────────────────────────────

function toIsoDateTime(yyyyMmDd: string): string {
  // The backend validator requires a full ISO datetime. We append midnight
  // UTC so a date-only input still passes `z.string().datetime()`.
  return new Date(`${yyyyMmDd}T00:00:00Z`).toISOString();
}

type FormError = string;

function validateForm(form: EntryFormState): FormError | null {
  if (!form.projectId) return "Project is required.";
  if (!form.unitNumber.trim()) return "Unit number is required.";
  if (!form.ownerPartyId.trim()) return "Owner is required.";
  if (!form.salesDate) return "Sales date is required.";
  if (!form.bedrooms) return "Bedrooms is required.";
  if (!form.bathrooms) return "Bathrooms is required.";
  if (!form.purchasePrice || Number(form.purchasePrice) <= 0) {
    return "Purchase price must be greater than zero.";
  }
  if (form.purpose === "rent") {
    if (!form.expectedRental || Number(form.expectedRental) <= 0) {
      return "Expected rental is required when purpose is Rent.";
    }
  }
  return null;
}

function buildCreatePayload(
  form: EntryFormState,
): CreatePortalSalesUnitPayload {
  const payload: CreatePortalSalesUnitPayload = {
    projectId: form.projectId,
    unitNumber: form.unitNumber.trim(),
    ownerPartyId: form.ownerPartyId.trim(),
    salesDate: toIsoDateTime(form.salesDate),
    purpose: form.purpose,
    bedrooms: Number(form.bedrooms),
    bathrooms: Number(form.bathrooms),
    parkingLots: form.parkingLots ? Number(form.parkingLots) : 0,
    purchasePrice: Number(form.purchasePrice),
  };
  if (form.purpose === "rent" && form.expectedRental) {
    payload.expectedRental = Number(form.expectedRental);
  }
  return payload;
}

function buildUpdatePayload(
  form: EntryFormState,
): UpdatePortalSalesUnitPayload {
  const payload: UpdatePortalSalesUnitPayload = {
    projectId: form.projectId,
    unitNumber: form.unitNumber.trim(),
    ownerPartyId: form.ownerPartyId.trim(),
    salesDate: toIsoDateTime(form.salesDate),
    purpose: form.purpose,
    bedrooms: Number(form.bedrooms),
    bathrooms: Number(form.bathrooms),
    parkingLots: form.parkingLots ? Number(form.parkingLots) : 0,
    purchasePrice: Number(form.purchasePrice),
    // Always send expectedRental on edit so toggling Rent → Own Stay clears
    // it (null) and Own Stay → Rent populates it.
    expectedRental:
      form.purpose === "rent" && form.expectedRental
        ? Number(form.expectedRental)
        : null,
  };
  return payload;
}

function rowToFormState(unit: PortalSalesUnit): EntryFormState {
  return {
    projectId: unit.projectId,
    unitNumber: unit.unitNumber,
    ownerPartyId: unit.ownerPartyId,
    salesDate: unit.salesDate.slice(0, 10),
    purpose: unit.purpose,
    bedrooms: String(unit.bedrooms),
    bathrooms: String(unit.bathrooms),
    parkingLots: String(unit.parkingLots),
    expectedRental: unit.expectedRental != null ? String(unit.expectedRental) : "",
    purchasePrice: String(unit.purchasePrice),
  };
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PortalSalesPipelinePage() {
  const queryClient = useQueryClient();

  const [submitOpen, setSubmitOpen] = useState(false);
  const [editUnitId, setEditUnitId] = useState<string | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [form, setForm] = useState<EntryFormState>(EMPTY_FORM);
  const [projectForm, setProjectForm] = useState<ProjectFormState>(
    EMPTY_PROJECT_FORM,
  );
  const [formError, setFormError] = useState<string | null>(null);

  // ── Reads ────────────────────────────────────────────────────────────────

  const projectsQuery = useQuery({
    queryKey: ["portal-projects"],
    queryFn: () => listPortalProjects(),
    staleTime: 30_000,
  });

  const unitsQuery = useQuery({
    queryKey: ["portal-sales-units"],
    queryFn: () => listPortalSalesUnits(),
    staleTime: 15_000,
  });

  const projects = projectsQuery.data?.data ?? [];
  const units = unitsQuery.data?.data ?? [];

  // Project lookup map for cheap render-time joins.
  const projectById = useMemo(() => {
    const m = new Map<string, PortalProject>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  // ── Stats — driven by derived UI status ──────────────────────────────────

  const stats = useMemo(() => {
    const counts = {
      total: units.length,
      pending: 0,
      approved: 0,
      needsAmendment: 0,
      editedPostApproval: 0,
    };
    for (const u of units) {
      const s = deriveSalesUnitStatus(u);
      if (s === "pending_review") counts.pending += 1;
      else if (s === "approved") counts.approved += 1;
      else if (s === "needs_amendment") counts.needsAmendment += 1;
      else if (s === "edited_post_approval") counts.editedPostApproval += 1;
    }
    return counts;
  }, [units]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const createUnitMutation = useMutation({
    mutationFn: (payload: CreatePortalSalesUnitPayload) =>
      createPortalSalesUnit(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-sales-units"] });
      toast.success("Sales entry submitted", {
        description: "An admin will review it for sourcing approval.",
      });
      closeSubmitDrawer();
    },
    onError: handleMutationError,
  });

  const updateUnitMutation = useMutation({
    mutationFn: (vars: { id: string; payload: UpdatePortalSalesUnitPayload }) =>
      updatePortalSalesUnit(vars.id, vars.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-sales-units"] });
      toast.success("Sales entry updated");
      closeSubmitDrawer();
    },
    onError: handleMutationError,
  });

  const createProjectMutation = useMutation({
    mutationFn: (payload: CreatePortalProjectPayload) =>
      createPortalProject(payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["portal-projects"] });
      // Auto-select the freshly created project in the parent form so the
      // agent can finish their sales entry without re-picking it.
      setForm((f) => ({ ...f, projectId: res.data.id }));
      setProjectForm(EMPTY_PROJECT_FORM);
      setCreateProjectOpen(false);
      toast.success("Project created", {
        description: "Pending manager verification — you can still submit sales entries against it.",
      });
    },
    onError: handleMutationError,
  });

  function handleMutationError(err: unknown) {
    // Try to surface field-level Zod errors when the API returns them.
    // Shape (formatZodError): { error: "...", fieldErrors: { foo: "..." } }.
    // The old `details.fieldErrors` nesting + string[] shape was a pre-T11
    // artifact — it silently dropped every field hint and left the agent
    // staring at "Invalid sales unit payload" with no clue which field
    // (e.g. ownerPartyId not being a UUID) actually failed.
    let msg = "Something went wrong";
    if (err instanceof PortalApiError) {
      msg = err.message;
      const fieldErrors = (err.body as { fieldErrors?: Record<string, string> } | null)
        ?.fieldErrors;
      if (fieldErrors) {
        const lines = Object.entries(fieldErrors)
          .filter(([, text]) => typeof text === "string" && text.length > 0)
          .map(([field, text]) => `${field}: ${text}`);
        if (lines.length > 0) msg = lines.join(" · ");
      }
    } else if (err instanceof Error) {
      msg = err.message;
    }
    setFormError(msg);
    toast.error("Action failed", { description: msg });
  }

  // ── Drawer state helpers ─────────────────────────────────────────────────

  const editingUnit = editUnitId
    ? units.find((u) => u.id === editUnitId) ?? null
    : null;
  const isEditing = !!editingUnit;

  function openNewDrawer() {
    setForm(EMPTY_FORM);
    setEditUnitId(null);
    setFormError(null);
    setSubmitOpen(true);
  }

  function openEditDrawer(unit: PortalSalesUnit) {
    setForm(rowToFormState(unit));
    setEditUnitId(unit.id);
    setFormError(null);
    setSubmitOpen(true);
  }

  function closeSubmitDrawer() {
    setSubmitOpen(false);
    setEditUnitId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  // ── Submit handlers ──────────────────────────────────────────────────────

  function handleSubmitEntry() {
    setFormError(null);
    const error = validateForm(form);
    if (error) {
      setFormError(error);
      return;
    }
    if (isEditing && editingUnit) {
      updateUnitMutation.mutate({
        id: editingUnit.id,
        payload: buildUpdatePayload(form),
      });
    } else {
      createUnitMutation.mutate(buildCreatePayload(form));
    }
  }

  function handleCreateProject() {
    setFormError(null);
    if (!projectForm.name.trim()) {
      setFormError("Project name is required.");
      return;
    }
    if (!projectForm.developer.trim()) {
      setFormError("Developer is required.");
      return;
    }
    const payload: CreatePortalProjectPayload = {
      name: projectForm.name.trim(),
      developer: projectForm.developer.trim(),
    };
    if (projectForm.city.trim()) payload.city = projectForm.city.trim();
    if (projectForm.expectedHandover) {
      payload.expectedHandover = toIsoDateTime(projectForm.expectedHandover);
    }
    if (projectForm.notes.trim()) payload.notes = projectForm.notes.trim();
    createProjectMutation.mutate(payload);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const isSavingEntry =
    createUnitMutation.isPending || updateUnitMutation.isPending;
  // Whether the row being edited was previously approved — surfaces the
  // "this edit will re-enter review" warning called out by the spec.
  const editingApproved = editingUnit?.sourcingApproved === true;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Sparkles className="h-8 w-8 text-primary" />
            Sales Pipeline
          </h1>
          <p className="text-muted-foreground mt-1">
            Submit and track your secured off-plan sales entries. Approved entries
            unlock Renovation and Sales Commission claims.
          </p>
        </div>
        <Button variant="gold" onClick={openNewDrawer}>
          <PlusCircle className="h-4 w-4" /> New Entry
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          glow="blue"
          label="Total entries"
          value={stats.total}
          hint="secured by you"
          icon={<Building2 className="h-6 w-6 text-blue-600" />}
          iconBg="bg-blue-500/10"
        />
        <StatCard
          glow="orange"
          label="Pending review"
          value={stats.pending}
          hint="awaiting admin"
          icon={<Clock className="h-6 w-6 text-amber-600" />}
          iconBg="bg-amber-500/10"
        />
        <StatCard
          glow="green"
          label="Approved"
          value={stats.approved}
          hint="claim-ready"
          icon={<CheckCircle2 className="h-6 w-6 text-emerald-600" />}
          iconBg="bg-emerald-500/10"
        />
        <StatCard
          glow="red"
          label="Needs amendment"
          value={stats.needsAmendment}
          hint="follow up with admin notes"
          icon={<ClipboardX className="h-6 w-6 text-rose-600" />}
          iconBg="bg-rose-500/10"
        />
        <StatCard
          glow="purple"
          label="Edited post-approval"
          value={stats.editedPostApproval}
          hint="re-entered review"
          icon={<ClipboardEdit className="h-6 w-6 text-sky-600" />}
          iconBg="bg-sky-500/10"
        />
      </div>

      {/* List */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            My Sales Entries
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {unitsQuery.isLoading ? (
            <div className="space-y-2 animate-pulse">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 rounded-lg bg-background/40 border border-border/50"
                />
              ))}
            </div>
          ) : unitsQuery.isError ? (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-4 text-sm text-rose-500">
              Failed to load sales entries.{" "}
              {(unitsQuery.error as Error)?.message ?? "Please refresh."}
            </div>
          ) : units.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-6 text-center">
              No sales entries yet. Click "New Entry" to add your first.
            </p>
          ) : (
            units.map((unit) => (
              <SalesEntryRow
                key={unit.id}
                unit={unit}
                project={projectById.get(unit.projectId)}
                onEdit={() => openEditDrawer(unit)}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* New / Edit drawer */}
      <FormDrawer
        open={submitOpen}
        onClose={closeSubmitDrawer}
        size="lg"
        title={isEditing ? "Edit Sales Entry" : "New Sales Entry"}
        description={
          isEditing
            ? "Update the deal details. The form re-uses the same fields as submission."
            : "Submit immediately once the deal is secured."
        }
        warning={
          editingApproved
            ? {
                variant: "warning",
                title: "This entry was previously approved",
                body: (
                  <>
                    Saving changes will re-enter the source-approval queue. The
                    "Approved" badge will revert until an admin re-approves the
                    edited row.
                  </>
                ),
              }
            : undefined
        }
        onSubmit={handleSubmitEntry}
        submit={{
          label: isEditing ? "Save changes" : "Submit",
          pendingLabel: isEditing ? "Saving…" : "Submitting…",
          variant: "gold",
          icon: Send,
          pending: isSavingEntry,
        }}
      >
        <div className="space-y-4">
          {/* Project picker + create-new */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Project
              </label>
              <button
                type="button"
                onClick={() => setCreateProjectOpen(true)}
                className="text-xs font-medium text-[var(--gold)] hover:underline"
              >
                + Create new project
              </button>
            </div>
            <select
              value={form.projectId}
              onChange={(e) =>
                setForm({ ...form, projectId: e.target.value })
              }
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-2 text-sm"
              disabled={projectsQuery.isLoading}
            >
              <option value="">
                {projectsQuery.isLoading
                  ? "Loading projects…"
                  : "Select a project…"}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.developer}
                  {p.status !== "active" ? ` (${p.status})` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Unit number */}
          <FormField label="Unit Number">
            <Input
              value={form.unitNumber}
              onChange={(e) =>
                setForm({ ...form, unitNumber: e.target.value })
              }
              placeholder="e.g. A-12-01"
            />
          </FormField>

          {/* Owner — UUID input.
              There is no portal Owners search endpoint today (the admin
              /api/parties/owners route is operator-only). We accept a
              Party UUID and surface a helper line so the agent can paste
              the value supplied by their PIC. A typeahead picker is a
              future enhancement once a portal-side endpoint exists. */}
          <FormField
            label="Owner Party ID"
            hint="UUID of the buyer (Party). Ask your PIC for the ID if you don't have it."
          >
            <Input
              value={form.ownerPartyId}
              onChange={(e) =>
                setForm({ ...form, ownerPartyId: e.target.value })
              }
              placeholder="e.g. 8a1c8f2c-…"
            />
          </FormField>

          {/* Sales date */}
          <FormField label="Sales Date">
            <Input
              type="date"
              value={form.salesDate}
              onChange={(e) =>
                setForm({ ...form, salesDate: e.target.value })
              }
            />
          </FormField>

          {/* Purpose */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Purpose
            </label>
            <div className="mt-1">
              <Segmented<SalesPurpose>
                value={form.purpose}
                onChange={(v) => setForm({ ...form, purpose: v })}
                options={[
                  { value: "rent", label: "Rent" },
                  { value: "own_stay", label: "Own Stay" },
                ]}
                ariaLabel="Purpose"
              />
            </div>
          </div>

          {/* Bedrooms / Bathrooms / Parking */}
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Bedrooms">
              <select
                value={form.bedrooms}
                onChange={(e) =>
                  setForm({ ...form, bedrooms: e.target.value })
                }
                className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-2 text-sm"
              >
                <option value="">—</option>
                {BEDROOM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Bathrooms">
              <select
                value={form.bathrooms}
                onChange={(e) =>
                  setForm({ ...form, bathrooms: e.target.value })
                }
                className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-2 text-sm"
              >
                <option value="">—</option>
                {BATHROOM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Parking Lots">
              <Input
                type="number"
                min={0}
                max={20}
                value={form.parkingLots}
                onChange={(e) =>
                  setForm({ ...form, parkingLots: e.target.value })
                }
              />
            </FormField>
          </div>

          {/* Expected rental (only when rent) */}
          {form.purpose === "rent" ? (
            <FormField
              label="Owner Expected Rental (RM/month)"
              hint="Required for rent-purpose units."
            >
              <Input
                type="number"
                min={0}
                value={form.expectedRental}
                onChange={(e) =>
                  setForm({ ...form, expectedRental: e.target.value })
                }
                placeholder="e.g. 3200"
              />
            </FormField>
          ) : null}

          {/* Purchase price */}
          <FormField label="Purchase Price (RM)">
            <Input
              type="number"
              min={0}
              value={form.purchasePrice}
              onChange={(e) =>
                setForm({ ...form, purchasePrice: e.target.value })
              }
              placeholder="e.g. 850000"
            />
          </FormField>

          {/* Inline error */}
          {formError ? <Callout variant="danger">{formError}</Callout> : null}
        </div>
      </FormDrawer>

      {/* Create-new-project sub-drawer.
          Mounted alongside the entry drawer so the entry stays open behind
          it — the parent state preserves the in-progress form. */}
      <FormDrawer
        open={createProjectOpen}
        onClose={() => {
          setCreateProjectOpen(false);
          setProjectForm(EMPTY_PROJECT_FORM);
        }}
        size="md"
        title="Create new project"
        description={
          <>
            Adds the project as <strong>unverified</strong>. Managers must
            promote it to active, but you can still attach sales entries
            against it in the meantime.
          </>
        }
        onSubmit={handleCreateProject}
        submit={{
          label: "Create",
          pendingLabel: "Creating…",
          variant: "gold",
          icon: PlusCircle,
          pending: createProjectMutation.isPending,
        }}
      >
        <div className="space-y-4">
          <FormField label="Project Name">
            <Input
              value={projectForm.name}
              onChange={(e) =>
                setProjectForm({ ...projectForm, name: e.target.value })
              }
              placeholder="e.g. The Quartz Residence"
            />
          </FormField>
          <FormField label="Developer">
            <Input
              value={projectForm.developer}
              onChange={(e) =>
                setProjectForm({ ...projectForm, developer: e.target.value })
              }
              placeholder="e.g. Sunway Property"
            />
          </FormField>
          <FormField label="City (optional)">
            <Input
              value={projectForm.city}
              onChange={(e) =>
                setProjectForm({ ...projectForm, city: e.target.value })
              }
              placeholder="e.g. Petaling Jaya"
            />
          </FormField>
          <FormField label="Expected Handover (optional)">
            <Input
              type="date"
              value={projectForm.expectedHandover}
              onChange={(e) =>
                setProjectForm({
                  ...projectForm,
                  expectedHandover: e.target.value,
                })
              }
            />
          </FormField>
          <FormField label="Notes (optional)">
            <textarea
              rows={3}
              value={projectForm.notes}
              onChange={(e) =>
                setProjectForm({ ...projectForm, notes: e.target.value })
              }
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm"
              placeholder="Anything the admin should know"
            />
          </FormField>

          {formError ? <Callout variant="danger">{formError}</Callout> : null}
        </div>
      </FormDrawer>
    </div>
  );
}

// ─── Sub-components (file-local) ────────────────────────────────────────────

function StatCard({
  glow,
  label,
  value,
  hint,
  icon,
  iconBg,
}: {
  glow: "blue" | "orange" | "green" | "red" | "purple" | "gold";
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  iconBg: string;
}) {
  return (
    <GlowCard
      glowColor={glow}
      className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
    >
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="text-3xl font-bold text-foreground">{value}</p>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{hint}</span>
          </div>
        </div>
        <div className={`p-3 rounded-xl ${iconBg}`}>{icon}</div>
      </div>
    </GlowCard>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function SalesEntryRow({
  unit,
  project,
  onEdit,
}: {
  unit: PortalSalesUnit;
  project: PortalProject | undefined;
  onEdit: () => void;
}) {
  const status = deriveSalesUnitStatus(unit);
  const isApproved = status === "approved";
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <Building2 className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-foreground block">
              {project?.name ?? "Project"} · {unit.unitNumber}
            </span>
            <span className="text-xs text-muted-foreground block">
              {unit.purpose === "rent" ? "Rent" : "Own Stay"} ·{" "}
              {bedroomLabel(unit.bedrooms)} BR · {bathroomLabel(unit.bathrooms)} BA ·{" "}
              {unit.parkingLots} parking · sold {formatDate(unit.salesDate)}
            </span>
            <span className="text-xs text-muted-foreground block">
              Purchase {formatRM(unit.purchasePrice)}
              {unit.expectedRental != null
                ? ` · Expected rental ${formatRM(unit.expectedRental)}/month`
                : ""}
            </span>
            {unit.amendmentNotes ? (
              <span className="mt-1 inline-block text-xs italic text-amber-500">
                Note: {unit.amendmentNotes}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Badge variant={STATUS_BADGE_VARIANT[status]}>
            {SALES_UNIT_STATUS_LABEL[status]}
          </Badge>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <ClipboardEdit className="h-3.5 w-3.5" /> Edit
          </Button>
          {isApproved ? (
            <>
              {/* React Router Link, not <a>: keeps SPA state (queries, drawer
                  prefill side-effect) instead of hard-reloading. The target
                  routes are registered in router.tsx and the destination
                  pages auto-open the new-claim drawer pre-filled with this
                  salesUnitId. */}
              <Link
                to={`/portal/renovation-claims/new?salesUnitId=${unit.id}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-background/80"
              >
                <Hammer className="h-3.5 w-3.5" /> Renovation Claim
              </Link>
              <Link
                to={`/portal/sales-claims/new?salesUnitId=${unit.id}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-background/80"
              >
                <FileText className="h-3.5 w-3.5" /> Sales Claim
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
