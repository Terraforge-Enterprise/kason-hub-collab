// Admin-side dialog for creating a Project (Sales Pipeline parent
// entity). Mirrors the portal's "+ Create new project" flow but bypasses
// the unverified→approved cycle since admins are the approvers — server
// accepts `status: "active"` directly. Manager+ gated by the API.

import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import {
  createSalesProject,
  type CreateAdminProjectPayload,
} from "@/api/sales";

const EMPTY_FORM: CreateAdminProjectPayload = {
  name: "",
  developer: "",
  city: "",
  expectedHandover: "",
  notes: "",
  status: "active",
};

export function CreateProjectDialog({ trigger }: { trigger: ReactNode }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateAdminProjectPayload>(EMPTY_FORM);

  const create = useMutation({
    mutationFn: () => {
      // Server requires ISO datetime; convert from yyyy-mm-dd input.
      const payload: CreateAdminProjectPayload = {
        name: form.name.trim(),
        developer: form.developer.trim(),
        status: "active", // admin-created → active immediately
      };
      if (form.city?.trim()) payload.city = form.city.trim();
      if (form.notes?.trim()) payload.notes = form.notes.trim();
      if (form.expectedHandover) {
        payload.expectedHandover = new Date(
          `${form.expectedHandover}T00:00:00Z`,
        ).toISOString();
      }
      return createSalesProject(payload);
    },
    onSuccess: () => {
      toast.success("Project created.");
      // Match the existing admin pipeline page's query key.
      queryClient.invalidateQueries({ queryKey: ["projects", "all"] });
      setForm(EMPTY_FORM);
      setOpen(false);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Failed to create project";
      toast.error(msg);
    },
  });

  const canSubmit =
    form.name.trim() !== "" && form.developer.trim() !== "" && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Add a development the team is helping sell. Once created, agents
            can pick it on their sales-unit submission form.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted-foreground">
              Project name *
            </span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Aurora Residences"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Developer *</span>
            <Input
              value={form.developer}
              onChange={(e) => setForm({ ...form, developer: e.target.value })}
              placeholder="e.g. Mah Sing Group"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-muted-foreground">City</span>
              <Input
                value={form.city ?? ""}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                placeholder="e.g. Petaling Jaya"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Expected handover
              </span>
              <Input
                type="date"
                value={form.expectedHandover ?? ""}
                onChange={(e) =>
                  setForm({ ...form, expectedHandover: e.target.value })
                }
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-muted-foreground">
              Notes (optional)
            </span>
            <textarea
              value={form.notes ?? ""}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Anything the team should know — phase, special terms, contacts."
              className="mt-1 w-full min-h-[72px] rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="gold"
            onClick={() => create.mutate()}
            disabled={!canSubmit}
          >
            {create.isPending ? "Creating…" : "Create project"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setForm(EMPTY_FORM);
              setOpen(false);
            }}
            disabled={create.isPending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
