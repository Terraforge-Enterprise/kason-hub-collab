/**
 * Admin Renovation Settings (W3d).
 *
 * Tabbed admin console for the renovation-claim configuration surface:
 *   1. Packages       — RenovationPackage CRUD (create/edit, archive)
 *   2. Default Splits — per-package split editor (drawer-shared with Packages)
 *   3. Status Labels  — claim_status + renovation_status SettingsLabel rows
 *   4. Document Types — document_kind SettingsLabel rows
 *
 * RBAC: admin-only. Editor / manager / portal users see a Forbidden card.
 *
 * Tab state lives in `?tab=...` so deep-links work and back/forward navigates
 * between sub-areas.
 *
 * Backend dependency note: the Status / Documents tabs depend on the W2d
 * settings-label endpoints at `/settings/renovation/labels`. Those have been
 * built and registered in `apps/api/src/app.ts` — both apps share the same
 * branch. If for any reason a test environment runs an older API the labels
 * tabs will fall back to an empty list with a soft error banner.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  CheckCircle2,
  FileText,
  Hammer,
  Layers,
  ListChecks,
  ListOrdered,
  Lock,
  Pencil,
  Plus,
  Tag,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { RenovationStagesSection } from "@/pages/settings/shared-sections/renovation-stages-section";
import { SalesClaimDefaultsSection } from "@/pages/settings/shared-sections/sales-claim-defaults-section";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { Field, TextInput, TextAreaInput, SelectInput } from "@/components/form-ui";
import {
  IMMUTABLE_CLAIM_STATUS_KEYS,
  IMMUTABLE_DOCUMENT_KIND_KEYS,
  IMMUTABLE_RENOVATION_STATUS_KEYS,
  createRenovationLabel,
  createRenovationPackage,
  deleteRenovationLabel,
  listRenovationLabels,
  listRenovationPackages,
  updateRenovationLabel,
  updateRenovationPackage,
  type CreatePackagePayload,
  type LabelCategory,
  type PackageSplitInput,
  type RenovationPackage,
  type RenovationPackageSplit,
  type SettingsLabel,
  type SplitType,
  type UpdatePackagePayload,
} from "@/api/renovation-settings";

// ─── Tab plumbing ────────────────────────────────────────────────────────────

type TabKey = "sales" | "packages" | "splits" | "status" | "docs" | "stages";
const TAB_KEYS: TabKey[] = ["sales", "packages", "splits", "status", "docs", "stages"];

const TAB_LABELS: Record<TabKey, string> = {
  sales: "Sales Defaults",
  packages: "Renovation Packages",
  splits: "Default Splits",
  status: "Status Labels",
  docs: "Document Types",
  stages: "Pipeline Stages",
};

const TAB_ICONS: Record<TabKey, typeof Layers> = {
  sales: ListChecks,
  packages: Layers,
  splits: Wallet,
  status: Tag,
  docs: FileText,
  stages: ListOrdered,
};

function isTabKey(v: string | null): v is TabKey {
  return v != null && (TAB_KEYS as string[]).includes(v);
}

const DEFAULT_TAB: TabKey = "sales";

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RenovationSettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: TabKey = isTabKey(rawTab) ? rawTab : DEFAULT_TAB;

  // Normalise an unknown tab param back to the default — keeps URL clean
  // when somebody hand-edits to ?tab=foo.
  useEffect(() => {
    if (rawTab !== null && !isTabKey(rawTab)) {
      setSearchParams({ tab: DEFAULT_TAB }, { replace: true });
    }
  }, [rawTab, setSearchParams]);

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Sales & Renovation Settings"
          description="Sales defaults plus renovation packages, splits, labels, and pipeline stages."
        />
        <Surface>
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <Lock className="h-8 w-8 text-[var(--text-muted)]" />
            <p className="text-sm font-semibold text-[var(--text-primary)]">Forbidden</p>
            <p className="max-w-md text-sm text-[var(--text-secondary)]">
              These settings are restricted to Admin users. Ask an admin to make the
              configuration change you need.
            </p>
          </div>
        </Surface>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales & Renovation Settings"
        description="Sales-claim defaults, renovation packages, splits, labels, document types, and the construction pipeline stages."
        icon={Hammer}
      />

      <div
        className="flex flex-wrap gap-1 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-1 shadow-sm"
        role="tablist"
        aria-label="Renovation settings tabs"
      >
        {TAB_KEYS.map((key) => {
          const Icon = TAB_ICONS[key];
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSearchParams({ tab: key })}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                active
                  ? "bg-[var(--primary)] text-white shadow-sm"
                  : "text-[var(--text-secondary)] hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {TAB_LABELS[key]}
            </button>
          );
        })}
      </div>

      {tab === "sales" && <SalesClaimDefaultsSection canWrite={isAdmin} />}
      {tab === "packages" && <PackagesTab />}
      {tab === "splits" && <DefaultSplitsTab />}
      {tab === "status" && <StatusLabelsTab />}
      {tab === "docs" && <DocumentTypesTab />}
      {tab === "stages" && <RenovationStagesSection canWrite={isAdmin} />}
    </div>
  );
}

// ─── Packages tab ────────────────────────────────────────────────────────────

function PackagesTab() {
  const queryClient = useQueryClient();
  const packagesQ = useQuery({
    queryKey: ["renovation", "packages", "all"],
    queryFn: () => listRenovationPackages(),
  });

  const [editingPackageId, setEditingPackageId] = useState<string | "new" | null>(null);

  // Inline activate/deactivate — flips `archived` without opening the
  // edit drawer. Same PATCH endpoint, just with a single-field payload.
  const archiveToggle = useMutation({
    mutationFn: (input: { id: string; archived: boolean }) =>
      updateRenovationPackage(input.id, { archived: input.archived }),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["renovation", "packages"] });
      toast.success(input.archived ? "Package deactivated" : "Package activated");
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to update package"),
  });

  const editingPackage =
    editingPackageId && editingPackageId !== "new"
      ? (packagesQ.data?.data ?? []).find((p) => p.id === editingPackageId) ?? null
      : null;

  const sortedPackages = useMemo(
    () =>
      [...(packagesQ.data?.data ?? [])].sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.label.localeCompare(b.label);
      }),
    [packagesQ.data],
  );

  const counts = useMemo(() => {
    const list = packagesQ.data?.data ?? [];
    return {
      total: list.length,
      active: list.filter((p) => !p.archived).length,
      archived: list.filter((p) => p.archived).length,
    };
  }, [packagesQ.data]);

  return (
    <>
      <Surface
        title="Renovation packages"
        description="Tick a package to manage price, description and the splits that pre-fill new claims."
        actions={
          <Button onClick={() => setEditingPackageId("new")}>
            <Plus className="h-4 w-4" /> New package
          </Button>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total: {counts.total}</Badge>
          <Badge variant="emerald">Active: {counts.active}</Badge>
          {counts.archived > 0 && <Badge variant="rose">Archived: {counts.archived}</Badge>}
        </div>

        {packagesQ.isLoading ? (
          <PackagesSkeleton />
        ) : packagesQ.isError ? (
          <p className="py-6 text-sm text-rose-600">
            Failed to load renovation packages. Please refresh.
          </p>
        ) : sortedPackages.length === 0 ? (
          <p className="py-10 text-center text-sm text-[var(--text-muted)]">
            No renovation packages yet. Use <strong>New package</strong> above to create one.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Label</th>
                  <th className="px-4 py-3 font-semibold">Key</th>
                  <th className="px-4 py-3 font-semibold">Default price (RM)</th>
                  <th className="px-4 py-3 font-semibold">Splits</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold w-32 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedPackages.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                  >
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-[var(--text-primary)]">{p.label}</div>
                      {p.description && (
                        <div className="mt-0.5 line-clamp-1 text-xs text-[var(--text-muted)]">
                          {p.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-[var(--text-secondary)]">
                      {p.key}
                    </td>
                    <td className="px-4 py-3.5 tabular-nums">
                      {p.defaultPrice.toLocaleString("en-MY", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-[var(--text-secondary)]">
                      {p.defaultSplits.length} split{p.defaultSplits.length === 1 ? "" : "s"}
                    </td>
                    <td className="px-4 py-3.5">
                      {p.archived ? (
                        <Badge variant="rose">
                          <Archive className="h-3 w-3" /> Archived
                        </Badge>
                      ) : (
                        <Badge variant="emerald">
                          <CheckCircle2 className="h-3 w-3" /> Active
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={archiveToggle.isPending}
                          onClick={() =>
                            archiveToggle.mutate({
                              id: p.id,
                              archived: !p.archived,
                            })
                          }
                          title={
                            p.archived
                              ? "Activate package — agents can pick it again"
                              : "Deactivate package — hides it from agent claim form"
                          }
                        >
                          {p.archived ? "Activate" : "Deactivate"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingPackageId(p.id)}
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      <PackageDrawer
        mode={editingPackageId === "new" ? "create" : editingPackage ? "edit" : null}
        pkg={editingPackage}
        onClose={() => setEditingPackageId(null)}
      />
    </>
  );
}

function PackagesSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded border border-[var(--card-border)] bg-[var(--card-bg)]"
        />
      ))}
    </div>
  );
}

// ─── Default Splits tab ──────────────────────────────────────────────────────
//
// Conceptually the same data set as Packages but presented split-first: every
// package shows its current splits inline so admins can scan all of the
// 100%-rule check at a glance. Editing still goes through the package drawer.

function DefaultSplitsTab() {
  const packagesQ = useQuery({
    queryKey: ["renovation", "packages", "all"],
    queryFn: () => listRenovationPackages(),
  });

  const [editingPackageId, setEditingPackageId] = useState<string | null>(null);

  const editingPackage = editingPackageId
    ? (packagesQ.data?.data ?? []).find((p) => p.id === editingPackageId) ?? null
    : null;

  const visiblePackages = useMemo(
    () => (packagesQ.data?.data ?? []).filter((p) => !p.archived),
    [packagesQ.data],
  );

  return (
    <>
      <Surface
        title="Default splits per package"
        description="Pre-fill template for new claims. Splits must total exactly 100% (or fixed amounts equal to the default price)."
      >
        {packagesQ.isLoading ? (
          <PackagesSkeleton />
        ) : packagesQ.isError ? (
          <p className="py-6 text-sm text-rose-600">
            Failed to load packages. Please refresh.
          </p>
        ) : visiblePackages.length === 0 ? (
          <p className="py-10 text-center text-sm text-[var(--text-muted)]">
            No active packages. Create one in the Packages tab first.
          </p>
        ) : (
          <div className="space-y-4">
            {visiblePackages.map((p) => (
              <SplitsPackageRow
                key={p.id}
                pkg={p}
                onEdit={() => setEditingPackageId(p.id)}
              />
            ))}
          </div>
        )}
      </Surface>

      <PackageDrawer
        mode={editingPackage ? "edit" : null}
        pkg={editingPackage}
        onClose={() => setEditingPackageId(null)}
        initialFocus="splits"
      />
    </>
  );
}

function SplitsPackageRow({
  pkg,
  onEdit,
}: {
  pkg: RenovationPackage;
  onEdit: () => void;
}) {
  const totals = computeSplitTotals(pkg.defaultSplits, pkg.defaultPrice);
  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{pkg.label}</h3>
          <p className="text-xs text-[var(--text-muted)]">
            <span className="font-mono">{pkg.key}</span> · Default price{" "}
            <span className="tabular-nums">
              RM{" "}
              {pkg.defaultPrice.toLocaleString("en-MY", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SplitTotalBadge totals={totals} />
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
        </div>
      </div>

      {pkg.defaultSplits.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          No splits configured yet. Click Edit to add them.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              <tr>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Value</th>
                <th className="px-3 py-2 font-semibold">House Keep</th>
                <th className="px-3 py-2 font-semibold w-16">Order</th>
              </tr>
            </thead>
            <tbody>
              {[...pkg.defaultSplits]
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((s) => (
                  <tr key={s.id} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="px-3 py-2">{s.roleLabel}</td>
                    <td className="px-3 py-2 text-xs uppercase text-[var(--text-secondary)]">
                      {s.splitType}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {s.splitType === "percent"
                        ? `${s.splitValue.toFixed(2)}%`
                        : `RM ${s.splitValue.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </td>
                    <td className="px-3 py-2">
                      {s.isHouseKeep ? (
                        <Badge variant="gold">House Keep</Badge>
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-xs text-[var(--text-secondary)]">
                      {s.sortOrder}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── 100% rule helpers ───────────────────────────────────────────────────────
//
// The renovation business rule: percent splits must total exactly 100% AND
// fixed splits combined with percent equivalents must total the package
// `defaultPrice`. We compute both views so the UI can surface whichever
// failure happened.

interface SplitTotals {
  /** Sum of percent values in the splits array. */
  percentTotal: number;
  /** Sum of fixed RM values in the splits array. */
  fixedTotal: number;
  /** RM equivalent of all splits (percent → RM via defaultPrice + fixed). */
  rmEquivalentTotal: number;
  /** True if the splits exactly equal the defaultPrice (within rounding). */
  ok: boolean;
  /** True when there are zero split rows — neither valid nor an error. */
  empty: boolean;
}

