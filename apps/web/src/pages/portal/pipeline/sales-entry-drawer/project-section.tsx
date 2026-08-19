import { useQuery } from "@tanstack/react-query";
import { Field } from "@/components/form-ui";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { listPortalProjects } from "@/api/portal-sales";

export type ProjectInput =
  | { mode: "existing"; id: string }
  | { mode: "new"; name: string; developer: string; city?: string; expectedHandover?: string; notes?: string };

type Props = {
  value: ProjectInput;
  onChange: (next: ProjectInput) => void;
};

export function ProjectSection({ value, onChange }: Props) {
  const { data: projectsData } = useQuery({
    queryKey: ["portal-projects"],
    queryFn: () => listPortalProjects(),
  });
  const projects = (projectsData?.data ?? []) as Array<{ id: string; name: string; developer: string; status: string }>;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Project + Unit
      </h3>
      <Segmented
        value={value.mode}
        onChange={(mode) => {
          if (mode === "existing") onChange({ mode: "existing", id: "" });
          else onChange({ mode: "new", name: "", developer: "" });
        }}
        options={[
          { value: "existing", label: "Existing Project" },
          { value: "new", label: "+ New Project" },
        ]}
        ariaLabel="Project mode"
      />
      {value.mode === "existing" ? (
        <Field label="Project">
          <select
            value={value.id}
            onChange={(e) => onChange({ mode: "existing", id: e.target.value })}
            className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="">Select a project…</option>
            {projects.filter((p) => p.status === "active").map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.developer}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Unverified projects are not selectable. Wait for admin approval, or use "+ New Project".
          </p>
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project name">
            <Input
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="e.g. The Quartz Residence"
            />
          </Field>
          <Field label="Developer">
            <Input
              value={value.developer}
              onChange={(e) => onChange({ ...value, developer: e.target.value })}
              placeholder="e.g. Sunway Property"
            />
          </Field>
          <Field label="City (optional)">
            <Input
              value={value.city ?? ""}
              onChange={(e) => onChange({ ...value, city: e.target.value })}
            />
          </Field>
          <Field label="Expected handover (optional)">
            <Input
              type="date"
              value={value.expectedHandover ?? ""}
              onChange={(e) => onChange({ ...value, expectedHandover: e.target.value })}
            />
          </Field>
          <Field label="Notes (optional)">
            <Input
              value={value.notes ?? ""}
              onChange={(e) => onChange({ ...value, notes: e.target.value })}
            />
          </Field>
        </div>
      )}
    </section>
  );
}
