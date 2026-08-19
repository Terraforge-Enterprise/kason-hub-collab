import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput, SelectInput } from "@/components/form-ui";
import { apiFetch } from "@/lib/api-client";
import { useCreateUser, useUpdateUser, useSetPartyUpline } from "@/api/users";
import type { OperatorUser, CreateUserInput, UpdateUserInput } from "@/api/users";

export type AdminFormMode = "create" | "edit";

type Props = {
  open: boolean;
  mode: AdminFormMode;
  user: OperatorUser | null;
  onClose: () => void;
  forcedRole?: "manager" | "editor" | "viewer";
  availableRoles?: ("manager" | "editor" | "viewer")[];
};

type FormState = {
  fullName: string;
  email: string;
  role: "manager" | "editor" | "viewer";
  password: string;
  showPassword: boolean;
  uplineId: string | null;
  uplineDisplayName: string;
};

// Slim shape from /parties/assignable — must match the agent-form-drawer's
// SlimAgent so the picker stays consistent across the two surfaces.
type SlimUpline = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  partyType: string | null;
  status: string;
};

const UPLINE_SUBLABEL: Record<string, string> = {
  leader: "Leader",
  pre_leader: "Pre Leader",
  new_agent: "New Agent",
};

function uplineSubLabel(row: SlimUpline): string {
  if (row.partyType === "agent") {
    return row.agentLevel ? (UPLINE_SUBLABEL[row.agentLevel] ?? row.agentLevel) : "agent";
  }
  return "staff";
}

function useDebounced<T>(value: T, ms: number): T {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return dv;
}

