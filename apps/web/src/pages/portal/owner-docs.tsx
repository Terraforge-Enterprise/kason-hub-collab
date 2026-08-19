import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, FileText } from "lucide-react";
import { portalApiFetch } from "@/lib/portal-api";
import { formatDateMY } from "@/components/format";
import { EmptyState } from "@/components/empty-state";

type OwnerDoc = { id: string; title: string; fileType: string; createdAt: string };

export default function OwnerDocsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["portal-owner-docs"],
    queryFn: () => portalApiFetch<{ data: OwnerDoc[] }>("/owner-docs"),
  });

  const [search, setSearch] = useState("");
  const docs = useMemo(() => data?.data ?? [], [data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) => d.title.toLowerCase().includes(q) || d.fileType.toLowerCase().includes(q),
    );
  }, [docs, search]);

  if (isLoading) return <OwnerDocsSkeleton />;

  return (
    <div className="space-y-6">
      {/* Header — design-standard (frontend SKILL §6) */}
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <FolderOpen className="h-8 w-8 text-primary" />
          Documents
        </h1>
        <p className="text-muted-foreground mt-1">
          Your statements, tax documents and property files.
        </p>
      </div>

      <input
        type="text"
        aria-label="Search documents"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search documents..."
        className="w-full max-w-sm rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={docs.length === 0 ? "No documents yet" : "No documents match your search"}
          description={
            docs.length === 0
              ? "Your statements and property documents will appear here."
              : "Try a different search term."
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((doc) => (
            // Note: /owner-docs returns no download URL, so rows are display-only
            // (no fabricated View/Download link — frontend SKILL §16).
            <div
              key={doc.id}
              className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80"
            >
              <div className="flex items-center gap-3 min-w-0">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <span className="text-sm text-foreground block truncate">{doc.title}</span>
                  <span className="text-xs text-muted-foreground block">
                    {doc.fileType} · {formatDateMY(doc.createdAt)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OwnerDocsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-56 bg-muted rounded" />
      <div className="h-9 w-full max-w-sm bg-muted rounded" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 bg-muted rounded-lg" />
        ))}
      </div>
    </div>
  );
}
