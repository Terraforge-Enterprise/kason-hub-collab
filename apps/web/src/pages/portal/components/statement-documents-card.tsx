/**
 * Owner-portal "Documents" card (spec §4.2 owner visibility): the IVOWN
 * invoice minted for this statement + any credit notes against it (Plan 3).
 * Read-only; renders nothing while the flag is dark (endpoint returns []).
 */
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type StatementDocItem = {
  id: string;
  docType: string;
  documentNumber: string;
  status: string;
  issuedAt: string;
  total: string;
  reason: string | null;
};

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  debit_note: "Debit Note",
  credit_note: "Credit Note",
  refund_note: "Refund Note",
};

export function StatementDocumentsCard({ statementId }: { statementId: string }) {
  const { data } = useQuery({
    queryKey: ["portal-statement-documents", statementId],
    queryFn: () =>
      portalApiFetch<{ data: { documents: StatementDocItem[] } }>(`/statements/${statementId}/documents`),
  });
  const docs = data?.data.documents ?? [];
  if (docs.length === 0) return null;

  async function openPdf(id: string) {
    const res = await portalApiFetch<{ data: { downloadUrl: string } }>(`/statements/documents/${id}/pdf`);
    window.open(res.data.downloadUrl, "_blank", "noopener");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {docs.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <span className="font-medium">{d.documentNumber}</span>
              <span className="ml-2 text-muted-foreground">{DOC_TYPE_LABEL[d.docType] ?? d.docType}</span>
              {d.reason && <span className="ml-2 text-xs text-muted-foreground">({d.reason})</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="tabular-nums">RM {d.total}</span>
              <Badge variant="outline">{d.status}</Badge>
              <button
                onClick={() => void openPdf(d.id)}
                className="rounded-md border border-[var(--input-border)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                PDF
              </button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