// Inline typeahead — separate from the AgentTypeahead in agent-form-drawer
// to keep that file's import surface stable. Same endpoint, same shape.
function UplineTypeahead({
  value,
  displayName,
  excludeId,
  onSelect,
  onClear,
}: {
  value: string | null;
  displayName: string;
  excludeId?: string;
  onSelect: (id: string, name: string) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState(displayName);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q, 300);
  const results = useQuery({
    queryKey: ["upline-typeahead", dq],
    queryFn: () =>
      apiFetch<{ data: SlimUpline[] }>(
        `/parties/assignable?q=${encodeURIComponent(dq)}&partyType=agent,individual&take=20`,
      ),
    enabled: dq.length >= 2,
    staleTime: 30_000,
  });
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  const options = (results.data?.data ?? []).filter((a) => a.id !== excludeId);
  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value ? displayName : q}
          readOnly={!!value}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!value) setOpen(true);
          }}
          placeholder="Search by name…"
          className="h-9 w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onClear();
            }}
            className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Clear
          </button>
        )}
      </div>
      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] shadow-lg py-1">
          {options.map((o) => (
            <li
              key={o.id}
              onMouseDown={() => {
                onSelect(o.id, o.displayName);
                setQ(o.displayName);
                setOpen(false);
              }}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-[var(--muted)] text-[var(--text-primary)]"
            >
              <div className="font-medium">{o.displayName}</div>
              <div className="text-xs text-[var(--text-muted)] capitalize">{uplineSubLabel(o)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type FormErrors = Partial<Record<keyof Omit<FormState, "showPassword">, string>>;

const ALL_ROLE_OPTIONS: { value: "manager" | "editor" | "viewer"; label: string }[] = [
  { value: "manager", label: "Manager" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
];

function blankForm(forcedRole?: "manager" | "editor" | "viewer"): FormState {
  return {
    fullName: "",
    email: "",
    role: forcedRole ?? "editor",
    password: "",
    showPassword: false,
    uplineId: null,
    uplineDisplayName: "",
  };
}

export function AdminFormDrawer({ open, mode, user, onClose, forcedRole, availableRoles }: Props) {
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const setUpline = useSetPartyUpline();

  const effectiveRoleOptions = availableRoles?.length
    ? ALL_ROLE_OPTIONS.filter((o) => availableRoles!.includes(o.value))
    : ALL_ROLE_OPTIONS;
  const isForcedRole = !!forcedRole;

  const [form, setForm] = useState<FormState>(() => blankForm(forcedRole));
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (open) {
      if (mode === "edit" && user) {
        const editRole = forcedRole ?? ((user.role === "admin" ? "editor" : (user.role as "manager" | "editor" | "viewer")));
        // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
        setForm({
          fullName: user.fullName,
          email: user.email,
          role: editRole,
          password: "",
          showPassword: false,
          uplineId: user.party?.uplineId ?? null,
          uplineDisplayName: user.party?.upline?.displayName ?? "",
        });
      } else {
        setForm(blankForm(forcedRole));
      }
      setErrors({});
    }
  }, [open, mode, user?.id, forcedRole]);

  function set<K extends keyof FormState>(field: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value as FormState[K];
      setForm((prev) => ({ ...prev, [field]: value }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field as keyof FormErrors];
        return next;
      });
    };
  }

  const isPending = createUser.isPending || updateUser.isPending;

  function handleSubmit() {
    const errs: FormErrors = {};
    if (!form.fullName.trim()) errs.fullName = "Full name is required.";
    if (mode === "create") {
      if (!form.email.trim()) errs.email = "Email is required.";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = "Invalid email address.";
      if (!form.password) errs.password = "Password is required.";
      else if (form.password.length < 6) errs.password = "Password must be at least 6 characters.";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (mode === "create") {
      const input: CreateUserInput = {
        fullName: form.fullName.trim(),
        email: form.email.trim().toLowerCase(),
        role: form.role,
        password: form.password,
      };
      createUser.mutate(input, { onSuccess: onClose });
    } else if (user) {
      const input: UpdateUserInput & { id: string } = {
        id: user.id,
        fullName: form.fullName.trim(),
        role: form.role,
      };
      // Detect upline change against the snapshot, then fire BOTH mutations.
      // The upline call goes to /parties/:partyId/upline (the User PATCH
      // doesn't accept uplineId by design — it's a Party concern).
      const originalUplineId = user.party?.uplineId ?? null;
      const uplineChanged = form.uplineId !== originalUplineId;
      updateUser.mutate(input, {
        onSuccess: () => {
          if (uplineChanged && user.partyId) {
            setUpline.mutate(
              { partyId: user.partyId, uplineId: form.uplineId },
              { onSuccess: onClose, onError: onClose },
            );
          } else {
            onClose();
          }
        },
      });
    }
  }

  const title = mode === "create" ? "Add admin user" : "Edit admin user";
  const description =
    mode === "create"
      ? "Create a new operator user account."
      : `Edit ${user?.fullName ?? "user"}'s details.`;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title={title}
      description={description}
      onSubmit={handleSubmit}
      submit={{
        label: mode === "create" ? "Create user" : "Save changes",
        pendingLabel: mode === "create" ? "Creating…" : "Saving…",
        variant: "gold",
        pending: isPending,
      }}
    >
      <div className="grid gap-4">
        <Field label="Full name">
          <TextInput
            value={form.fullName}
            onChange={set("fullName")}
            placeholder="e.g. Jane Smith"
            required
            autoFocus={mode === "create"}
          />
          {errors.fullName && <p className="mt-1 text-xs text-rose-500">{errors.fullName}</p>}
        </Field>

        {mode === "create" && (
          <Field label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="user@example.com"
              required
            />
            {errors.email && <p className="mt-1 text-xs text-rose-500">{errors.email}</p>}
          </Field>
        )}

        <Field label="Role">
          {isForcedRole ? (
            <div className="rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm font-medium">
              {ALL_ROLE_OPTIONS.find((o) => o.value === forcedRole)?.label}
            </div>
          ) : (
            <SelectInput value={form.role} onChange={set("role")}>
              {effectiveRoleOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          )}
          {errors.role && <p className="mt-1 text-xs text-rose-500">{errors.role}</p>}
        </Field>

        {mode === "edit" && user?.partyId && (
          <Field label="Upline" hint="Who this user reports to in the org chart. Pick any agent or staff member.">
            <UplineTypeahead
              value={form.uplineId}
              displayName={form.uplineDisplayName}
              excludeId={user.partyId}
              onSelect={(id, name) =>
                setForm((prev) => ({ ...prev, uplineId: id, uplineDisplayName: name }))
              }
              onClear={() => setForm((prev) => ({ ...prev, uplineId: null, uplineDisplayName: "" }))}
            />
          </Field>
        )}

        {mode === "create" && (
          <>
            <Callout variant="info">
              This is a temporary password. The user will be required to change it on first login.
            </Callout>

            <Field label="Temporary password">
              <div className="relative">
                <TextInput
                  type={form.showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={set("password")}
                  placeholder="Minimum 6 characters"
                  required
                  className="pr-24"
                />
                <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                    onClick={() => setForm((prev) => ({ ...prev, showPassword: !prev.showPassword }))}
                  >
                    {form.showPassword ? "Hide" : "Show"}
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                    onClick={() => {
                      if (form.password) {
                        void navigator.clipboard.writeText(form.password);
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
              {errors.password && <p className="mt-1 text-xs text-rose-500">{errors.password}</p>}
            </Field>
          </>
        )}
      </div>
    </FormDrawer>
  );
}
