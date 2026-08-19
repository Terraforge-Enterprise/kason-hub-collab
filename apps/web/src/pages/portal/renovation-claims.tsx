// Portal Renovation Claims — agent-facing list, drawer + new/edit form.
//
// Backend contract (own-only, server enforces ownership):
//   GET    /portal-api/renovation/packages
//   GET    /portal-api/renovation/claims
//   GET    /portal-api/renovation/claims/:id
//   POST   /portal-api/renovation/claims
//   PATCH  /portal-api/renovation/claims/:id            (rebound on Approved)
//   POST   /portal-api/renovation/claims/upload-url
//   POST   /portal-api/renovation/claims/:id/documents/mark-uploaded
//   DELETE /portal-api/renovation/claims/:id/documents/:docId
//   GET    /portal-api/renovation/claims/:id/documents/:docId/view-url
//   GET    /portal-api/sales/units                       (own only)
//   GET    /portal-api/projects                          (for project-name display)
//
// Server validates 100% split rule and document gate (≥1 quotation, ≥1 invoice)
// at submit. Client mirrors those rules to gate the Submit button.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Briefcase,
  ClipboardList,
  FileText,
  Loader2,
  Package as PackageIcon,
  Plus,
  Receipt,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GlowCard } from "@/components/ui/glow-card";
import { Input } from "@/components/ui/input";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Segmented } from "@/components/ui/segmented";
import { formatRM } from "@/components/format";
import { PortalApiError } from "@/lib/portal-api";
import { ClaimTransitionTimeline } from "@/components/claim-transition-timeline";
import { PortalAgentPicker } from "@/components/portal-agent-picker";
import {
  cancelClaim,
  createClaim,
  deleteClaimDocument,
  getClaim,
  getDocumentViewUrl,
  getUploadUrl,
  listClaims,
  listClaimTransitions,
  listMySalesUnits,
  listPackages,
  listProjects,
  markDocumentUploaded,
  updateClaim,
  uploadToSignedUrl,
  type ClaimDocument,
  type ClaimDocumentInput,
  type ClaimSplit,
  type ClaimStatus,
  type CreateClaimPayload,
  type DocumentKind,
  type PaymentType,
  type PortalProject,
  type RenovationClaim,
  type SplitType,
} from "@/api/portal-renovation-claims";

// ─── Constants ──────────────────────────────────────────────────────────────

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  submitted: "Submitted",
  pending_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  needs_amendment: "Needs Amendment",
};

const CLAIM_STATUS_VARIANT: Record<
  ClaimStatus,
  "sky" | "amber" | "emerald" | "rose"
> = {
  submitted: "sky",
  pending_approval: "amber",
  approved: "emerald",
  rejected: "rose",
  needs_amendment: "amber",
};

const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  full: "Full Payment",
  partial: "Partial Payment",
  offset_from_rental: "Offset from Rental",
};

const FILTER_TABS: Array<{ key: ClaimStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "submitted", label: "Submitted" },
  { key: "pending_approval", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "needs_amendment", label: "Needs Amendment" },
  { key: "rejected", label: "Rejected" },
];

// Allowed content types match the server `uploadUrlSchema`.
const ALLOWED_UPLOAD_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
] as const;

const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  quotation: "Quotation",
  invoice: "Invoice",
  agreement: "Agreement",
  progress_photo: "Progress photo",
  before_photo: "Before photo",
  after_photo: "After photo",
  contract: "Signed contract",
};

// ─── Form-side types ────────────────────────────────────────────────────────

type FormSplitRow = {
  /** Party FK from the agent typeahead. Null when the agent typed a name
   *  that doesn't match anyone in their reachable team — schema accepts
   *  null; the displayName snapshot still gets stored. */
  partyPartyId: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: SplitType;
  splitValue: string; // string for input editing; parsed at submit
  isHouseKeep: boolean;
  sortOrder: number;
};

type StagedDocument = {
  // Local draft entry while building a NEW claim. Once uploaded, fileKey is set.
  // For existing claims, persisted documents are kept in `existingDocs`.
  id: string; // local UUID
  kind: DocumentKind;
  filename: string;
  fileKey: string | null;
  size: number;
  status: "pending" | "uploading" | "uploaded" | "failed";
  progress: number;
  errorMsg: string | null;
};

type FormState = {
  salesUnitId: string;
  packageId: string;
  packagePrice: string;
  paymentType: PaymentType;
  monthlyOffsetAmount: string;
  notes: string;
  splits: FormSplitRow[];
  // For NEW claims: documents are staged in memory + uploaded to Supabase,
  // then sent inline in the create payload.
  stagedDocs: StagedDocument[];
};