function computeSplitTotals(
  splits: { splitType: SplitType; splitValue: number }[],
  defaultPrice: number,
): SplitTotals {
  if (splits.length === 0) {
    return { percentTotal: 0, fixedTotal: 0, rmEquivalentTotal: 0, ok: false, empty: true };
  }
  let percentTotal = 0;
  let fixedTotal = 0;
  for (const s of splits) {
    if (s.splitType === "percent") percentTotal += s.splitValue;
    else fixedTotal += s.splitValue;
  }
  const rmEquivalentTotal = (percentTotal / 100) * defaultPrice + fixedTotal;
  // Allow 1-cent rounding tolerance — operators frequently enter 33.33% rows.
  const ok = Math.abs(rmEquivalentTotal - defaultPrice) < 0.01;
  return { percentTotal, fixedTotal, rmEquivalentTotal, ok, empty: false };
}

function SplitTotalBadge({ totals }: { totals: SplitTotals }) {
  if (totals.empty) {
    return <Badge variant="outline">No splits</Badge>;
  }
  if (totals.ok) {
    return (
      <Badge variant="emerald">
        <CheckCircle2 className="h-3 w-3" /> 100% covered
      </Badge>
    );
  }
  return (
    <Badge variant="rose">
      Splits = RM{" "}
      {totals.rmEquivalentTotal.toLocaleString("en-MY", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </Badge>
  );
}

// ─── Package drawer (shared for create + edit + splits) ──────────────────────

interface PackageDraft {
  key: string;
  label: string;
  description: string;
  defaultPrice: string; // bound to <input>; converted on submit
  archived: boolean;
  sortOrder: number;
  splits: SplitDraft[];
}

interface SplitDraft {
  // Stable client-side id so React keeps inputs focused while editing.
  uid: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: string;
  isHouseKeep: boolean;
  sortOrder: number;
}

function makeSplitDraft(s?: RenovationPackageSplit): SplitDraft {
  return {
    uid:
      s?.id ??
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tmp-${Math.random().toString(36).slice(2)}`),
    roleLabel: s?.roleLabel ?? "",
    splitType: s?.splitType ?? "percent",
    splitValue: s == null ? "" : String(s.splitValue),
    isHouseKeep: s?.isHouseKeep ?? false,
    sortOrder: s?.sortOrder ?? 0,
  };
}

function makeDraftFromPackage(pkg: RenovationPackage | null): PackageDraft {
  if (!pkg) {
    return {
      key: "",
      label: "",
      description: "",
      defaultPrice: "",
      archived: false,
      sortOrder: 0,
      splits: [],
    };
  }
  return {
    key: pkg.key,
    label: pkg.label,
    description: pkg.description ?? "",
    defaultPrice: String(pkg.defaultPrice),
    archived: pkg.archived,
    sortOrder: pkg.sortOrder,
    splits: [...pkg.defaultSplits]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(makeSplitDraft),
  };
}

function PackageDrawer({
  mode,
  pkg,
  onClose,
  initialFocus = "package",
}: {
  mode: "create" | "edit" | null;
  pkg: RenovationPackage | null;
  onClose: () => void;
  initialFocus?: "package" | "splits";
}) {
  const queryClient = useQueryClient();
  const open = mode != null;

  const [draft, setDraft] = useState<PackageDraft>(() => makeDraftFromPackage(pkg));
  // Re-seed the form whenever the drawer opens for a different package — a
  // bare `useState(initial)` only runs once, so without this effect the form
  // would still show stale values from the previously edited package.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (open) setDraft(makeDraftFromPackage(pkg));
  }, [open, pkg]);

  const numericPrice = Number(draft.defaultPrice);
  const totals = computeSplitTotals(
    draft.splits
      .filter((s) => s.splitValue !== "" && !Number.isNaN(Number(s.splitValue)))
      .map((s) => ({
        splitType: s.splitType,
        splitValue: Number(s.splitValue),
      })),
    Number.isFinite(numericPrice) ? numericPrice : 0,
  );

  const createMutation = useMutation({
    mutationFn: (payload: CreatePackagePayload) => createRenovationPackage(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renovation", "packages"] });
      toast.success("Package created");
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || "Failed to create package"),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; body: UpdatePackagePayload }) =>
      updateRenovationPackage(payload.id, payload.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renovation", "packages"] });
      toast.success("Package updated");
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || "Failed to update package"),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  function buildSplitsPayload(): PackageSplitInput[] {
    return draft.splits.map((s, idx) => ({
      roleLabel: s.roleLabel.trim(),
      splitType: s.splitType,
      splitValue: Number(s.splitValue) || 0,
      isHouseKeep: s.isHouseKeep,
      // Re-index sortOrder on save so the on-screen order is canonical.
      sortOrder: idx,
    }));
  }

  function validate(): string | null {
    if (mode === "create") {
      if (!draft.key.trim()) return "Key is required";
      if (!/^[a-z0-9_-]+$/i.test(draft.key.trim())) {
        return "Key must be alphanumeric, dash or underscore";
      }
    }
    if (!draft.label.trim()) return "Label is required";
    if (draft.defaultPrice === "" || !Number.isFinite(numericPrice) || numericPrice < 0) {
      return "Default price must be a positive number";
    }
    for (const s of draft.splits) {
      if (!s.roleLabel.trim()) return "Each split needs a role label";
      const v = Number(s.splitValue);
      if (s.splitValue === "" || !Number.isFinite(v) || v < 0) {
        return "Each split needs a non-negative value";
      }
    }
    if (draft.splits.length > 0 && !totals.ok) {
      return `Splits must total RM ${numericPrice.toFixed(2)} (currently RM ${totals.rmEquivalentTotal.toFixed(2)})`;
    }
    return null;
  }

  function handleSubmit() {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    const splitsPayload = buildSplitsPayload();
    if (mode === "create") {
      const payload: CreatePackagePayload = {
        key: draft.key.trim(),
        label: draft.label.trim(),
        description: draft.description.trim() ? draft.description.trim() : null,
        defaultPrice: numericPrice,
        archived: draft.archived,
        sortOrder: draft.sortOrder,
        defaultSplits: splitsPayload,
      };
      createMutation.mutate(payload);
    } else if (mode === "edit" && pkg) {
      const body: UpdatePackagePayload = {
        label: draft.label.trim(),
        description: draft.description.trim() ? draft.description.trim() : null,
        defaultPrice: numericPrice,
        archived: draft.archived,
        sortOrder: draft.sortOrder,
        defaultSplits: splitsPayload,
      };
      updateMutation.mutate({ id: pkg.id, body });
    }
  }

  function addSplit() {
    setDraft((d) => ({
      ...d,
      splits: [
        ...d.splits,
        {
          ...makeSplitDraft(),
          sortOrder: d.splits.length,
        },
      ],
    }));
  }

  function updateSplit(uid: string, patch: Partial<SplitDraft>) {
    setDraft((d) => ({
      ...d,
      splits: d.splits.map((s) => (s.uid === uid ? { ...s, ...patch } : s)),
    }));
  }

  function removeSplit(uid: string) {
    setDraft((d) => ({ ...d, splits: d.splits.filter((s) => s.uid !== uid) }));
  }

  const blockedBy100Rule = draft.splits.length > 0 && !totals.ok;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o && !isPending) onClose();
      }}
    >
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>
            {mode === "create" ? "New renovation package" : `Edit · ${pkg?.label ?? ""}`}
          </SheetTitle>
          <SheetDescription>
            Packages drive the price and default splits applied when an agent submits a renovation
            claim.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          <section
            className="space-y-4"
            data-section="package"
            aria-current={initialFocus === "package" ? "true" : undefined}
          >
            <h3 className="text-sm font-semibold text-foreground">Package</h3>
            <Field label="Key">
              <TextInput
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                disabled={mode === "edit"}
                placeholder="basic, premium, custom-2024…"
              />
              {mode === "edit" && (
                <span className="text-xs text-[var(--text-muted)]">
                  Key is immutable. Create a new package if you need to rename.
                </span>
              )}
            </Field>
            <Field label="Label">
              <TextInput
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Basic Reno Package"
              />
            </Field>
            <Field label="Description">
              <TextAreaInput
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What's included in this package…"
                rows={3}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Default price (RM)">
                <TextInput
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={draft.defaultPrice}
                  onChange={(e) => setDraft({ ...draft, defaultPrice: e.target.value })}
                  placeholder="15000.00"
                />
              </Field>
              <Field label="Sort order">
                <TextInput
                  type="number"
                  min="0"
                  max="1000"
                  value={String(draft.sortOrder)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      sortOrder: Number.isFinite(Number(e.target.value))
                        ? Number(e.target.value)
                        : 0,
                    })
                  }
                />
              </Field>
            </div>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={draft.archived}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, archived: checked === true })
                }
              />
              <span className="text-sm text-[var(--text-primary)]">
                Archived (hidden from the claim form)
              </span>
            </label>
          </section>

          <section
            className="space-y-3"
            data-section="splits"
            aria-current={initialFocus === "splits" ? "true" : undefined}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Default splits</h3>
              <SplitTotalBadge totals={totals} />
            </div>

            {draft.splits.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--card-border)] bg-[var(--page-bg)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                No splits yet. Add at least one row so claims can pre-fill.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.splits.map((s) => (
                  <div
                    key={s.uid}
                    className="grid grid-cols-12 gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-3"
                  >
                    <div className="col-span-12 sm:col-span-4">
                      <span className="text-[11px] font-medium text-[var(--text-muted)]">
                        Role
                      </span>
                      <TextInput
                        value={s.roleLabel}
                        onChange={(e) => updateSplit(s.uid, { roleLabel: e.target.value })}
                        placeholder="House, Lead Agent…"
                      />
                    </div>
                    <div className="col-span-6 sm:col-span-3">
                      <span className="text-[11px] font-medium text-[var(--text-muted)]">
                        Type
                      </span>
                      <SelectInput
                        value={s.splitType}
                        onChange={(e) =>
                          updateSplit(s.uid, { splitType: e.target.value as SplitType })
                        }
                      >
                        <option value="percent">Percent</option>
                        <option value="fixed">Fixed (RM)</option>
                      </SelectInput>
                    </div>
                    <div className="col-span-6 sm:col-span-3">
                      <span className="text-[11px] font-medium text-[var(--text-muted)]">
                        Value
                      </span>
                      <TextInput
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        value={s.splitValue}
                        onChange={(e) => updateSplit(s.uid, { splitValue: e.target.value })}
                        placeholder={s.splitType === "percent" ? "33.33" : "5000"}
                      />
                    </div>
                    <div className="col-span-12 sm:col-span-2 flex items-end justify-between gap-2">
                      <label className="flex items-center gap-1.5">
                        <Checkbox
                          checked={s.isHouseKeep}
                          onCheckedChange={(checked) =>
                            updateSplit(s.uid, { isHouseKeep: checked === true })
                          }
                        />
                        <span className="text-xs text-[var(--text-primary)]">House</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeSplit(s.uid)}
                        className="text-[var(--text-muted)] transition hover:text-rose-600"
                        aria-label="Remove split"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Button variant="outline" size="sm" onClick={addSplit}>
              <Plus className="h-3 w-3" /> Add split
            </Button>

            <p className="text-xs text-[var(--text-muted)]">
              Splits convert to RM at submit time using the package default price. Total must
              equal the default price exactly.
            </p>
          </section>
        </SheetBody>
        <SheetFooter>
          <Button
            disabled={isPending || blockedBy100Rule}
            onClick={handleSubmit}
            title={
              blockedBy100Rule
                ? "Splits must total the default price before saving."
                : undefined
            }
          >
            {isPending
              ? "Saving…"
              : mode === "create"
                ? "Create package"
                : "Save changes"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─── Status labels tab ───────────────────────────────────────────────────────

function StatusLabelsTab() {
  const labelsQ = useQuery({
    queryKey: ["renovation", "labels"],
    queryFn: () => listRenovationLabels(),
  });

  return (
    <div className="space-y-6">
      <LabelsSection
        title="Claim status"
        description={`The five canonical claim states. Keys are immutable; only labels and sort order can change.`}
        category="claim_status"
        immutableKeys={IMMUTABLE_CLAIM_STATUS_KEYS as readonly string[]}
        // Status labels are state-machine codes — admins should never add new
        // ones (the API has no transitions for them).
        allowAdd={false}
        labels={labelsQ.data?.data.claim_status ?? []}
        isLoading={labelsQ.isLoading}
        isError={labelsQ.isError}
        error={labelsQ.error}
      />
      <LabelsSection
        title="Renovation status"
        description="The three renovation lifecycle states (not started → on going → completed)."
        category="renovation_status"
        immutableKeys={IMMUTABLE_RENOVATION_STATUS_KEYS as readonly string[]}
        allowAdd={false}
        labels={labelsQ.data?.data.renovation_status ?? []}
        isLoading={labelsQ.isLoading}
        isError={labelsQ.isError}
        error={labelsQ.error}
      />
    </div>
  );
}

// ─── Document types tab ──────────────────────────────────────────────────────

function DocumentTypesTab() {
  const labelsQ = useQuery({
    queryKey: ["renovation", "labels"],
    queryFn: () => listRenovationLabels(),
  });

  return (
    <LabelsSection
      title="Document types"
      description="The three canonical kinds (quotation, invoice, agreement) cannot be deleted; rename their labels here. Add custom kinds as needed."
      category="document_kind"
      immutableKeys={IMMUTABLE_DOCUMENT_KIND_KEYS as readonly string[]}
      allowAdd
      labels={labelsQ.data?.data.document_kind ?? []}
      isLoading={labelsQ.isLoading}
      isError={labelsQ.isError}
      error={labelsQ.error}
    />
  );
}

// ─── Shared label table ──────────────────────────────────────────────────────

interface LabelDraft {
  label: string;
  sortOrder: number;
}

function LabelsSection({
  title,
  description,
  category,
  immutableKeys,
  allowAdd,
  labels,
  isLoading,
  isError,
  error,
}: {
  title: string;
  description: string;
  category: LabelCategory;
  immutableKeys: readonly string[];
  allowAdd: boolean;
  labels: SettingsLabel[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, LabelDraft>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [confirmDeleteLabel, setConfirmDeleteLabel] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const sorted = useMemo(
    () => [...labels].sort((a, b) => a.sortOrder - b.sortOrder),
    [labels],
  );

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; label: string; sortOrder: number }) =>
      updateRenovationLabel(input.id, { label: input.label, sortOrder: input.sortOrder }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["renovation", "labels"] });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[vars.id];
        return next;
      });
      toast.success("Label saved");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to save label"),
  });

  const createMutation = useMutation({
    mutationFn: (input: { key: string; label: string; sortOrder: number }) =>
      createRenovationLabel({
        category,
        key: input.key,
        label: input.label,
        sortOrder: input.sortOrder,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renovation", "labels"] });
      setAddOpen(false);
      setNewKey("");
      setNewLabel("");
      toast.success("Label added");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to add label"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRenovationLabel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renovation", "labels"] });
      toast.success("Label deleted");
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete label"),
  });

  function getDraft(row: SettingsLabel): LabelDraft {
    return drafts[row.id] ?? { label: row.label, sortOrder: row.sortOrder };
  }

  function setDraft(row: SettingsLabel, patch: Partial<LabelDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [row.id]: { ...getDraft(row), ...patch },
    }));
  }

  function saveRow(row: SettingsLabel) {
    const d = getDraft(row);
    if (!d.label.trim()) {
      toast.error("Label is required");
      return;
    }
    updateMutation.mutate({
      id: row.id,
      label: d.label.trim(),
      sortOrder: d.sortOrder,
    });
  }

  // Surface a soft empty-state when the labels endpoint isn't deployed yet.
  // 404 here means the route doesn't exist — render the section but show a
  // clear message so admins know W2d hasn't shipped to the env they're on.
  const isMissingEndpoint =
    isError && error instanceof ApiError && error.status === 404;

  return (
    <Surface
      title={title}
      description={description}
      actions={
        allowAdd && !isMissingEndpoint ? (
          <Button size="sm" variant="outline" onClick={() => setAddOpen((v) => !v)}>
            {addOpen ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {addOpen ? "Cancel" : "Add label"}
          </Button>
        ) : undefined
      }
    >
      {isMissingEndpoint ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          The settings-labels API is not available in this environment yet (W2d).
        </p>
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-10 animate-pulse rounded border border-[var(--card-border)] bg-[var(--card-bg)]"
            />
          ))}
        </div>
      ) : isError ? (
        <p className="py-6 text-sm text-rose-600">
          Failed to load labels. {error instanceof Error ? error.message : "Please refresh."}
        </p>
      ) : (
        <>
          {addOpen && (
            <div className="mb-4 grid gap-3 rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] p-3 sm:grid-cols-[1fr_2fr_auto]">
              <Field label="Key (immutable)">
                <TextInput
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="custom-kind"
                />
              </Field>
              <Field label="Label">
                <TextInput
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Custom kind"
                />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="default"
                  size="sm"
                  disabled={
                    !newKey.trim() || !newLabel.trim() || createMutation.isPending
                  }
                  onClick={() =>
                    createMutation.mutate({
                      key: newKey.trim(),
                      label: newLabel.trim(),
                      sortOrder: (sorted[sorted.length - 1]?.sortOrder ?? 0) + 1,
                    })
                  }
                >
                  {createMutation.isPending ? "Adding…" : "Add"}
                </Button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Key</th>
                  <th className="px-4 py-3 font-semibold">Label</th>
                  <th className="px-4 py-3 font-semibold w-24">Order</th>
                  <th className="px-4 py-3 font-semibold w-44 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-10 text-center text-sm text-[var(--text-muted)]"
                    >
                      No labels yet.
                    </td>
                  </tr>
                ) : (
                  sorted.map((row) => {
                    const d = getDraft(row);
                    const dirty =
                      d.label !== row.label || d.sortOrder !== row.sortOrder;
                    const immutable = immutableKeys.includes(row.key);
                    return (
                      <tr
                        key={row.id}
                        className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                      >
                        <td className="px-4 py-3 font-mono text-xs text-[var(--text-secondary)]">
                          <div className="flex items-center gap-2">
                            <span>{row.key}</span>
                            {immutable && (
                              <span title="Immutable — cannot be deleted">
                                <Lock className="h-3 w-3 text-[var(--text-muted)]" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <TextInput
                            value={d.label}
                            onChange={(e) => setDraft(row, { label: e.target.value })}
                            className="max-w-md"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <TextInput
                            type="number"
                            min="0"
                            max="1000"
                            value={String(d.sortOrder)}
                            onChange={(e) =>
                              setDraft(row, {
                                sortOrder: Number.isFinite(Number(e.target.value))
                                  ? Number(e.target.value)
                                  : 0,
                              })
                            }
                            className="w-20"
                          />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="default"
                              disabled={!dirty || updateMutation.isPending}
                              onClick={() => saveRow(row)}
                            >
                              {updateMutation.isPending ? "Saving…" : "Save"}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={immutable || deleteMutation.isPending}
                              onClick={() =>
                                setConfirmDeleteLabel({
                                  id: row.id,
                                  label: row.label,
                                })
                              }
                              title={
                                immutable
                                  ? "Immutable label — cannot be deleted"
                                  : "Delete label"
                              }
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <ConfirmAlert
        open={confirmDeleteLabel !== null}
        onCancel={() => setConfirmDeleteLabel(null)}
        onConfirm={() => {
          if (!confirmDeleteLabel) return;
          const id = confirmDeleteLabel.id;
          setConfirmDeleteLabel(null);
          deleteMutation.mutate(id);
        }}
        title="Delete this label?"
        body={
          confirmDeleteLabel ? (
            <>
              Label <strong>"{confirmDeleteLabel.label}"</strong> will be
              permanently removed.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Delete"
        destructive
      />
    </Surface>
  );
}
