import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listPendingVerification,
  rejectProject,
  verifyProject,
  type PendingProject,
} from "@/api/projects-verification";
import { Button } from "@/components/ui/button";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { formatDate } from "@/components/format";

export function SourceQueueProjectsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["projects-pending-verification"],
    queryFn: listPendingVerification,
  });

  const verify = useMutation({
    mutationFn: (id: string) => verifyProject(id),
    onSuccess: () => {
      toast.success("Project verified");
      qc.invalidateQueries({ queryKey: ["projects-pending-verification"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [rejectTarget, setRejectTarget] = useState<PendingProject | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const reject = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => rejectProject(id, note),
    onSuccess: () => {
      toast.success("Project rejected");
      qc.invalidateQueries({ queryKey: ["projects-pending-verification"] });
      setRejectTarget(null);
      setRejectNote("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-[var(--text-muted)]">Loading…</div>;
  }

  const projects = data?.data ?? [];

  if (projects.length === 0) {
    return (
      <div className="p-6 text-sm text-[var(--text-muted)]">
        No pending projects to verify.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {projects.map((p) => (
          <div
            key={p.id}
            className="flex items-start justify-between rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] p-4"
          >
            <div>
              <p className="font-semibold text-[var(--text-primary)]">{p.name}</p>
              <p className="text-sm text-[var(--text-secondary)]">
                {p.developer}
                {p.city ? ` · ${p.city}` : ""}
                {p.expectedHandover ? ` · Expected ${formatDate(p.expectedHandover)}` : ""}
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Filed {formatDate(p.createdAt)}
              </p>
              {p.notes ? (
                <p className="mt-2 text-xs italic text-[var(--text-muted)]">{p.notes}</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                variant="gold"
                size="sm"
                disabled={verify.isPending}
                onClick={() => verify.mutate(p.id)}
              >
                Verify
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRejectTarget(p)}
              >
                Reject
              </Button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmAlert
        open={rejectTarget !== null}
        onCancel={() => { setRejectTarget(null); setRejectNote(""); }}
        onConfirm={() => {
          if (!rejectTarget) return;
          if (rejectNote.trim().length < 3) {
            toast.error("Please provide a reason (at least 3 characters).");
            return;
          }
          reject.mutate({ id: rejectTarget.id, note: rejectNote.trim() });
        }}
        title="Reject this project?"
        body={
          rejectTarget ? (
            <div className="space-y-3">
              <p>
                Archive <strong>{rejectTarget.name}</strong> and notify the agent.
              </p>
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Reason for rejection (e.g. duplicate of existing project)…"
                className="w-full min-h-[80px] rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm"
              />
            </div>
          ) : ""
        }
        confirmLabel="Reject"
        destructive
      />
    </>
  );
}
