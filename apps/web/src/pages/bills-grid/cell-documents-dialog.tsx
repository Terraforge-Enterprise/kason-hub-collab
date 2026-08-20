import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, ReceiptText, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAttachmentUrl, listAttachments, uploadAttachments, GRID_QUERY_KEY_ROOT, type AttachmentListItem } from "@/api/bills-grid";
import { BillLightbox, isImageFilename } from "@/pages/tenancy/owner-statement/bill-lightbox";
import type { ColumnId } from "./columns";

export type CellDocumentKind = "invoice" | "receipt";
export type CellDocumentTarget = {
  apartmentId: string;
  cellKey: string;
  columnId: ColumnId;
  periodMonth: string;
  unitLabel: string;
  columnLabel: string;
  initialKind?: CellDocumentKind;
};

export function CellDocumentsDialog({ target, onClose, onRecordPayment }: {
  target: CellDocumentTarget | null;
  onClose: () => void;
  onRecordPayment: (target: CellDocumentTarget) => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<CellDocumentKind>(() => target?.initialKind ?? "invoice");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scope = target ? { cellKey: target.cellKey, columnId: target.columnId } : null;
  const queryKey = ["bills-grid", "cell-documents", target?.apartmentId, target?.periodMonth, target?.cellKey, target?.columnId];

  const listQuery = useQuery({
    queryKey,
    queryFn: () => listAttachments(target!.apartmentId, target!.periodMonth, scope!),
    enabled: target != null,
  });
  const items = listQuery.data?.items ?? [];
  const visibleItems = items.filter((item) => item.documentKind === kind);
  const invoiceCount = items.filter((item) => item.documentKind === "invoice").length;
  const receiptCount = items.filter((item) => item.documentKind === "receipt").length;

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadAttachments(target!.apartmentId, target!.periodMonth, files, {
      cellKey: target!.cellKey,
      columnId: target!.columnId,
      documentKind: kind,
    }),
    onSuccess: async () => {
      toast.success(`${kind === "invoice" ? "Invoice" : "Receipt"} uploaded.`);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: GRID_QUERY_KEY_ROOT });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Upload failed."),
  });

  const [preview, setPreview] = useState<AttachmentListItem | null>(null);
  const previewQuery = useQuery({
    queryKey: ["bills-grid", "attachment-url", preview?.id],
    queryFn: () => getAttachmentUrl(preview!.id),
    enabled: preview != null,
  });

  return (
    <>
      <Dialog open={target != null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Cell documents · {target?.unitLabel}</DialogTitle>
            <DialogDescription>{target?.columnLabel} · Uploads stay linked to this exact cell and billing month.</DialogDescription>
          </DialogHeader>

          <div className="mb-4 flex items-center gap-2">
            <Button type="button" variant={kind === "invoice" ? "default" : "outline"} onClick={() => setKind("invoice")}>
              <FileText className="mr-2 h-4 w-4" /> Invoice ({invoiceCount})
            </Button>
            <Button type="button" variant={kind === "receipt" ? "default" : "outline"} onClick={() => setKind("receipt")}>
              <ReceiptText className="mr-2 h-4 w-4" /> Receipt ({receiptCount})
            </Button>
          </div>

          <input ref={inputRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) upload.mutate(files);
            event.target.value = "";
          }} />
          <Button type="button" variant="gold" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
            <UploadCloud className="mr-2 h-4 w-4" /> {upload.isPending ? "Uploading…" : `Upload ${kind}`}
          </Button>

          <div className="mt-4 min-h-32 rounded-xl border border-[var(--border)] bg-white">
            {listQuery.isLoading ? <p className="p-5 text-muted-foreground">Loading…</p> : visibleItems.length === 0 ? (
              <p className="p-5 text-muted-foreground">No {kind}s uploaded for this cell.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {visibleItems.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-4 p-4">
                    <span className="min-w-0 truncate text-[16px] font-semibold text-[var(--navy-text)]">{item.filename}</span>
                    <Button type="button" variant="outline" onClick={() => setPreview(item)}>View</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {kind === "receipt" && receiptCount > 0 && target && (
            <div className="mt-5 flex items-center justify-between rounded-xl border border-emerald-300 bg-emerald-50 p-4">
              <p className="text-sm text-emerald-900">Receipt uploaded. Record the actual payment to update Paid/Partial Paid correctly.</p>
              <Button type="button" onClick={() => onRecordPayment(target)}>Record / Mark Paid</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <BillLightbox
        open={preview != null}
        index={preview ? visibleItems.findIndex((item) => item.id === preview.id) : null}
        total={visibleItems.length}
        url={previewQuery.data?.downloadUrl}
        label={preview?.filename ?? ""}
        isImage={preview ? preview.contentType.startsWith("image/") || isImageFilename(preview.filename) : false}
        onClose={() => setPreview(null)}
        onPrev={() => setPreview((current) => { const i = visibleItems.findIndex((item) => item.id === current?.id); return visibleItems[(i - 1 + visibleItems.length) % visibleItems.length] ?? null; })}
        onNext={() => setPreview((current) => { const i = visibleItems.findIndex((item) => item.id === current?.id); return visibleItems[(i + 1) % visibleItems.length] ?? null; })}
      />
    </>
  );
}
