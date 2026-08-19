// Portal-side agent picker for claim splits. Backed by
// /portal-api/team/splittable, which returns the caller's upline chain +
// self + direct downlines (the people they can realistically share a
// commission with).
//
// Behaviour: typeahead-with-fallback. The user types a name. If a row
// matches and they pick it, both `partyPartyId` and `partyDisplayName`
// are sent. If they type a name that doesn't match (external collaborator
// they don't see in their team graph), we keep the free-text and submit
// `partyPartyId: null` so the form still works — `partyDisplayName` is
// always required, the FK is optional. This matches the schema today.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";

export type PortalSplittableAgent = {
  id: string;
  displayName: string;
  agentLevel: string | null;
};

export function usePortalSplittableAgents() {
  return useQuery({
    queryKey: ["portal-splittable-agents"],
    queryFn: async () => {
      const res = await portalApiFetch<{ data: PortalSplittableAgent[] }>(
        "/team/splittable",
      );
      return res.data;
    },
    staleTime: 60_000,
  });
}

interface PortalAgentPickerProps {
  // FK to a Party row when the user picked one from the typeahead, null
  // when they free-typed a name that isn't in their reachable team.
  partyPartyId: string | null;
  // Always required — survives even when partyPartyId is null. Display
  // names are also a snapshot, so renames don't rewrite history.
  displayName: string;
  onChange: (next: { partyPartyId: string | null; displayName: string }) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function PortalAgentPicker({
  partyPartyId,
  displayName,
  onChange,
  placeholder = "Search team or type a name…",
  disabled,
  className,
}: PortalAgentPickerProps) {
  const { data: agents } = usePortalSplittableAgents();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = displayName.trim().toLowerCase();
    const list = agents ?? [];
    if (!q) return list.slice(0, 10);
    return list
      .filter((a) => a.displayName.toLowerCase().includes(q))
      .slice(0, 10);
  }, [agents, displayName]);

  // Close dropdown on outside click — same pattern as AgentSelect /
  // AgentMultiSelect in the admin inventory module.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const onPickAgent = (a: PortalSplittableAgent) => {
    onChange({ partyPartyId: a.id, displayName: a.displayName });
    setOpen(false);
  };

  const onTextChange = (value: string) => {
    // User is typing — if their text no longer matches the previously
    // picked party's name, drop the FK so we don't ship a stale link.
    const stillMatches =
      partyPartyId &&
      agents?.some(
        (a) => a.id === partyPartyId && a.displayName === value,
      );
    onChange({
      partyPartyId: stillMatches ? partyPartyId : null,
      displayName: value,
    });
    setOpen(true);
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <input
        type="text"
        value={displayName}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onTextChange(e.target.value)}
        onFocus={() => setOpen(true)}
        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {partyPartyId ? (
        <span
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-emerald-600"
          title="Linked to a Party record"
        >
          LINKED
        </span>
      ) : null}
      {open && matches.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover py-1 shadow-lg">
          {matches.map((a) => (
            <li
              key={a.id}
              onMouseDown={() => onPickAgent(a)}
              className="cursor-pointer px-3 py-1.5 text-sm hover:bg-accent"
            >
              <div className="font-medium">{a.displayName}</div>
              {a.agentLevel ? (
                <div className="text-xs text-muted-foreground">
                  {a.agentLevel}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