const EMPTY_FORM: FormState = {
  salesUnitId: "",
  packageId: "",
  packagePrice: "",
  paymentType: "full",
  monthlyOffsetAmount: "",
  notes: "",
  splits: [],
  stagedDocs: [],
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PortalRenovationClaimsPage() {
  const [filterStatus, setFilterStatus] = useState<ClaimStatus | "all">("all");
  const [drawerMode, setDrawerMode] = useState<"new" | "edit" | null>(null);
  const [editClaimId, setEditClaimId] = useState<string | null>(null);
  // Deep-link prefill: /portal/renovation-claims/new?salesUnitId=<id>
  // auto-opens the new-claim drawer with that unit selected.
  const [prefillSalesUnitId, setPrefillSalesUnitId] = useState<string | null>(
    null,
  );

  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // On mount (or when path becomes /new), open the drawer pre-filled and
  // strip the URL back to /portal/renovation-claims so navigating back
  // doesn't keep re-firing this effect.
  useEffect(() => {
    if (!location.pathname.endsWith("/new")) return;
    const unitId = searchParams.get("salesUnitId");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: opens the claim drawer from the /new route + salesUnitId query param
    setPrefillSalesUnitId(unitId);
    setEditClaimId(null);
    setDrawerMode("new");
    navigate("/portal/renovation-claims", { replace: true });
  }, [location.pathname, searchParams, navigate]);

  const claimsQuery = useQuery({
    queryKey: ["portal-renovation-claims"],
    queryFn: listClaims,
  });

  const projectsQuery = useQuery({
    queryKey: ["portal-projects"],
    queryFn: listProjects,
  });

  const salesUnitsQuery = useQuery({
    queryKey: ["portal-my-sales-units"],
    queryFn: listMySalesUnits,
  });

  // Defensive: HMR + cache + back-compat with older response shapes can
  // briefly hand us a non-array. Coerce to [] so the downstream useMemos
  // (which iterate) never crash. (`projects is not iterable` was the
  // symptom before this guard.)
  const claims = useMemo(
    () => (Array.isArray(claimsQuery.data) ? claimsQuery.data : []),
    [claimsQuery.data],
  );
  const projects = useMemo(
    () => (Array.isArray(projectsQuery.data) ? projectsQuery.data : []),
    [projectsQuery.data],
  );
  const salesUnits = useMemo(
    () => (Array.isArray(salesUnitsQuery.data) ? salesUnitsQuery.data : []),
    [salesUnitsQuery.data],
  );
  const projectById = useMemo(() => {
    const map = new Map<string, PortalProject>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);
  const salesUnitById = useMemo(() => {
    const map = new Map<string, (typeof salesUnits)[number]>();
    for (const u of salesUnits) map.set(u.id, u);
    return map;
  }, [salesUnits]);

  const visibleClaims = useMemo(() => {
    return filterStatus === "all"
      ? claims
      : claims.filter((c) => c.status === filterStatus);
  }, [claims, filterStatus]);

  const stats = useMemo(() => computeStats(claims), [claims]);

  const openNew = () => {
    setEditClaimId(null);
    setDrawerMode("new");
  };
  const openEdit = (id: string) => {
    setEditClaimId(id);
    setDrawerMode("edit");
  };
  const closeDrawer = () => {
    setDrawerMode(null);
    setEditClaimId(null);
    setPrefillSalesUnitId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Briefcase className="h-8 w-8 text-primary" />
            Renovation Claims
          </h1>
          <p className="text-muted-foreground mt-1">
            Submit and track renovation cost claims for your sales units.
          </p>
        </div>
        <Button variant="gold" onClick={openNew}>
          <Plus className="h-4 w-4" /> New Claim
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard
          glowColor="green"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <StatBlock
            label="Total submissions"
            value={String(stats.total)}
            tone="emerald"
            icon={<ClipboardList className="h-6 w-6 text-emerald-600" />}
            footer="all claims you submitted"
          />
        </GlowCard>
        <GlowCard
          glowColor="blue"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <StatBlock
            label="In review"
            value={String(stats.inReview)}
            tone="sky"
            icon={<Receipt className="h-6 w-6 text-sky-600" />}
            footer="submitted + pending"
          />
        </GlowCard>
        <GlowCard
          glowColor="gold"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <StatBlock
            label="Approved value"
            value={formatRM(stats.approvedValue)}
            tone="amber"
            icon={<Wallet className="h-6 w-6 text-amber-600" />}
            footer={`${stats.approved} approved claim${stats.approved === 1 ? "" : "s"}`}
          />
        </GlowCard>
        <GlowCard
          glowColor="orange"
          className="p-6 bg-background/40 backdrop-blur-xl border border-border/50"
        >
          <StatBlock
            label="Needs your action"
            value={String(stats.needsAction)}
            tone="rose"
            icon={<FileText className="h-6 w-6 text-rose-600" />}
            footer="rejected or amendment"
          />
        </GlowCard>
      </div>

      {/* Filters */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5">
            {FILTER_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilterStatus(t.key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  filterStatus === t.key
                    ? "bg-[var(--gold)]/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Claims table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-0 overflow-hidden">
          {claimsQuery.isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">
              Loading claims…
            </div>
          ) : claimsQuery.isError ? (
            <div className="p-6 text-sm text-rose-600">
              Failed to load claims.
            </div>
          ) : visibleClaims.length === 0 ? (
            <div className="p-12 text-center">
              <Briefcase className="h-10 w-10 text-muted-foreground/50 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {filterStatus === "all"
                  ? "You haven't submitted any renovation claims yet."
                  : "No claims match this filter."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[var(--page-bg)] border-b border-border/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Project · Unit
                    </th>
                    <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-muted-foreground">
                      Price
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Payment
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Submitted
                    </th>
                    <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {visibleClaims.map((c) => {
                    const su = salesUnitById.get(c.salesUnitId);
                    const proj = su ? projectById.get(su.projectId) : undefined;
                    return (
                      <ClaimRow
                        key={c.id}
                        claim={c}
                        projectName={proj?.name}
                        unitNumber={su?.unitNumber}
                        onClick={() => openEdit(c.id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Drawer */}
      {drawerMode !== null && (
        <ClaimDrawer
          mode={drawerMode}
          claimId={editClaimId}
          prefillSalesUnitId={prefillSalesUnitId}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

// ─── Stat block ────────────────────────────────────────────────────────────

function StatBlock({
  label,
  value,
  tone,
  icon,
  footer,
}: {
  label: string;
  value: string;
  tone: "emerald" | "sky" | "amber" | "rose";
  icon: React.ReactNode;
  footer: string;
}) {
  const bg = {
    emerald: "bg-emerald-500/10",
    sky: "bg-sky-500/10",
    amber: "bg-amber-500/10",
    rose: "bg-rose-500/10",
  }[tone];
  return (
    <div className="flex items-start justify-between">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="text-3xl font-bold text-foreground">{value}</p>
        <div className="text-xs text-muted-foreground">{footer}</div>
      </div>
      <div className={`p-3 rounded-xl ${bg}`}>{icon}</div>
    </div>
  );
}

// ─── List row ──────────────────────────────────────────────────────────────

function ClaimRow({
  claim,
  onClick,
  projectName,
  unitNumber,
}: {
  claim: RenovationClaim;
  projectName?: string;
  unitNumber?: string;
  onClick: () => void;
}) {
  return (
    <tr
      className="border-b border-border/50 last:border-0 transition hover:bg-[var(--page-bg)] cursor-pointer"
      onClick={onClick}
    >
      <td className="px-4 py-3.5 text-sm">
        <div className="font-medium text-foreground">
          {projectName ?? "Renovation Claim"}
        </div>
        <div className="text-xs text-muted-foreground font-mono">
          {unitNumber ?? `unit ${claim.salesUnitId.slice(0, 8)}…`}
        </div>
      </td>
      <td className="px-4 py-3.5 text-sm text-right font-medium">
        {formatRM(claim.packagePrice)}
      </td>
      <td className="px-4 py-3.5 text-sm">
        {PAYMENT_TYPE_LABELS[claim.paymentType]}
      </td>
      <td className="px-4 py-3.5 text-sm">
        <div>{claim.submittedAt.slice(0, 10)}</div>
      </td>
      <td className="px-4 py-3.5 text-sm">
        <Badge variant={CLAIM_STATUS_VARIANT[claim.status]}>
          {CLAIM_STATUS_LABELS[claim.status]}
        </Badge>
      </td>
      <td className="px-4 py-3.5 text-right">
        <Button variant="ghost" size="sm">
          {claim.status === "approved" ||
          claim.status === "rejected" ||
          claim.status === "pending_approval"
            ? "View"
            : "Edit"}
        </Button>
      </td>
    </tr>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

function ClaimDrawer({
  mode,
  claimId,
  prefillSalesUnitId,
  onClose,
}: {
  mode: "new" | "edit";
  claimId: string | null;
  // Deep-link prefill from /portal/renovation-claims/new?salesUnitId=<id>.
  // Applied once on mount in "new" mode; the form's local state takes over
  // after that.
  prefillSalesUnitId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const packagesQuery = useQuery({
    queryKey: ["portal-renovation-packages"],
    queryFn: listPackages,
  });
  const salesUnitsQuery = useQuery({
    queryKey: ["portal-my-sales-units"],
    queryFn: listMySalesUnits,
  });
  const projectsQuery = useQuery({
    queryKey: ["portal-projects"],
    queryFn: listProjects,
  });
  const claimQuery = useQuery({
    queryKey: ["portal-renovation-claim", claimId],
    queryFn: () => (claimId ? getClaim(claimId) : Promise.resolve(null)),
    enabled: mode === "edit" && !!claimId,
  });

  // Audit timeline (edit mode only). Same ownership rule as the detail
  // endpoint — agents see every prior reviewer note + status change.
  const transitionsQuery = useQuery({
    queryKey: ["portal-renovation-claim-transitions", claimId],
    queryFn: () => (claimId ? listClaimTransitions(claimId) : Promise.resolve([])),
    enabled: mode === "edit" && !!claimId,
  });

  const packages = Array.isArray(packagesQuery.data) ? packagesQuery.data : [];
  const salesUnits = Array.isArray(salesUnitsQuery.data)
    ? salesUnitsQuery.data
    : [];
  const projects = useMemo(
    () => (Array.isArray(projectsQuery.data) ? projectsQuery.data : []),
    [projectsQuery.data],
  );
  const projectById = useMemo(() => {
    const map = new Map<string, PortalProject>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  // useState lazy initializer — picks up the deep-link prefill exactly once
  // (subsequent prop updates don't reset the form, matching the existing
  // hydratedRef pattern below for edit mode).
  const [form, setForm] = useState<FormState>(() =>
    mode === "new" && prefillSalesUnitId
      ? { ...EMPTY_FORM, salesUnitId: prefillSalesUnitId }
      : EMPTY_FORM,
  );
  // Existing persisted documents (edit mode) — separate from staged uploads.
  const [existingDocs, setExistingDocs] = useState<ClaimDocument[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hydrate the form once when in edit mode. Guarded by a ref so subsequent
  // refetches (e.g. cache invalidation after document upload) do NOT clobber
  // the user's in-progress edits.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (mode !== "edit" || !claimQuery.data || hydratedRef.current) return;
    hydratedRef.current = true;
    const c = claimQuery.data;
    setForm({
      salesUnitId: c.salesUnitId,
      packageId: c.packageId,
      packagePrice: String(c.packagePrice ?? ""),
      paymentType: c.paymentType,
      monthlyOffsetAmount:
        c.monthlyOffsetAmount != null ? String(c.monthlyOffsetAmount) : "",
      notes: c.notes ?? "",
      splits: (c.splits ?? []).map(splitRowFromApi),
      stagedDocs: [],
    });
    setExistingDocs(c.documents ?? []);
  }, [mode, claimQuery.data]);

  const editingClaim = claimQuery.data;
  const isApproved = editingClaim?.status === "approved";

  // Pre-fill splits + price from selected package on first selection (NEW claim).
  // Edit mode keeps server-side splits as-is.
  const handlePackageSelect = (pkgId: string) => {
    const pkg = packages.find((p) => p.id === pkgId);
    setForm((prev) => {
      // In edit mode we only swap the package id; keep splits + price untouched
      // unless the user explicitly resets them.
      if (mode === "edit") {
        return { ...prev, packageId: pkgId };
      }
      if (!pkg) return { ...prev, packageId: pkgId };
      return {
        ...prev,
        packageId: pkgId,
        packagePrice:
          prev.packagePrice === "" ? String(pkg.defaultPrice) : prev.packagePrice,
        splits:
          prev.splits.length === 0
            ? pkg.defaultSplits
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((s, idx) => ({
                  // Package defaults don't carry a Party FK — agent picks
                  // one via the typeahead after the row is materialized.
                  partyPartyId: null,
                  partyDisplayName: s.roleLabel, // sensible default — agent edits
                  roleLabel: s.roleLabel,
                  splitType: s.splitType,
                  splitValue: String(s.splitValue),
                  isHouseKeep: s.isHouseKeep,
                  sortOrder: idx,
                }))
            : prev.splits,
      };
    });
  };

  const updateSplit = (idx: number, patch: Partial<FormSplitRow>) => {
    setForm((prev) => {
      const next = prev.splits.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, splits: next };
    });
  };
  const addSplit = () => {
    setForm((prev) => ({
      ...prev,
      splits: [
        ...prev.splits,
        {
          partyPartyId: null,
          partyDisplayName: "",
          roleLabel: "",
          splitType: "percent",
          splitValue: "",
          isHouseKeep: false,
          sortOrder: prev.splits.length,
        },
      ],
    }));
  };
  const removeSplit = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      splits: prev.splits.filter((_, i) => i !== idx),
    }));
  };

  // ─── Live validation ─────────────────────────────────────────────────────

  const validation = useMemo(
    () => validateForm(form, existingDocs, mode),
    [form, existingDocs, mode],
  );

  // ─── Mutations ───────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: (payload: CreateClaimPayload) => createClaim(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-renovation-claims"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; payload: Parameters<typeof updateClaim>[1] }) =>
      updateClaim(input.id, input.payload),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["portal-renovation-claims"] });
      queryClient.invalidateQueries({
        queryKey: ["portal-renovation-claim", vars.id],
      });
    },
  });

  // Withdraw — only valid while status="submitted"; server returns 409
  // once a reviewer touches the claim.
  const cancelMutation = useMutation({
    mutationFn: (claimIdToCancel: string) => cancelClaim(claimIdToCancel),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-renovation-claims"] });
      toast.success("Claim withdrawn");
      onClose();
    },
    onError: (err) => {
      const msg =
        err instanceof PortalApiError ? err.message : "Failed to withdraw claim";
      toast.error(msg);
    },
  });

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    cancelMutation.isPending;

  // ─── Document upload (NEW-claim staging path) ────────────────────────────

  const stageAndUpload = async (file: File, kind: DocumentKind) => {
    if (
      !ALLOWED_UPLOAD_TYPES.includes(
        file.type as (typeof ALLOWED_UPLOAD_TYPES)[number],
      )
    ) {
      toast.error("Unsupported file type", {
        description: "Use PDF, JPEG, PNG, or HEIC.",
      });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast.error("File too large", { description: "Max 25 MB." });
      return;
    }
    const localId = crypto.randomUUID();
    setForm((prev) => ({
      ...prev,
      stagedDocs: [
        ...prev.stagedDocs,
        {
          id: localId,
          kind,
          filename: file.name,
          fileKey: null,
          size: file.size,
          status: "uploading",
          progress: 0,
          errorMsg: null,
        },
      ],
    }));
    try {
      const signed = await getUploadUrl({
        filename: file.name,
        contentType: file.type,
        // Omit claimId for NEW claims — server places file under a temp prefix.
        ...(mode === "edit" && claimId ? { claimId } : {}),
      });
      await uploadToSignedUrl(signed, file, (pct) =>
        setForm((prev) => ({
          ...prev,
          stagedDocs: prev.stagedDocs.map((d) =>
            d.id === localId ? { ...d, progress: pct } : d,
          ),
        })),
      );

      // Edit mode: register the file on the existing claim immediately.
      if (mode === "edit" && claimId) {
        const created = await markDocumentUploaded(claimId, {
          fileKey: signed.fileKey,
          kind,
          filename: file.name,
        });
        setExistingDocs((prev) => [...prev, created]);
        // Drop the staging row — it's now in `existingDocs`.
        setForm((prev) => ({
          ...prev,
          stagedDocs: prev.stagedDocs.filter((d) => d.id !== localId),
        }));
        queryClient.invalidateQueries({
          queryKey: ["portal-renovation-claim", claimId],
        });
        return;
      }

      // NEW mode: keep the staged entry; we ship fileKey inline at submit.
      setForm((prev) => ({
        ...prev,
        stagedDocs: prev.stagedDocs.map((d) =>
          d.id === localId
            ? {
                ...d,
                fileKey: signed.fileKey,
                status: "uploaded",
                progress: 100,
              }
            : d,
        ),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setForm((prev) => ({
        ...prev,
        stagedDocs: prev.stagedDocs.map((d) =>
          d.id === localId ? { ...d, status: "failed", errorMsg: msg } : d,
        ),
      }));
      toast.error("Upload failed", { description: msg });
    }
  };

  const removeStaged = (id: string) => {
    setForm((prev) => ({
      ...prev,
      stagedDocs: prev.stagedDocs.filter((d) => d.id !== id),
    }));
  };

  const removeExistingDoc = async (docId: string) => {
    if (!claimId) return;
    try {
      await deleteClaimDocument(claimId, docId);
      setExistingDocs((prev) => prev.filter((d) => d.id !== docId));
      queryClient.invalidateQueries({
        queryKey: ["portal-renovation-claim", claimId],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error("Could not remove document", { description: msg });
    }
  };

  const viewDoc = async (docId: string) => {
    if (!claimId) return;
    try {
      const { viewUrl } = await getDocumentViewUrl(claimId, docId);
      window.open(viewUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not open document";
      toast.error("View failed", { description: msg });
    }
  };

  // ─── Submit ──────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    setSubmitError(null);
    if (!validation.canSubmit) {
      setSubmitError(validation.firstIssue ?? "Please complete the form.");
      return;
    }
    const splits = form.splits.map((s, idx) => ({
      // Ship the Party FK when set; null means free-text only and the
      // server stores partyDisplayName as a snapshot. Schema accepts both.
      partyPartyId: s.partyPartyId ?? null,
      partyDisplayName: s.partyDisplayName.trim(),
      roleLabel: s.roleLabel.trim(),
      splitType: s.splitType,
      splitValue: Number(s.splitValue),
      isHouseKeep: s.isHouseKeep,
      sortOrder: idx,
    }));
    const monthlyOffset =
      form.paymentType === "offset_from_rental" && form.monthlyOffsetAmount !== ""
        ? Number(form.monthlyOffsetAmount)
        : null;

    try {
      if (mode === "edit" && claimId) {
        await updateMutation.mutateAsync({
          id: claimId,
          payload: {
            packageId: form.packageId,
            packagePrice: Number(form.packagePrice),
            paymentType: form.paymentType,
            monthlyOffsetAmount: monthlyOffset,
            notes: form.notes.trim() || null,
            splits,
          },
        });
        toast.success("Claim updated", {
          description: isApproved
            ? "Your changes were saved. The claim is back in the review queue."
            : "Your changes were saved.",
        });
        onClose();
        return;
      }

      // NEW claim path
      const docs: ClaimDocumentInput[] = form.stagedDocs
        .filter((d) => d.status === "uploaded" && d.fileKey)
        .map((d) => ({
          fileKey: d.fileKey as string,
          kind: d.kind,
          filename: d.filename,
        }));
      await createMutation.mutateAsync({
        salesUnitId: form.salesUnitId,
        packageId: form.packageId,
        packagePrice: Number(form.packagePrice),
        paymentType: form.paymentType,
        monthlyOffsetAmount: monthlyOffset,
        notes: form.notes.trim() || null,
        splits,
        documents: docs,
      });
      toast.success("Claim submitted", {
        description: "Your renovation claim is now in the review queue.",
      });
      onClose();
    } catch (err) {
      const msg =
        err instanceof PortalApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Submission failed";
      setSubmitError(msg);
      toast.error("Submission failed", { description: msg });
    }
  };

  const drawerSalesUnit = salesUnits.find((u) => u.id === form.salesUnitId);
  const drawerProject = drawerSalesUnit
    ? projectById.get(drawerSalesUnit.projectId)
    : undefined;
  const selectedPackage = packages.find((p) => p.id === form.packageId);

  const isLoadingForm =
    packagesQuery.isLoading ||
    salesUnitsQuery.isLoading ||
    (mode === "edit" && claimQuery.isLoading);

  return (
    <FormDrawer
      open
      onClose={onClose}
      size="lg"
      title={mode === "new" ? "New Renovation Claim" : "Renovation Claim"}
      description={
        mode === "new"
          ? "Submit a renovation cost claim for one of your sales units."
          : editingClaim
            ? `${CLAIM_STATUS_LABELS[editingClaim.status]} · submitted ${editingClaim.submittedAt.slice(0, 10)}`
            : "Loading…"
      }
      onSubmit={handleSubmit}
      submit={{
        label: mode === "edit" ? "Save changes" : "Submit claim",
        pendingLabel: mode === "edit" ? "Saving…" : "Submitting…",
        variant: "gold",
        pending: isPending,
        disabled: !validation.canSubmit,
      }}
      secondaryActions={[
        mode === "edit" && claimId && editingClaim?.status === "submitted"
          ? {
              label: "Withdraw",
              pendingLabel: "Withdrawing…",
              variant: "ghost" as const,
              pending: cancelMutation.isPending,
              onClick: () => cancelMutation.mutate(claimId),
              confirm: {
                title: "Withdraw this claim?",
                body: "It will be terminated; you'll need to submit a new one to retry.",
                confirmLabel: "Withdraw",
                destructive: true,
              },
            }
          : null,
      ]}
    >
      <div className="space-y-4">
        {isLoadingForm ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {mode === "edit" && isApproved && (
              <Callout
                variant="warning"
                title="Editing will re-enter the review queue"
              >
                This claim is currently <strong>Approved</strong>. Saving
                changes will flip it to <em>Needs Amendment</em> and notify the
                reviewer.
              </Callout>
            )}
            {mode === "edit" && editingClaim?.reviewerNote && (
              <Callout variant="info" title="Reviewer note">
                {editingClaim.reviewerNote}
              </Callout>
            )}

            {/* Sales Unit picker — locked in edit mode (server-side rule too) */}
            <Section title="Sales Unit" icon={<Briefcase className="h-4 w-4" />}>
              {mode === "new" ? (
                <select
                  aria-label="Sales unit"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={form.salesUnitId}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, salesUnitId: e.target.value }))
                  }
                >
                  <option value="">— Choose a sales unit —</option>
                  {salesUnits.map((u) => {
                    const proj = projectById.get(u.projectId);
                    return (
                      <option key={u.id} value={u.id}>
                        {(proj?.name ?? "Project")} · {u.unitNumber}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <div className="rounded-md border border-border/50 bg-background/40 p-3 text-sm">
                  {drawerProject?.name ?? "Project"} ·{" "}
                  <span className="font-mono">{drawerSalesUnit?.unitNumber}</span>
                </div>
              )}
            </Section>

            {/* Package picker */}
            <Section title="Package" icon={<PackageIcon className="h-4 w-4" />}>
              <select
                aria-label="Package"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={form.packageId}
                onChange={(e) => handlePackageSelect(e.target.value)}
              >
                <option value="">— Choose a package —</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · default {formatRM(p.defaultPrice)}
                  </option>
                ))}
              </select>
              {selectedPackage?.description && (
                <p className="text-xs text-muted-foreground mt-2">
                  {selectedPackage.description}
                </p>
              )}

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-muted-foreground">Package Price (RM)</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={form.packagePrice}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, packagePrice: e.target.value }))
                    }
                  />
                </label>
              </div>
            </Section>

            {/* Payment */}
            <Section title="Payment" icon={<Wallet className="h-4 w-4" />}>
              <Segmented
                value={form.paymentType}
                onChange={(v) =>
                  setForm((prev) => ({ ...prev, paymentType: v }))
                }
                options={[
                  { value: "full", label: "Full" },
                  { value: "partial", label: "Partial" },
                  { value: "offset_from_rental", label: "Offset from Rental" },
                ]}
                ariaLabel="Payment type"
              />
              {form.paymentType === "offset_from_rental" && (
                <label className="mt-3 block text-sm">
                  <span className="text-muted-foreground">
                    Monthly offset amount (RM)
                  </span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={form.monthlyOffsetAmount}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        monthlyOffsetAmount: e.target.value,
                      }))
                    }
                  />
                </label>
              )}
            </Section>

            {/* Splits */}
            <Section
              title={`Splits (${form.splits.length})`}
              icon={<Receipt className="h-4 w-4" />}
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addSplit}
                >
                  <Plus className="h-4 w-4" /> Add row
                </Button>
              }
            >
              <SplitsTable
                splits={form.splits}
                packagePrice={Number(form.packagePrice) || 0}
                onUpdate={updateSplit}
                onRemove={removeSplit}
              />
              <SplitSummary
                splits={form.splits}
                packagePrice={Number(form.packagePrice) || 0}
                validation={validation}
              />
            </Section>

            {/* Documents */}
            <Section
              title="Documents"
              icon={<FileText className="h-4 w-4" />}
            >
              <DocumentZone
                kind="quotation"
                required
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "quotation")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
              <DocumentZone
                kind="invoice"
                required
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "invoice")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
              <DocumentZone
                kind="agreement"
                required={false}
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "agreement")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
              {/* Newly added kinds — all optional. Photos help the
                  reviewer verify the work matches the quoted package;
                  `contract` is for the signed copy distinct from the
                  proposal-level "agreement". */}
              <DocumentZone
                kind="contract"
                required={false}
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "contract")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
              <DocumentZone
                kind="progress_photo"
                required={false}
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "progress_photo")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
              <DocumentZone
                kind="before_photo"
                required={false}
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "before_photo")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
              <DocumentZone
                kind="after_photo"
                required={false}
                stagedDocs={form.stagedDocs}
                existingDocs={existingDocs}
                onPick={(file) => stageAndUpload(file, "after_photo")}
                onRemoveStaged={removeStaged}
                onRemoveExisting={removeExistingDoc}
                onView={viewDoc}
                mode={mode}
              />
            </Section>

            {/* Notes */}
            <Section
              title="Notes (optional)"
              icon={<FileText className="h-4 w-4" />}
            >
              <textarea
                className="w-full min-h-[80px] rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="Special terms, context for the reviewer…"
                value={form.notes}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, notes: e.target.value }))
                }
              />
            </Section>

            {submitError && (
              <Callout variant="warning" title="Cannot submit">
                {submitError}
              </Callout>
            )}

            {/* Status history (edit mode only). Surfaces every prior
                rejection note + amendment cycle so the agent doesn't
                have to ask why their claim was bounced again. */}
            {mode === "edit" && (
              <Section
                title="Status history"
                icon={<ClipboardList className="h-4 w-4 text-primary" />}
              >
                <ClaimTransitionTimeline
                  transitions={transitionsQuery.data ?? []}
                  isLoading={transitionsQuery.isLoading}
                  isError={transitionsQuery.isError}
                />
              </Section>
            )}
          </>
        )}
      </div>
    </FormDrawer>
  );
}

