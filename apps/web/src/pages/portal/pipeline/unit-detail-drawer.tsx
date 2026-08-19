/**
 * UnitDetailDrawer — opens when `?unit=<id>` is in the pipeline URL.
 *
 * Shows the unit's renovation progress + per-stage Segmented flip controls
 * + a "Mark renovation complete" CTA. Backed by the portal-only
 * `GET /portal-api/sales/units/:id/detail` endpoint, which joins project,
 * owner, and renovationProgress (with stages) so we render in one round-trip.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { Callout } from "@/components/ui/callout";
import { Badge } from "@/components/ui/badge";
import { StageProgressBar } from "@/components/stage-progress-bar";
import { StageChips } from "@/components/stage-chips";
import { formatDate } from "@/components/format";
import {
  getPortalSalesUnitDetail,
  type PortalSalesUnitDetail,
  type PortalSalesUnitDetailStage,
} from "@/api/portal-sales-units-detail";
import {
  flipStageStatus,
  markRenovationComplete,
  type StageStatus,
} from "@/api/portal-renovation-progress";

type Props = {
  unitId: string;
  onClose: () => void;
};

const STAGE_OPTIONS: { value: StageStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "On going" },
  { value: "completed", label: "Done" },
];

type RenovationStatus = "not_started" | "on_going" | "completed";
const PROGRESS_BADGE_VARIANT: Record<RenovationStatus, "outline" | "amber" | "emerald"> = {
  not_started: "outline",
  on_going: "amber",
  completed: "emerald",
};
const PROGRESS_BADGE_LABEL: Record<RenovationStatus, string> = {
  not_started: "Not started",
  on_going: "On going",
  completed: "Completed",
};

export function UnitDetailDrawer({ unitId, onClose }: Props) {
  const qc = useQueryClient();
  const { data: unit, isLoading, isError } = useQuery({
    queryKey: ["portal-sales-unit-detail", unitId],
    queryFn: () => getPortalSalesUnitDetail(unitId),
  });

  const [confirmOpen, setConfirmOpen] = useState(false);

  const flipMutation = useMutation({
    mutationFn: ({
      progressId,
      stageProgressId,
      status,
    }: {
      progressId: string;
      stageProgressId: string;
      status: StageStatus;
    }) => flipStageStatus(progressId, stageProgressId, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portal-sales-unit-detail", unitId] });
      qc.invalidateQueries({ queryKey: ["portal-sales-units"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const completeMutation = useMutation({
    mutationFn: (progressId: string) => markRenovationComplete(progressId),
    onSuccess: () => {
      toast.success("Renovation marked complete.");
      qc.invalidateQueries({ queryKey: ["portal-sales-unit-detail", unitId] });
      qc.invalidateQueries({ queryKey: ["portal-sales-units"] });
      setConfirmOpen(false);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setConfirmOpen(false);
    },
  });

  const progress = unit?.renovationProgress ?? null;
  const totalStages = progress?.stages.length ?? 0;
  const completedStages =
    progress?.stages.filter((s) => s.status === "completed").length ?? 0;
  const allDone = totalStages > 0 && completedStages === totalStages;
  const alreadyCompleted = progress?.status === "completed";

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent size="lg">
          <SheetHeader>
            <SheetTitle>
              {unit ? (
                <>
                  {unit.project.name} <span className="text-muted-foreground">·</span>{" "}
                  {unit.unitNumber}
                </>
              ) : (
                "Unit detail"
              )}
            </SheetTitle>
            <SheetDescription>
              {unit
                ? `Owner: ${unit.ownerParty.displayName} · Sold ${formatDate(unit.salesDate)}`
                : "Loading…"}
            </SheetDescription>
          </SheetHeader>

          <SheetBody className="space-y-6">
            {isLoading && (
              <p className="text-sm text-muted-foreground">Loading unit detail…</p>
            )}
            {isError && (
              <p className="text-sm text-destructive">
                Failed to load unit detail.
              </p>
            )}

            {unit && !progress && (
              <Callout variant="info">No renovation tracked for this unit.</Callout>
            )}

            {unit && progress && (
              <>
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                      Renovation progress
                    </h3>
                    <Badge variant={PROGRESS_BADGE_VARIANT[progress.status]}>
                      {PROGRESS_BADGE_LABEL[progress.status]}
                    </Badge>
                  </div>
                  <StageProgressBar
                    completed={completedStages}
                    total={totalStages}
                  />
                  <StageChips
                    stages={progress.stages.map((s) => ({
                      stageKey: s.stageKey,
                      stageLabel: s.stageLabel,
                      status: s.status,
                    }))}
                  />
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Stages
                  </h3>
                  <ul className="space-y-3">
                    {progress.stages.map((stage) => (
                      <StageRow
                        key={stage.stageProgressId}
                        stage={stage}
                        disabled={
                          alreadyCompleted || flipMutation.isPending
                        }
                        onChange={(next) =>
                          flipMutation.mutate({
                            progressId: progress.id,
                            stageProgressId: stage.stageProgressId,
                            status: next,
                          })
                        }
                      />
                    ))}
                  </ul>
                </section>

                <section className="border-t border-border/50 pt-4">
                  {alreadyCompleted ? (
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">
                      ✓ Renovation completed
                      {progress.actualCompletion
                        ? ` on ${progress.actualCompletion.slice(0, 10)}`
                        : ""}
                      .
                    </p>
                  ) : (
                    <Button
                      variant="gold"
                      disabled={!allDone || completeMutation.isPending}
                      onClick={() => setConfirmOpen(true)}
                    >
                      Mark renovation complete
                    </Button>
                  )}
                </section>
              </>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {progress && !alreadyCompleted && (
        <ConfirmAlert
          open={confirmOpen}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => completeMutation.mutate(progress.id)}
          title="Mark renovation complete?"
          body="This locks the renovation as completed. Confirm that all stages are marked completed and the unit is ready to graduate."
          confirmLabel="Mark complete"
        />
      )}
    </>
  );
}

function StageRow({
  stage,
  disabled,
  onChange,
}: {
  stage: PortalSalesUnitDetailStage;
  disabled: boolean;
  onChange: (next: StageStatus) => void;
}) {
  return (
    <li className="rounded-lg border border-border/50 bg-background/40 backdrop-blur-sm p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-[var(--text-primary)]">
          {stage.stageLabel}
        </p>
        <span className="text-xs text-[var(--text-muted)]">
          #{stage.sortOrder}
        </span>
      </div>
      <Segmented
        ariaLabel={`Status for ${stage.stageLabel}`}
        value={stage.status}
        onChange={onChange}
        options={STAGE_OPTIONS}
        size="sm"
        disabled={disabled}
      />
    </li>
  );
}

export type { PortalSalesUnitDetail };
