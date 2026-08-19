import { useNavigate } from "react-router-dom";
import { Calculator } from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Button } from "@/components/ui/button";

// ── Types ───────────────────────────────────────────────────────────────────

type Props = {
  items: { length: number }; // only .length is needed for the item count display
  totalNettPayout: number;
  isAmending: boolean;
  amendId: string | null;
  isEditingDraft: boolean;
  isEditingSubmitted: boolean;
  isPending: boolean;
  canSubmit: boolean;
  isSaveDraftPending: boolean;
  isUpdateDraftPending: boolean;
  isAmendPending: boolean;
  isAtomicSubmitPending: boolean;
  isSubmitExistingPending: boolean;
  onSubmit: () => void;
  onSaveDraft: () => void;
};

// ── ClaimSummary ─────────────────────────────────────────────────────────────

export function ClaimSummary({
  items,
  totalNettPayout,
  isAmending,
  amendId,
  isEditingSubmitted,
  isPending,
  canSubmit,
  isSaveDraftPending,
  isUpdateDraftPending,
  isAmendPending,
  isAtomicSubmitPending,
  isSubmitExistingPending,
  onSubmit,
  onSaveDraft,
}: Props) {
  const navigate = useNavigate();

  return (
    <>
      {/* ── Total Nett Payout — GlowCard ────────────────────────────────── */}
      <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Total Nett Payout</p>
            <p className="text-3xl font-bold text-foreground">
              RM {totalNettPayout.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{items.length} item{items.length !== 1 ? "s" : ""}</p>
          </div>
          <div className="p-3 rounded-xl bg-amber-500/10">
            <Calculator className="h-6 w-6 text-amber-600" />
          </div>
        </div>
      </GlowCard>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div className="flex gap-3">
        {isAmending ? (
          <>
            <Button
              variant="gold"
              size="lg"
              onClick={onSubmit}
              disabled={isPending || !canSubmit}
            >
              {isAmendPending ? "Saving..." : "Save Amendment"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => navigate(`/portal/claims/${amendId}`)}
            >
              Cancel
            </Button>
          </>
        ) : isEditingSubmitted ? (
          <>
            <Button
              variant="gold"
              size="lg"
              onClick={onSaveDraft}
              disabled={isPending}
            >
              {isUpdateDraftPending ? "Saving..." : "Save Changes"}
            </Button>
            <Button variant="outline" size="lg" onClick={() => navigate("/portal/claims")}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="lg"
              onClick={onSaveDraft}
              disabled={isPending}
            >
              {isSaveDraftPending || isUpdateDraftPending ? "Saving..." : "Save as Draft"}
            </Button>
            <Button
              variant="gold"
              size="lg"
              onClick={onSubmit}
              disabled={isPending || !canSubmit}
            >
              {isAtomicSubmitPending || isSubmitExistingPending ? "Submitting..." : "Submit Claim"}
            </Button>
            <Button variant="outline" size="lg" onClick={() => navigate("/portal/claims")}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </>
  );
}
