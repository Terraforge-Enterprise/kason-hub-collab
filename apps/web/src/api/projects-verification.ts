import { apiFetch } from "@/lib/api-client";

export type PendingProject = {
  id: string;
  name: string;
  developer: string;
  city: string | null;
  expectedHandover: string | null;
  notes: string | null;
  createdAt: string;
  createdById: string | null;
};

export function listPendingVerification(): Promise<{ data: PendingProject[] }> {
  return apiFetch<{ data: PendingProject[] }>("/projects/pending-verification");
}

export function verifyProject(id: string): Promise<{ data: { id: string; status: string } }> {
  return apiFetch<{ data: { id: string; status: string } }>(
    `/projects/${id}/verify`,
    { method: "POST" },
  );
}

export function rejectProject(
  id: string,
  note: string,
): Promise<{ data: { id: string; status: string } }> {
  return apiFetch<{ data: { id: string; status: string } }>(
    `/projects/${id}/reject`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}
