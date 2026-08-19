import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Field, TextInput, SelectInput } from "@/components/form-ui";
import { PhoneInput } from "@/components/phone-input";
import { AGENT_LEVEL_OPTIONS } from "@/lib/commission-labels";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  INDIVIDUAL_ID_TYPES,
  MALAYSIAN_BANKS,
  NATIONALITIES,
  withExistingOption,
} from "@/lib/malaysia-refdata";
import { useAgentActions } from "./use-agent-actions";
import { useAgentDetail, type AgentDetail } from "./use-agent-detail";
import type { AgentListItem } from "./agents-table";

// ── Restructure-toast plumbing ─────────────────────────────────────────────
// Shape of a single restructure entry returned by PATCH /parties/agents/:id
// when an agent's level change caused an upline reassignment. Mirrors the
// API contract in docs/superpowers/specs/2026-05-24-agent-level-upline-auto-resolution-design.md.
type RestructureEntry = {
  agentId: string;
  agentName: string;
  oldUplineId: string | null;
  oldUplineName: string | null;
  oldUplineLevel: string | null;
  newUplineId: string | null;
  newUplineName: string | null;
  newUplineLevel: string | null;
};

const LEVEL_DISPLAY: Record<string, string> = {
  new_agent: "New Agent",
  pre_leader: "Pre Leader",
  leader: "Leader",
};

function formatLevel(level: string | null): string {
  if (level === null) return "staff";
  return LEVEL_DISPLAY[level] ?? level;
}

function formatRestructureToast(entries: RestructureEntry[]): string {
  if (entries.length === 1) {
    const e = entries[0]!;
    const oldUpline = e.oldUplineName ?? "previous upline";
    const newUpline = e.newUplineName ?? "no upline (root)";
    return `${e.agentName}: upline auto-changed from ${oldUpline} (${formatLevel(e.oldUplineLevel)}) to ${newUpline}${e.newUplineLevel === null ? " (staff)" : ""} because the previous upline was below the new rank.`;
  }
  return `Saved. ${entries.length} downlines auto-reassigned because their upline dropped below their rank. See the activity log on each agent for details.`;
}

