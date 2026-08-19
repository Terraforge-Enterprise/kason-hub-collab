import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { apiFetch, ApiError } from "@/lib/api-client";

export function ListingModeFlipDialog({
  open,
  onOpenChange,
  apartmentId,
  currentMode,
  targetMode,
  activeListings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apartmentId: string;
  currentMode: "WHOLE" | "PARTITIONED" | "MIXED" | null;
  targetMode: "WHOLE" | "PARTITIONED";
  activeListings: { id: string; unitType: string; rentalRate: number | null }[];
}) {
  const qc = useQueryClient();
  const flip = useMutation({
    mutationFn: () =>
      apiFetch(`/apartments/${apartmentId}/flip-mode`, {
        method: "POST",
        body: JSON.stringify({ targetMode }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(
        `Switched to ${targetMode === "WHOLE" ? "whole unit" : "partitioned"}.`,
      );
      onOpenChange(false);
    },
    onError: (err: Error) => {
      // Backend returns string codes via err() helper: MODE_UNCHANGED (409),
      // NO_WHOLE_ROOMTYPE / NO_PARTITION_ROOMTYPE (422). Humanize them.
      const raw = err instanceof ApiError ? err.message : err.message;
      if (raw === "MODE_UNCHANGED") {
        toast.info(
          `This apartment is already in ${targetMode === "WHOLE" ? "whole unit" : "partitioned"} mode.`,
        );
        return;
      }
      if (raw === "NO_WHOLE_ROOMTYPE") {
        toast.error(
          "No 'Whole' room type configured yet. Add one in Inventory Settings → Unit Types, then try again.",
          { duration: 8000 },
        );
        return;
      }
      if (raw === "NO_PARTITION_ROOMTYPE") {
        toast.error(
          "No 'Partition' room type configured yet. Add one in Inventory Settings → Unit Types, then try again.",
          { duration: 8000 },
        );
        return;
      }
      toast.error(raw || "Failed to switch mode");
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Switch to {targetMode === "WHOLE" ? "whole unit" : "partitioned"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {currentMode === "MIXED"
              ? `This apartment currently has a mix of listing kinds. Switching to ${targetMode === "WHOLE" ? "whole unit" : "partitioned"} will keep matching listings active and park the rest. They stay in the database and come back if you switch the mode back.`
              : activeListings.length === 0
                ? "No active listings to switch yet — a new draft listing will be seeded for you."
                : `Switching mode parks the current listings (they stay in the DB; flipping back restores them). If no listings exist in the target kind yet, a draft one will be seeded.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {activeListings.length > 0 && (
          <ul className="text-sm text-muted-foreground space-y-1 max-h-40 overflow-y-auto">
            {activeListings.map((l) => (
              <li key={l.id}>
                &bull; {l.unitType}
                {l.rentalRate ? ` · RM ${l.rentalRate}` : ""}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <Button
            variant="destructive"
            disabled={flip.isPending}
            onClick={() => flip.mutate()}
          >
            {flip.isPending ? "Switching…" : "Switch mode"}
          </Button>
          <Button
            variant="ghost"
            disabled={flip.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
