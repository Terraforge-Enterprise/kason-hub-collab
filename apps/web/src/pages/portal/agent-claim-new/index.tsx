import { useRef, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { portalApiFetch, PortalApiError } from "@/lib/portal-api";
import Decimal from "decimal.js";
import { applyClaimErrorUI } from "../components/claim-error-handler";
import {
  useClaimForm,
  type PropertyResult,
  type ClaimItemRow,
} from "./use-claim-form";
import { ClaimHeader } from "./claim-header";
import { ClaimItemsTable } from "./claim-items-table";
import { ClaimSummary } from "./claim-summary";
import { AmendmentRequestBanner } from "@/components/amendment/amendment-request-banner";
import {
  CobrokeConfirmModal,
  type CobrokeConfirmItem,
} from "./cobroke-confirm-modal";

// ── Types ───────────────────────────────────────────────────────────────────

type TierMappingResult = {
  percentage: number;
  agentLevel: string;
};

// Shape of GET /commissions/claims/:id response (subset the form hydrates from).
// The real API returns Numbers for monetary/percentage fields; we stringify them
// to match the form's string-based row shape.
type ExistingClaim = {
  id: string;
  claimNumber: string;
  status: string;
  amendmentNote?: string | null;
  claimType: "tenant_portion" | "listing_portion";
  items: Array<{
    id: string;
    propertyId: string;
    condoName: string;
    unitCode: string;
    roomType: string;
    tenantName: string;
    tenantEmail?: string;
    tenantPhone?: string;
    tenantLinkedinUrl?: string;
    tenantInstagramHandle?: string;
    tenantJobPosition?: string;
    tenantIcFrontKey?: string | null;
    tenantIcBackKey?: string | null;
    salesDate: string;
    moveInDate: string;
    moveOutDate?: string | null;
    monthlyRental: number;
    commissionPercentage: number;
    tenancyChargesByAgent: number;
    tenancyChargesByKaen: number;
    numberOfPax: number | null;
    hasPaxDeduction: boolean;
    paxDeductionAmount: number;
    hasCobrokeIntent?: boolean;
    taSharePercent?: string | null;
    remark?: string;
  }>;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapClaimItemToRow(item: ExistingClaim["items"][number]): ClaimItemRow {
  return {
    // Use the stable DB id as the row key so PropertySelector/selectedProperties
    // map lookups remain stable across re-renders.
    key: item.id,
    propertyId: item.propertyId,
    condoName: item.condoName,
    unitCode: item.unitCode,
    roomType: item.roomType,
    tenantName: item.tenantName,
    tenantEmail: item.tenantEmail ?? "",
    tenantPhone: item.tenantPhone ?? "",
    tenantLinkedinUrl: item.tenantLinkedinUrl ?? "",
    tenantInstagramHandle: item.tenantInstagramHandle ?? "",
    tenantJobPosition: item.tenantJobPosition ?? "",
    tenantIcFrontKey: item.tenantIcFrontKey ?? "",
    tenantIcBackKey: item.tenantIcBackKey ?? "",
    salesDate: item.salesDate.slice(0, 10),
    moveInDate: item.moveInDate.slice(0, 10),
    moveOutDate: item.moveOutDate ? item.moveOutDate.slice(0, 10) : "",
    monthlyRental: String(item.monthlyRental),
    commissionPercentage: String(item.commissionPercentage),
    tenancyChargesByAgent: String(item.tenancyChargesByAgent),
    tenancyChargesByKaen: String(item.tenancyChargesByKaen),
    numberOfPax: item.numberOfPax != null ? String(item.numberOfPax) : "",
    hasPaxDeduction: item.hasPaxDeduction,
    paxDeductionAmount: item.paxDeductionAmount,
    hasCobrokeIntent: item.hasCobrokeIntent ?? false,
    taSharePercent: item.taSharePercent ?? "100",
    remark: item.remark ?? "",
  };
}

function calculateNettPayout(item: ClaimItemRow, tierPercentage: number): number {
  const rental = new Decimal(item.monthlyRental || 0);
  const tierPct = new Decimal(tierPercentage);
  const commPct = new Decimal(item.commissionPercentage || 0);
  const chargesAgent = new Decimal(item.tenancyChargesByAgent || 0);
  const chargesKaen = new Decimal(item.tenancyChargesByKaen || 0);

  let adjustedRental = rental;
  if (item.hasPaxDeduction && item.numberOfPax) {
    const paxDeduction = new Decimal(item.numberOfPax).times(item.paxDeductionAmount || 0);
    adjustedRental = rental.minus(paxDeduction);
  }

  const base = adjustedRental.times(tierPct).dividedBy(100).times(commPct).dividedBy(100);
  const nett = base.plus(chargesAgent.minus(chargesKaen));
  return nett.toDecimalPlaces(2).toNumber();
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function AgentClaimNewPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editDraftId = searchParams.get("editDraft");
  const isEditingDraft = !!editDraftId;
  const amendId = searchParams.get("amend");
  const isAmending = !!amendId;
  // Resubmit mode: agent re-edits a claim the admin sent back for amendment
  // (status=needs_amendment). Mechanically identical to the draft-edit flow
  // (PATCH the items, then POST /submit) — the backend handles the state
  // transition needs_amendment -> submitted. The visual difference is the
  // AmendmentRequestBanner showing the admin's note.
  const resubmitId = searchParams.get("resubmit");
  const isResubmitting = !!resubmitId;
  // Unified "hydrate from existing claim" id — draft-edit, amend, and
  // resubmit flows all fetch the same /commissions/claims/:id endpoint
  // and pre-fill the form.
  const existingClaimId = editDraftId ?? amendId ?? resubmitId ?? null;
  const isHydrating = isEditingDraft || isAmending || isResubmitting;
  // The id used by the PATCH + POST /submit pair when saving the in-flight
  // form. Drives the URL in updateDraftMutation and the argument to
  // submitExistingMutation. Resubmit reuses these because the mechanics are
  // identical from the client's perspective.
  const inPlaceTargetId = editDraftId ?? resubmitId;

  const { state, actions } = useClaimForm();
  const {
    claimType,
    items,
    selectedProperties,
    submitBlockedError,
  } = state;

  // ── Cobroke confirm modal state ─────────────────────────────────────────
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmModalItems, setConfirmModalItems] = useState<CobrokeConfirmItem[]>([]);
  // Lifted banner data from ClaimItemsTable — keyed by item index
  const [bannerDataByIndex, setBannerDataByIndex] = useState<
    Map<number, { count: number; remainingPct: string }>
  >(new Map());
  const {
    setClaimType,
    setItems,
    setSelectedProperties,
    setFieldErrors,
    setSubmitBlockedError,
    addItem,
    removeItem,
    updateItem,
    handlePropertySelect,
    validateForm,
    hasError,
    getError,
    clearError,
    buildPayload,
  } = actions;

  // ── Existing-claim hydration ────────────────────────────────────────────
  // Both ?editDraft=<id> and ?amend=<id> fetch the same endpoint and pre-fill
  // the form once. Further renders (e.g. refetches) must NOT overwrite user
  // edits — guarded by hydratedRef.
  const { data: draftData } = useQuery({
    queryKey: ["agent-commission-claim", existingClaimId],
    queryFn: () =>
      portalApiFetch<{ data: ExistingClaim }>(`/commissions/claims/${existingClaimId}`),
    enabled: isHydrating,
  });

  // Derive whether we're editing a claim that's already been submitted (not just a draft).
  // When true, we suppress the "Submit" button and show only "Save Changes".
  const loadedClaimStatus = draftData?.data?.status ?? null;
  const isEditingSubmitted = isEditingDraft && loadedClaimStatus === "submitted";

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!draftData?.data || hydratedRef.current) return;
    hydratedRef.current = true;
    const claim = draftData.data;
    setClaimType(claim.claimType);
    setItems(claim.items.map(mapClaimItemToRow));

    // Backfill `selectedProperties` by searching each unique condoName so
    // Unit/RoomType dropdowns populate without the user having to re-pick the
    // property. Exact-name match on the returned list.
    const uniqueNames = Array.from(new Set(claim.items.map((i) => i.condoName).filter(Boolean)));
    (async () => {
      const resolved = await Promise.all(
        uniqueNames.map(async (name) => {
          try {
            const res = await portalApiFetch<{ data: PropertyResult[] }>(
              `/commissions/properties?q=${encodeURIComponent(name)}`,
            );
            const exact = res.data.find((p) => p.name === name);
            return exact ?? null;
          } catch {
            return null;
          }
        }),
      );
      setSelectedProperties((prev) => {
        const next = new Map(prev);
        claim.items.forEach((item) => {
          const prop = resolved[uniqueNames.indexOf(item.condoName)];
          if (prop) next.set(item.id, prop);
        });
        return next;
      });
    })();
  }, [draftData, setClaimType, setItems, setSelectedProperties]);

  // ── Tier mapping lookup ─────────────────────────────────────────────────

  const {
    data: tierData,
    isLoading: tierLoading,
    error: tierError,
  } = useQuery({
    queryKey: ["agent-tier-mapping", claimType],
    queryFn: () =>
      portalApiFetch<{ data: TierMappingResult }>(
        `/commissions/tier-mapping?claimType=${claimType}`,
      ),
    staleTime: 5 * 60 * 1000,
  });

  const tierPercentage = tierData?.data?.percentage ?? 0;
  const tierErrorMessage = tierError
    ? (tierError as Error).message
    : null;
  const isAgentLevelNotSet = tierErrorMessage === "Agent level not set";

  // ── Mutations ───────────────────────────────────────────────────────────

  const queryClient = useQueryClient();

  // Invalidate all claim-related queries so the list, detail, and dashboard
  // refetch after a write. Without this, the detail page shows stale "draft"
  // status until the 60s React Query staleTime elapses or the user refreshes.
  const invalidateClaimQueries = (claimId?: string) => {
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claims"] });
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claims-recent"] });
    queryClient.invalidateQueries({ queryKey: ["agent-commission-dashboard"] });
    if (claimId) {
      queryClient.invalidateQueries({ queryKey: ["agent-commission-claim", claimId] });
    }
  };

  // Atomic submit: POST /claims/submit creates + submits in one go. On 409
  // (Rule B / Rule C) nothing is persisted — no orphan draft.
  const atomicSubmitMutation = useMutation({
    mutationFn: (body: object) =>
      portalApiFetch<{ data: { id: string; claimNumber: string } }>(
        "/commissions/claims/submit",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (res) => invalidateClaimQueries(res.data.id),
  });

  // Explicit Save-as-Draft: POST /claims without the /submit step.
  const saveDraftMutation = useMutation({
    mutationFn: (body: object) =>
      portalApiFetch<{ data: { id: string; claimNumber: string } }>(
        "/commissions/claims",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (res) => invalidateClaimQueries(res.data.id),
  });

  // Edit-draft / resubmit mode: PATCH the existing claim in place. Used
  // for both draft and needs_amendment source states — backend accepts
  // both via the widened updateDraftService precondition.
  const updateDraftMutation = useMutation({
    mutationFn: (body: object) =>
      portalApiFetch<{ data: { id: string } }>(
        `/commissions/claims/${inPlaceTargetId}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (res) => invalidateClaimQueries(res.data.id),
  });

  // Edit-draft mode: promote the existing draft to submitted (two-step after
  // PATCH). Preserves the claim ID — no duplicate claim is created.
  const submitExistingMutation = useMutation({
    mutationFn: (claimId: string) =>
      portalApiFetch<{ data: { id: string; claimNumber: string } }>(
        `/commissions/claims/${claimId}/submit`,
        { method: "POST" },
      ),
    onSuccess: (res) => invalidateClaimQueries(res.data.id),
  });

  // Amend mode: PATCH /claims/:id/amend — flips `approved` → `amended` (or
  // `amended` → `amended`) and replaces items atomically. Body schema mirrors
  // the draft PATCH (permissive saveDraftSchema), but hits the amend route.
  const amendMutation = useMutation({
    mutationFn: (body: object) =>
      portalApiFetch<{ data: { id: string; status: "amended" } }>(
        `/commissions/claims/${amendId}/amend`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (res) => invalidateClaimQueries(res.data.id),
  });

  // ── Shared error-handling path for both atomic-submit and save-draft ────

  const handleFormError = (err: unknown) => {
    if (err instanceof PortalApiError && err.body && typeof err.body === "object" && "error" in err.body) {
      applyClaimErrorUI(err.body as never, setSubmitBlockedError);
      return;
    }
    // Fallback for unexpected non-structured errors.
    const msg = err instanceof Error ? err.message : "Something went wrong";
    toast.error("Submission failed", { description: msg });
    setSubmitBlockedError(msg);
  };

  const actuallySubmit = async () => {
    try {
      if (isAmending && amendId) {
        // Amend mode has no separate "submit" step — the PATCH itself moves
        // the claim to `amended` and notifies the admin via the re-approve
        // queue. We still run the strict `validateForm()` above so the amend
        // payload must be valid before landing.
        await amendMutation.mutateAsync(buildPayload(claimType, items));
        toast.success("Amendment saved", {
          description: "The claim has been flipped to Amended. An admin must re-approve.",
        });
        navigate(`/portal/claims/${amendId}`);
        return;
      }
      if ((isEditingDraft && editDraftId) || (isResubmitting && resubmitId)) {
        // Save the latest edits first, then POST /submit. Used for both
        // draft-edit (draft -> submitted) and resubmit (needs_amendment ->
        // submitted) — backend's submitClaimService accepts both source
        // states and clears amendmentNote in the same update.
        const targetId = (isEditingDraft ? editDraftId : resubmitId) as string;
        await updateDraftMutation.mutateAsync(buildPayload(claimType, items));
        const res = await submitExistingMutation.mutateAsync(targetId);
        toast.success(isResubmitting ? "Claim resubmitted" : "Claim submitted", {
          description: isResubmitting
            ? "Your changes have been resubmitted for admin review."
            : `Submitted as ${res.data.claimNumber}.`,
        });
        navigate(`/portal/claims/${targetId}`);
      } else {
        const res = await atomicSubmitMutation.mutateAsync(buildPayload(claimType, items));
        toast.success("Claim submitted", {
          description: `Submitted as ${res.data.claimNumber}.`,
        });
        navigate(`/portal/claims/${res.data.id}`);
      }
    } catch (err: unknown) {
      handleFormError(err);
    }
  };

  const handleSubmit = async () => {
    setSubmitBlockedError(null);
    const errors = validateForm();
    setFieldErrors(errors);
    if (errors.length > 0) {
      const firstError = errors[0];
      document
        .getElementById(`field-${firstError.itemIndex}-${firstError.field}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // ── Cobroke confirmation gate ─────────────────────────────────────────
    // Items where hasCobrokeIntent === true AND no prior sibling claims exist
    // need a confirmation modal so the agent knows their cobroke partner must
    // file their own claim for the remaining share.
    const cobrokeItems = items
      .map((it, idx) => ({
        item: it,
        banner: bannerDataByIndex.get(idx),
      }))
      .filter(({ item, banner }) =>
        item.hasCobrokeIntent === true && (banner?.count ?? 0) === 0
      )
      .map(({ item }) => ({
        condoName: item.condoName,
        unitCode: item.unitCode,
        roomType: item.roomType,
        commissionSharePercent: item.commissionPercentage,
        taSharePercent: item.taSharePercent,
      }));

    if (cobrokeItems.length > 0) {
      setConfirmModalItems(cobrokeItems);
      setConfirmModalOpen(true);
      return; // wait for user to confirm
    }

    await actuallySubmit();
  };

  const handleSaveDraft = async () => {
    setSubmitBlockedError(null);
    // Drafts intentionally skip client-side validateForm — Save as Draft is
    // for work-in-progress. The server's saveDraftSchema requires only
    // propertyId per item; all other fields get safe defaults. The submit
    // path runs the full strict validation.
    try {
      if (isEditingDraft && editDraftId) {
        await updateDraftMutation.mutateAsync(buildPayload(claimType, items));
        toast.success(isEditingSubmitted ? "Changes saved" : "Draft updated", {
          description: "Your changes have been saved.",
        });
        navigate(`/portal/claims/${editDraftId}`);
      } else {
        const res = await saveDraftMutation.mutateAsync(buildPayload(claimType, items));
        toast.success("Draft saved", {
          description: `Saved as ${res.data.claimNumber}. You can continue editing later.`,
        });
        navigate(`/portal/claims/${res.data.id}`);
      }
    } catch (err: unknown) {
      handleFormError(err);
    }
  };

  // ── Calculations ────────────────────────────────────────────────────────

  const itemPayouts = items.map((item) => {
    if (!item.monthlyRental || !item.commissionPercentage || !item.tenancyChargesByKaen) return 0;
    return calculateNettPayout(item, tierPercentage);
  });

  const totalNettPayout = itemPayouts.reduce((sum, v) => sum + v, 0);

  // ── Derived state ───────────────────────────────────────────────────────

  const isPending =
    atomicSubmitMutation.isPending ||
    saveDraftMutation.isPending ||
    updateDraftMutation.isPending ||
    submitExistingMutation.isPending ||
    amendMutation.isPending;
  const mutationError =
    atomicSubmitMutation.error ||
    saveDraftMutation.error ||
    updateDraftMutation.error ||
    submitExistingMutation.error ||
    amendMutation.error;
  const canSubmit = !tierError && !tierLoading && tierPercentage > 0;

  return (
    <div className="space-y-6">
      <CobrokeConfirmModal
        open={confirmModalOpen}
        items={confirmModalItems}
        onConfirm={() => {
          setConfirmModalOpen(false);
          void actuallySubmit();
        }}
        onCancel={() => setConfirmModalOpen(false)}
      />

      {isResubmitting && draftData?.data?.amendmentNote ? (
        <AmendmentRequestBanner note={draftData.data.amendmentNote} />
      ) : null}

      <ClaimHeader
        isAmending={isAmending}
        isEditingDraft={isEditingDraft}
        isAgentLevelNotSet={isAgentLevelNotSet}
        tierErrorMessage={tierErrorMessage}
        mutationError={mutationError as Error | null}
        submitBlockedError={submitBlockedError}
        claimType={claimType}
        onChangeClaimType={setClaimType}
        tierLoading={tierLoading}
        tierError={tierError as Error | null}
        tierPercentage={tierPercentage}
      />

      <ClaimItemsTable
        items={items}
        claimType={claimType}
        selectedProperties={selectedProperties}
        tierPercentage={tierPercentage}
        hasError={hasError}
        getError={getError}
        onAddItem={addItem}
        onRemoveItem={removeItem}
        onUpdateItem={updateItem}
        onPropertySelect={handlePropertySelect}
        onClearError={clearError}
        onBannerData={(idx, data) =>
          setBannerDataByIndex((prev) => {
            const next = new Map(prev);
            if (data) {
              next.set(idx, data);
            } else {
              next.delete(idx);
            }
            return next;
          })
        }
      />

      <ClaimSummary
        items={items}
        totalNettPayout={totalNettPayout}
        isAmending={isAmending}
        amendId={amendId}
        isEditingDraft={isEditingDraft}
        isEditingSubmitted={isEditingSubmitted}
        isPending={isPending}
        canSubmit={canSubmit}
        isSaveDraftPending={saveDraftMutation.isPending}
        isUpdateDraftPending={updateDraftMutation.isPending}
        isAmendPending={amendMutation.isPending}
        isAtomicSubmitPending={atomicSubmitMutation.isPending}
        isSubmitExistingPending={submitExistingMutation.isPending}
        onSubmit={handleSubmit}
        onSaveDraft={handleSaveDraft}
      />
    </div>
  );
}