// ── Inline debounce hook ───────────────────────────────────────────────────
function useDebounced<T>(value: T, ms: number): T {
  const [dv, setDv] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDv(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return dv;
}

// ── AgentTypeahead ─────────────────────────────────────────────────────────
// Picker scope = agents + staff individuals. The DB Party.uplineId column
// accepts any Party regardless of partyType, so staff (admins/managers/
// editors) are legitimate uplines for an agent — the typeahead must surface
// them too. Tenants and owners are excluded server-side via the partyType
// allow-list.
type SlimAgent = {
  id: string;
  displayName: string;
  agentLevel: string | null;
  partyType: string | null;
  status: string;
};

type AgentTypeaheadProps = {
  value: string | null;
  displayName: string;
  excludeId?: string;
  onSelect: (id: string, displayName: string) => void;
  onClear: () => void;
};

// Friendly sublabel for the typeahead row — surfaces "Leader / Pre Leader /
// New Agent" for agents and "staff" (or the partyType verbatim) for non-agents.
const LEVEL_SUBLABEL: Record<string, string> = {
  leader: "Leader",
  pre_leader: "Pre Leader",
  new_agent: "New Agent",
};
function typeaheadSubLabel(row: SlimAgent): string {
  if (row.partyType === "agent") {
    return row.agentLevel ? (LEVEL_SUBLABEL[row.agentLevel] ?? row.agentLevel) : "agent";
  }
  return "staff";
}

function AgentTypeahead({ value, displayName, excludeId, onSelect, onClear }: AgentTypeaheadProps) {
  const [q, setQ] = useState(displayName);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 300);

  const results = useQuery({
    queryKey: ["upline-typeahead", debouncedQ],
    queryFn: () =>
      apiFetch<{ data: SlimAgent[] }>(
        `/parties/assignable?q=${encodeURIComponent(debouncedQ)}&partyType=agent,individual&take=20`,
      ),
    enabled: debouncedQ.length >= 2,
    staleTime: 30_000,
  });

  const options = (results.data?.data ?? []).filter((a) => a.id !== excludeId);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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
          onFocus={() => { if (!value) setOpen(true); }}
          placeholder="Search agent by name…"
          className="h-9 w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
        />
        {value && (
          <button
            type="button"
            onClick={() => { setQ(""); onClear(); }}
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
              <div className="text-xs text-[var(--text-muted)] capitalize">{typeaheadSubLabel(o)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type AgentFormMode = "create" | "edit";

type Props = {
  open: boolean;
  mode: AgentFormMode;
  agent: AgentListItem | null;
  onClose: () => void;
  onResetPassword?: () => void;
};

type FormState = {
  displayName: string;
  legalName: string;
  primaryEmail: string;
  primaryPhone: string | null;
  idType: string;
  idNumber: string;
  nationality: string;
  agentLevel: string;
  bankName: string;
  bankAccountHolder: string;
  bankAccountNumber: string;
  uplineId: string | null;
  uplineDisplayName: string;
  /**
   * Optional E-Namecard job title (per spec §7.1). When non-empty on
   * create, the backend mints an approved AgentCardVersion in the same
   * transaction as the new Party. Edit mode does NOT expose this field —
   * the agent's card is managed via /portal/my-card and the admin
   * Card Approvals queue.
   */
  title: string;
};

const empty: FormState = {
  displayName: "",
  legalName: "",
  primaryEmail: "",
  primaryPhone: null,
  idType: "",
  idNumber: "",
  nationality: "",
  agentLevel: "",
  bankName: "",
  bankAccountHolder: "",
  bankAccountNumber: "",
  uplineId: null,
  uplineDisplayName: "",
  title: "",
};

function fromAgent(agent: AgentListItem): FormState {
  return {
    displayName: agent.displayName ?? "",
    legalName: agent.legalName ?? "",
    primaryEmail: agent.primaryEmail ?? "",
    primaryPhone: agent.primaryPhone ?? null,
    idType: agent.idType ?? "",
    idNumber: agent.idNumber ?? "",
    nationality: agent.nationality ?? "",
    agentLevel: agent.agentLevel ?? "",
    bankName: agent.bankName ?? "",
    bankAccountHolder: agent.bankAccountHolder ?? "",
    bankAccountNumber: agent.bankAccountNumber ?? "",
    uplineId: agent.uplineId ?? null,
    uplineDisplayName: agent.upline?.displayName ?? "",
    // `title` is a card-only field (not on Party). Edit mode hides this
    // input, so the form-state value stays "" and is never sent.
    title: "",
  };
}

/**
 * Hydrate the form from the full-detail response. The detail shape carries
 * `bank.{name,accountHolder,accountNumber}` (nested), unlike the list-row
 * which has the bank fields flat. This adapter exists so the drawer can
 * pre-fill identically regardless of which shape arrives first
 * (placeholder list-row vs real fetched detail).
 */
function fromAgentDetail(detail: AgentDetail): FormState {
  return {
    displayName: detail.displayName ?? "",
    legalName: detail.legalName ?? "",
    primaryEmail: detail.primaryEmail ?? "",
    primaryPhone: detail.primaryPhone ?? null,
    idType: detail.idType ?? "",
    idNumber: detail.idNumber ?? "",
    nationality: detail.nationality ?? "",
    agentLevel: detail.agentLevel ?? "",
    bankName: detail.bank?.name ?? "",
    bankAccountHolder: detail.bank?.accountHolder ?? "",
    bankAccountNumber: detail.bank?.accountNumber ?? "",
    uplineId: detail.uplineId ?? null,
    uplineDisplayName: detail.upline?.displayName ?? "",
    // `title` is a card-only field (not on Party). Edit mode hides this
    // input, so the form-state value stays "" and is never sent.
    title: "",
  };
}

export function AgentFormDrawer({ open, mode, agent, onClose, onResetPassword }: Props) {
  const { create, update } = useAgentActions();
  const [form, setForm] = useState<FormState>(empty);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  // Track which fields the user has actually edited. Building the PATCH
  // payload from ONLY this set — instead of the full form — keeps server
  // updates minimal AND prevents `field.trim() || undefined` from wiping
  // adjacent columns. The set is intentionally NOT cleared on 409: when
  // the server rejects with a stale-record conflict, the user's edits
  // remain intact in form state and dirtyFields, so they can resubmit
  // after refetch reconciles.
  const [dirtyFields, setDirtyFields] = useState<Set<keyof FormState>>(
    () => new Set(),
  );

  // Edit mode pulls the full agent record. The list-row shape is supplied
  // as `placeholderData` so the drawer paints instantly with whatever the
  // table already had; the network detail then overwrites with the full
  // bank + upline fields once it arrives. Without this, bank fields would
  // appear blank for a moment after open.
  const detailQuery = useAgentDetail(
    mode === "edit" ? agent?.id : undefined,
    agent ?? undefined,
  );
  const detailData = detailQuery.data;

  // Re-hydrate form when (a) drawer opens, (b) `agent` identity changes,
  // (c) the full detail finishes loading. Step (c) overwrites only the
  // fields the user has NOT edited — protecting in-flight typing from a
  // late-arriving fetch result. We treat the placeholder + final detail
  // as a single source of truth: whichever is freshest, copy it into the
  // form for non-dirty fields only.
  useEffect(() => {
    if (!open) return;
    if (mode === "create") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setForm(empty);
      setErrors({});
      setDirtyFields(new Set());
      return;
    }
    // Edit mode — rehydrate from server detail (preferred) or list row.
    const next = detailData
      ? fromAgentDetail(detailData)
      : agent
        ? fromAgent(agent)
        : empty;
    setForm((prev) => {
      // Preserve dirty fields from previous state — late-arriving detail
      // must NOT overwrite what the user has typed. Non-dirty fields take
      // the freshest server value.
      const merged: FormState = { ...next };
      for (const k of dirtyFields) {
        merged[k] = prev[k] as never;
      }
      return merged;
    });
    setErrors({});
    // dirtyFields intentionally omitted from deps — including it would
    // re-hydrate every keystroke. We only re-merge when the upstream data
    // changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, agent?.id, detailData]);

  function set(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      setDirtyFields((prev) => {
        if (prev.has(field)) return prev;
        const next = new Set(prev);
        next.add(field);
        return next;
      });
      setErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    };
  }

  // Direct-value setter used by controlled components like <PhoneInput> that
  // emit canonical values rather than synthetic events.
  function setValue<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirtyFields((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  const isPending = create.isPending || update.isPending;

  // Map a FormState value to the wire-format value:
  //   - string fields are trimmed
  //   - empty string is FORWARDED (not coerced to undefined) — the user
  //     explicitly cleared the field; the server's parties service maps
  //     `"" → null` for nullable columns, so intent reaches the database.
  //   - select fields (agentLevel, idType, etc.) are forwarded unchanged
  function wireValueFor(field: keyof FormState, value: FormState[keyof FormState]): unknown {
    if (field === "uplineId") return value;
    // primaryPhone is canonical (or null) — already normalized by <PhoneInput>.
    // Forward as-is so the server sees null when cleared, "60xxxxxxxxx" otherwise.
    if (field === "primaryPhone") return value;
    if (typeof value === "string") return value.trim();
    return value;
  }

  function buildEditPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const field of dirtyFields) {
      patch[field as string] = wireValueFor(field, form[field]);
    }
    // uplineDisplayName is a UI-only mirror; never send it.
    delete patch.uplineDisplayName;
    // Always send updatedAt for optimistic-lock conflict detection.
    if (detailData?.updatedAt) {
      patch.updatedAt = detailData.updatedAt;
    } else if (agent?.updatedAt) {
      patch.updatedAt = agent.updatedAt;
    }
    return patch;
  }

  function handleSubmit() {
    const errs: Partial<Record<keyof FormState, string>> = {};
    if (!form.displayName.trim()) errs.displayName = "Display name is required.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (mode === "create") {
      // Create still posts the whole form — no diff semantics for create.
      // `title` is forwarded as `undefined` when blank so the server
      // skips the E-Namecard creation path entirely (per spec §6.1 + §7.1
      // — empty/whitespace title means "agent will set their own title
      // later"; non-empty title means "mint an approved card now in the
      // same transaction"). Empty strings would force the card path with
      // an invalid title, so we MUST send undefined.
      const payload = {
        displayName: form.displayName.trim(),
        legalName: form.legalName.trim() || undefined,
        primaryEmail: form.primaryEmail.trim() || undefined,
        // primaryPhone is canonical or null (from <PhoneInput>). Send the
        // canonical string when present; omit (undefined) when null so the
        // create path doesn't write an explicit null on a brand-new record.
        primaryPhone: form.primaryPhone ?? undefined,
        idType: form.idType.trim() || undefined,
        idNumber: form.idNumber.trim() || undefined,
        nationality: form.nationality.trim() || undefined,
        agentLevel: form.agentLevel || undefined,
        bankName: form.bankName.trim() || undefined,
        bankAccountHolder: form.bankAccountHolder.trim() || undefined,
        bankAccountNumber: form.bankAccountNumber.trim() || undefined,
        title: form.title.trim() || undefined,
      };
      create.mutate(payload, {
        onSuccess: () => {
          setDirtyFields(new Set());
          onClose();
        },
        // Override the generic resource-mutations error toast for the
        // 409 "card settings not configured" case. The server returns
        // 409 with the message from OrgCardSettingsNotConfiguredError —
        // detected by status, since the routes layer only forwards
        // `{ error: message }` (no `code`). Drawer stays open so the
        // user can retry with a blank title or after configuring.
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            toast.error(
              "Card settings not configured. Visit Card Settings to set up brand + cert before creating cards. Agent NOT created — try again with a blank title or after configuring.",
            );
            return;
          }
          // Fall through to the resource-mutation factory's default
          // error toast (already wired via handleMutationError in
          // useAgentActions). Returning here without re-toasting would
          // suppress that — but the factory's onError fires regardless
          // because TanStack Query invokes BOTH callbacks. Don't toast
          // here for non-409 to avoid duplicate messages.
        },
      });
      return;
    }

    if (!agent) return;
    if (dirtyFields.size === 0) {
      // Nothing to save — close silently.
      onClose();
      return;
    }
    const patch = buildEditPatch();
    update.mutate(
      { id: agent.id, patch: patch as Partial<AgentListItem> },
      {
        onSuccess: (response) => {
          // Surface auto-restructures: when the server reassigned downlines
          // because this level change created a rank inversion, fire ONE
          // info toast on top of the generic "Saved" toast from the
          // resource-mutations factory. Operators need to notice the side
          // effect immediately — otherwise they'd be surprised when they
          // look at the org chart later. `restructured` is omitted by the
          // server when empty, so the optional-chain handles both shapes.
          const restructured = (
            response as { restructured?: RestructureEntry[] } | undefined
          )?.restructured;
          if (restructured && restructured.length > 0) {
            toast.info(formatRestructureToast(restructured));
          }
          // Successful save — clear dirty tracking so reopening the
          // drawer pulls fresh server values without "phantom edits".
          setDirtyFields(new Set());
          onClose();
        },
        // NOTE: no onError — dirtyFields and form state are deliberately
        // preserved so the user's typing survives a 409 rollback. The
        // mutation factory rolls back the React Query cache; the local
        // form state stays exactly as the user left it.
      },
    );
  }

  const title = mode === "create" ? "New agent" : "Edit agent";
  const description =
    mode === "create"
      ? "Capture the agent's profile. Required: display name."
      : "Update the agent's profile. Level changes are logged.";

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title={title}
      description={description}
      onSubmit={handleSubmit}
      submit={{
        label: mode === "create" ? "Create agent" : "Save changes",
        pendingLabel: mode === "create" ? "Creating…" : "Saving…",
        variant: "gold",
        pending: isPending,
      }}
    >
      <div className="grid gap-4">
        <Field label="Display name *">
          <TextInput
            value={form.displayName}
            onChange={set("displayName")}
            placeholder="Jane Realty"
          />
          {errors.displayName && (
            <p className="mt-1 text-xs text-rose-500">{errors.displayName}</p>
          )}
        </Field>

        <Field label="Legal name">
          <TextInput
            value={form.legalName}
            onChange={set("legalName")}
            placeholder="Jane Realty Sdn. Bhd."
          />
        </Field>

        <Field label="Email">
          <TextInput
            type="email"
            value={form.primaryEmail}
            onChange={set("primaryEmail")}
            placeholder="ops@janerealty.com"
          />
        </Field>

        <PhoneInput
          label="Phone"
          value={form.primaryPhone}
          onChange={(canonical) => setValue("primaryPhone", canonical)}
        />


        {mode === "create" && (
          <Field
            label="Job title (optional)"
            hint="Leave blank if the agent will set their own title later. If filled, an approved E-Namecard is generated immediately."
          >
            <TextInput
              value={form.title}
              onChange={set("title")}
              placeholder="Senior Negotiator"
            />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ID type">
            <SelectInput value={form.idType} onChange={set("idType")}>
              <option value="">Select ID type…</option>
              {withExistingOption(INDIVIDUAL_ID_TYPES, form.idType).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="ID number">
            <TextInput
              value={form.idNumber}
              onChange={set("idNumber")}
              placeholder="880101-01-1234"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nationality">
            <SelectInput value={form.nationality} onChange={set("nationality")}>
              <option value="">Select nationality…</option>
              {withExistingOption(NATIONALITIES, form.nationality).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Agent level" hint="Level changes are logged.">
            <SelectInput value={form.agentLevel} onChange={set("agentLevel")}>
              <option value="">Not set</option>
              {AGENT_LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {mode === "edit" && (
          <Field label="Upline" hint="Change is logged to activity log.">
            <AgentTypeahead
              value={form.uplineId}
              displayName={form.uplineDisplayName}
              excludeId={agent?.id}
              onSelect={(id, displayName) => {
                setForm((prev) => ({ ...prev, uplineId: id, uplineDisplayName: displayName }));
                setDirtyFields((prev) => {
                  const next = new Set(prev);
                  next.add("uplineId");
                  return next;
                });
              }}
              onClear={() => {
                setForm((prev) => ({ ...prev, uplineId: null, uplineDisplayName: "" }));
                setDirtyFields((prev) => {
                  const next = new Set(prev);
                  next.add("uplineId");
                  return next;
                });
              }}
            />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank name">
            <SelectInput value={form.bankName} onChange={set("bankName")}>
              <option value="">Select bank…</option>
              {withExistingOption(MALAYSIAN_BANKS, form.bankName).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Account holder">
            <TextInput
              value={form.bankAccountHolder}
              onChange={set("bankAccountHolder")}
            />
          </Field>
        </div>

        <Field label="Bank account number">
          <TextInput
            value={form.bankAccountNumber}
            onChange={set("bankAccountNumber")}
          />
        </Field>
      </div>

      {mode === "edit" && onResetPassword && (
        <div className="mt-4 border-t border-[var(--card-border)] pt-3">
          <button
            type="button"
            onClick={onResetPassword}
            className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] underline-offset-4 hover:underline"
          >
            Reset portal password →
          </button>
        </div>
      )}
    </FormDrawer>
  );
}