// ─── Section wrapper ───────────────────────────────────────────────────────

function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="bg-background/40 border-border/50">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          {icon} {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="pt-2">{children}</CardContent>
    </Card>
  );
}

// ─── Splits table ──────────────────────────────────────────────────────────

function SplitsTable({
  splits,
  packagePrice,
  onUpdate,
  onRemove,
}: {
  splits: FormSplitRow[];
  packagePrice: number;
  onUpdate: (idx: number, patch: Partial<FormSplitRow>) => void;
  onRemove: (idx: number) => void;
}) {
  if (splits.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No splits yet. Pick a package above to pre-fill default splits, or add
        rows manually.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {splits.map((s, i) => {
        const computed = computeSplitAmount(s, packagePrice);
        return (
          <div
            key={i}
            className="grid grid-cols-12 gap-2 items-start rounded border border-border/50 bg-background/40 p-2"
          >
            <div className="col-span-12 sm:col-span-4">
              <Input
                aria-label="Role"
                placeholder="Role (e.g. Sales Commission)"
                value={s.roleLabel}
                onChange={(e) =>
                  onUpdate(i, { roleLabel: e.target.value })
                }
              />
              <div className="mt-1">
                <PortalAgentPicker
                  partyPartyId={s.partyPartyId}
                  displayName={s.partyDisplayName}
                  onChange={({ partyPartyId, displayName }) =>
                    onUpdate(i, { partyPartyId, partyDisplayName: displayName })
                  }
                  placeholder="Pick from team or type a name"
                />
              </div>
            </div>
            <div className="col-span-6 sm:col-span-3">
              <select
                aria-label="Split type"
                className="w-full rounded-md border border-border bg-background px-2 py-2 text-sm"
                value={s.splitType}
                onChange={(e) =>
                  onUpdate(i, {
                    splitType: e.target.value as SplitType,
                  })
                }
              >
                <option value="percent">Percent</option>
                <option value="fixed">Fixed (RM)</option>
              </select>
            </div>
            <div className="col-span-6 sm:col-span-3">
              <Input
                aria-label="Value"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder={s.splitType === "percent" ? "%" : "RM"}
                value={s.splitValue}
                onChange={(e) =>
                  onUpdate(i, { splitValue: e.target.value })
                }
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                = {formatRM(computed)}
              </div>
            </div>
            <div className="col-span-12 sm:col-span-2 flex sm:flex-col items-center sm:items-stretch gap-1 justify-between">
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={s.isHouseKeep}
                  onChange={(e) =>
                    onUpdate(i, { isHouseKeep: e.target.checked })
                  }
                />
                House Keep
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove split"
                onClick={() => onRemove(i)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SplitSummary({
  splits,
  packagePrice,
  validation,
}: {
  splits: FormSplitRow[];
  packagePrice: number;
  validation: FormValidation;
}) {
  const totalAmount = splits.reduce(
    (sum, s) => sum + computeSplitAmount(s, packagePrice),
    0,
  );
  const percentSum = splits
    .filter((s) => s.splitType === "percent")
    .reduce((sum, s) => sum + (Number(s.splitValue) || 0), 0);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      <Badge variant={validation.splitsOk ? "emerald" : "rose"}>
        {validation.splitsOk
          ? "Splits cover 100% of price"
          : "Splits must total 100% of price"}
      </Badge>
      <span className="text-muted-foreground">
        Σ amount {formatRM(totalAmount)} of {formatRM(packagePrice)}
      </span>
      <span className="text-muted-foreground">
        Σ percent rows {percentSum.toFixed(2)}%
      </span>
    </div>
  );
}

// ─── Document zone (per kind) ──────────────────────────────────────────────

function DocumentZone({
  kind,
  required,
  stagedDocs,
  existingDocs,
  onPick,
  onRemoveStaged,
  onRemoveExisting,
  onView,
  mode,
}: {
  kind: DocumentKind;
  required: boolean;
  stagedDocs: StagedDocument[];
  existingDocs: ClaimDocument[];
  onPick: (file: File) => void;
  onRemoveStaged: (id: string) => void;
  onRemoveExisting: (id: string) => void;
  onView: (id: string) => void;
  mode: "new" | "edit";
}) {
  const inputId = `doc-${kind}-input`;
  const stagedForKind = stagedDocs.filter((d) => d.kind === kind);
  const existingForKind = existingDocs.filter((d) => d.kind === kind);
  const total = stagedForKind.length + existingForKind.length;

  return (
    <div className="rounded-md border border-border/50 bg-background/40 p-3 mb-2">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">
          {DOCUMENT_KIND_LABELS[kind]}
          {required && <span className="text-rose-500"> *</span>}
        </div>
        <Badge variant={total > 0 ? "emerald" : required ? "rose" : "outline"}>
          {total} file{total === 1 ? "" : "s"}
        </Badge>
      </div>

      {existingForKind.map((d) => (
        <DocRow
          key={`ex-${d.id}`}
          filename={d.filename}
          status="uploaded"
          progress={100}
          onRemove={() => onRemoveExisting(d.id)}
          onView={() => onView(d.id)}
        />
      ))}
      {stagedForKind.map((d) => (
        <DocRow
          key={`st-${d.id}`}
          filename={d.filename}
          status={d.status}
          progress={d.progress}
          errorMsg={d.errorMsg}
          onRemove={() => onRemoveStaged(d.id)}
        />
      ))}

      <label
        htmlFor={inputId}
        className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground hover:bg-background/60 transition"
      >
        <Upload className="h-4 w-4" /> Upload {DOCUMENT_KIND_LABELS[kind]} (PDF /
        image)
      </label>
      <input
        id={inputId}
        type="file"
        accept={ALLOWED_UPLOAD_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = ""; // allow re-pick of same file
        }}
      />
      {mode === "edit" && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Files attach to this claim immediately. Removing an existing file will
          delete it from storage.
        </p>
      )}
    </div>
  );
}

function DocRow({
  filename,
  status,
  progress,
  errorMsg,
  onRemove,
  onView,
}: {
  filename: string;
  status: StagedDocument["status"] | "uploaded";
  progress: number;
  errorMsg?: string | null;
  onRemove: () => void;
  onView?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border/50 bg-background/40 px-2 py-1.5 text-sm mb-1">
      <div className="min-w-0 flex-1">
        <div className="truncate" title={filename}>
          {filename}
        </div>
        {status === "uploading" && (
          <Fragment>
            <progress
              className="w-full h-1.5"
              max={100}
              value={progress}
              aria-label={`Uploading ${filename}`}
            />
            <span className="text-[11px] text-muted-foreground">
              Uploading {progress}%…
            </span>
          </Fragment>
        )}
        {status === "failed" && (
          <span className="text-[11px] text-rose-600">
            {errorMsg ?? "Upload failed"}
          </span>
        )}
        {status === "uploaded" && (
          <span className="text-[11px] text-emerald-600">Uploaded</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onView && status === "uploaded" && (
          <Button variant="ghost" size="sm" onClick={onView}>
            View
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${filename}`}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function splitRowFromApi(s: ClaimSplit): FormSplitRow {
  return {
    partyPartyId: s.partyPartyId,
    partyDisplayName: s.partyDisplayName,
    roleLabel: s.roleLabel,
    splitType: s.splitType,
    splitValue: String(s.splitValue),
    isHouseKeep: s.isHouseKeep,
    sortOrder: s.sortOrder,
  };
}

function computeSplitAmount(s: FormSplitRow, packagePrice: number): number {
  const value = Number(s.splitValue) || 0;
  if (s.splitType === "fixed") return value;
  return (packagePrice * value) / 100;
}

type FormValidation = {
  canSubmit: boolean;
  splitsOk: boolean;
  documentsOk: boolean;
  firstIssue: string | null;
};

function validateForm(
  form: FormState,
  existingDocs: ClaimDocument[],
  mode: "new" | "edit",
): FormValidation {
  const issues: string[] = [];

  if (mode === "new" && !form.salesUnitId) {
    issues.push("Select a sales unit.");
  }
  if (!form.packageId) issues.push("Pick a package.");
  const price = Number(form.packagePrice);
  if (!form.packagePrice || !Number.isFinite(price) || price <= 0) {
    issues.push("Enter a valid package price.");
  }
  if (form.splits.length === 0) {
    issues.push("Add at least one split.");
  }
  for (const s of form.splits) {
    if (!s.roleLabel.trim()) issues.push("Each split needs a role.");
    if (!s.partyDisplayName.trim()) issues.push("Each split needs a party.");
    if (!s.splitValue || !Number.isFinite(Number(s.splitValue))) {
      issues.push("Each split needs a numeric value.");
      break;
    }
  }
  if (
    form.paymentType === "offset_from_rental" &&
    (!form.monthlyOffsetAmount ||
      !Number.isFinite(Number(form.monthlyOffsetAmount)))
  ) {
    issues.push("Enter a monthly offset amount.");
  }

  // 100% rule — mirror validateSplitsHundredPercent in the API.
  // Total of (percent×price + fixed) must equal price (within ±0.01).
  const splitsTotal = form.splits.reduce(
    (sum, s) => sum + computeSplitAmount(s, price || 0),
    0,
  );
  const splitsOk =
    form.splits.length > 0 &&
    Math.abs(splitsTotal - (price || 0)) < 0.01 &&
    (price || 0) > 0;
  if (!splitsOk && form.splits.length > 0) {
    issues.push("Splits must total 100% of the package price.");
  }

  // Document gate — for NEW claims, count staged uploads with fileKey.
  // For EDIT claims, count existing persisted documents (newly-staged docs
  // are auto-attached as they upload, so they live in `existingDocs` once
  // mark-uploaded resolves).
  const hasQuotation =
    mode === "new"
      ? form.stagedDocs.some(
          (d) => d.kind === "quotation" && d.status === "uploaded",
        )
      : existingDocs.some((d) => d.kind === "quotation");
  const hasInvoice =
    mode === "new"
      ? form.stagedDocs.some(
          (d) => d.kind === "invoice" && d.status === "uploaded",
        )
      : existingDocs.some((d) => d.kind === "invoice");
  const documentsOk = hasQuotation && hasInvoice;
  if (mode === "new" && !documentsOk) {
    issues.push("Upload a Quotation and an Invoice.");
  } else if (mode === "edit" && !documentsOk) {
    // Edit path: server still requires quote+invoice if you change anything,
    // but only blocks at approval — surface a soft warning instead.
    issues.push("This claim is missing a Quotation or Invoice document.");
  }

  return {
    splitsOk,
    documentsOk,
    canSubmit: issues.length === 0,
    firstIssue: issues[0] ?? null,
  };
}

function computeStats(claims: RenovationClaim[]) {
  let total = 0;
  let inReview = 0;
  let approved = 0;
  let approvedValue = 0;
  let needsAction = 0;
  for (const c of claims) {
    total += 1;
    if (c.status === "submitted" || c.status === "pending_approval") inReview += 1;
    if (c.status === "approved") {
      approved += 1;
      approvedValue += c.packagePrice ?? 0;
    }
    if (c.status === "rejected" || c.status === "needs_amendment") needsAction += 1;
  }
  return { total, inReview, approved, approvedValue, needsAction };
}
