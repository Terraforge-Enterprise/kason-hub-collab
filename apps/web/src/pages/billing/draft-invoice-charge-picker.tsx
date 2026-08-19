/**
 * Draft Invoice Charge Picker
 * Small modal that lists "draft" charges and lets the user attach one to an invoice.
 * Opened by the "Add charge" button in DraftInvoiceDrawer.
 *
 * Limitation: the picker fetches ALL charges from GET /billing/charges and filters
 * client-side to status === "draft", preferring those whose tenancyCode matches the
 * invoice's tenancy. There is no server-side endpoint to list "attachable" charges for
 * a specific invoice, so the list may include charges from unrelated tenancies.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PlusCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { Callout } from "@/components/ui/callout";
import { formatMoney } from "@/components/format";
import { apiFetch, ApiError } from "@/lib/api-client";
import { PHASE2_STATUS_TONES } from "@kason/shared";

type ChargeListItem = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  status: string;
  amount: number;
  currency: string;
  tenancyCode: string | null;
  partyName: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  tenancyCode?: string | null;
  /** Optional post-attach hook. This component owns query invalidation. */
  onAttached?: () => void;
};

export function DraftInvoiceChargePicker({
  open,
  onOpenChange,
  invoiceId,
  tenancyCode,
  onAttached,
}: Props) {
  const qc = useQueryClient();
  const [attaching, setAttaching] = useState<string | null>(null);

  const chargesQ = useQuery({
    queryKey: ["billing", "charges"],
    queryFn: () =>
      apiFetch<{ data: ChargeListItem[] }>("/billing/charges").then((r) => r.data),
    enabled: open,
  });

  // Filter to draft charges only; prefer same-tenancy charges first
  const candidates = (chargesQ.data ?? [])
    .filter((c) => c.status === "draft")
    .sort((a, b) => {
      const aMatch = a.tenancyCode === tenancyCode ? -1 : 0;
      const bMatch = b.tenancyCode === tenancyCode ? -1 : 0;
      return aMatch - bMatch;
    });

  const attachMutation = useMutation({
    mutationFn: (chargeId: string) =>
      apiFetch(`/billing/invoices/${invoiceId}/charges`, {
        method: "POST",
        body: JSON.stringify({ chargeId }),
      }),
    onMutate: (chargeId) => setAttaching(chargeId),
    onSuccess: () => {
      toast.success("Charge attached to invoice.");
      void qc.invalidateQueries({ queryKey: ["billing", "invoice", invoiceId] });
      void qc.invalidateQueries({ queryKey: ["billing", "draft-invoices"] });
      onAttached?.();
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.warning(err.message || "Charge already attached — refreshing.");
        void qc.invalidateQueries({ queryKey: ["billing", "invoice", invoiceId] });
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to attach charge.");
      }
    },
    onSettled: () => setAttaching(null),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} lockProgress={false}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusCircle className="h-5 w-5 text-primary" />
            Add charge to invoice
          </DialogTitle>
          <DialogDescription>
            Select a draft charge to attach to this invoice.
          </DialogDescription>
        </DialogHeader>

        {tenancyCode && (
          <Callout variant="info">
            Charges matching tenancy <strong>{tenancyCode}</strong> are shown first.
          </Callout>
        )}

        <Callout variant="warning">
          Only charges with status <strong>draft</strong> can be attached. The list may
          include charges from other tenancies — verify before attaching.
        </Callout>

        {chargesQ.isLoading ? (
          <div className="space-y-2 animate-pulse py-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-muted" />
            ))}
          </div>
        ) : chargesQ.isError ? (
          <p className="py-4 text-center text-sm text-rose-600">
            Failed to load charges. Please close and retry.
          </p>
        ) : (
          <TableWrap>
            <DataTable>
              <TableHead>
                <tr>
                  <HeadCell>Charge #</HeadCell>
                  <HeadCell>Type</HeadCell>
                  <HeadCell>Party</HeadCell>
                  <HeadCell>Tenancy</HeadCell>
                  <HeadCell className="text-right">Amount</HeadCell>
                  <HeadCell>Status</HeadCell>
                  <HeadCell className="w-20">
                    <span className="sr-only">Actions</span>
                  </HeadCell>
                </tr>
              </TableHead>
              <tbody>
                {candidates.length === 0 ? (
                  <EmptyRow colSpan={7} label="No draft charges available to attach." />
                ) : (
                  candidates.map((c) => {
                    const tone =
                      PHASE2_STATUS_TONES.charge[
                        c.status as keyof typeof PHASE2_STATUS_TONES.charge
                      ] ?? "slate";
                    return (
                      <Row key={c.id}>
                        <BodyCell className="font-medium">{c.chargeNumber}</BodyCell>
                        <BodyCell>{c.chargeType}</BodyCell>
                        <BodyCell>{c.partyName}</BodyCell>
                        <BodyCell>{c.tenancyCode ?? "-"}</BodyCell>
                        <BodyCell className="text-right">
                          {formatMoney(c.amount, c.currency)}
                        </BodyCell>
                        <BodyCell>
                          <StatusPill tone={tone}>{c.status}</StatusPill>
                        </BodyCell>
                        <BodyCell>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={attaching === c.id || attachMutation.isPending}
                            onClick={() => attachMutation.mutate(c.id)}
                          >
                            {attaching === c.id ? "Attaching…" : "Attach"}
                          </Button>
                        </BodyCell>
                      </Row>
                    );
                  })
                )}
              </tbody>
            </DataTable>
          </TableWrap>
        )}
      </DialogContent>
    </Dialog>
  );
}
