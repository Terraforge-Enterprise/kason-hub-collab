import { ClaimError } from "./claim-errors";

export type ClaimStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "amended"
  | "needs_amendment"
  | "rejected"
  | "paid"
  | "cancelled"
  | "deleted";

export type Actor = "agent_owner" | "admin" | "manager" | "editor";

// Rows = FROM state, columns = TO state, value = actors allowed.
// Missing entries = forbidden.
const TRANSITIONS: Record<ClaimStatus, Partial<Record<ClaimStatus, readonly Actor[]>>> = {
  draft: {
    draft: ["agent_owner"],          // PATCH / edit
    submitted: ["agent_owner"],      // submit
    deleted: ["agent_owner"],        // delete draft
  },
  submitted: {
    submitted: ["agent_owner"],         // pre-approval edit (status preserved)
    approved: ["admin", "manager"],
    rejected: ["admin", "manager"],
    cancelled: ["agent_owner"],
    needs_amendment: ["admin", "manager"],  // admin sends back for amendment
  },
  rejected: {},   // terminal for agents — no resubmit, no edit. Admin must
                  // file a new claim if the agent needs a do-over.
  approved: {
    amended: ["agent_owner"],            // agent edits approved claim → enters amended
    paid: ["admin", "manager"],
    submitted: ["admin"],                // admin-only undo
    needs_amendment: ["admin", "manager"],  // admin sends back; Bill reversed in service
  },
  amended: {
    approved: ["admin", "manager"],      // re-approval after amendments
    amended: ["agent_owner"],            // further edits before re-approval
    needs_amendment: ["admin", "manager"],  // admin sends back; Bill reversed in service
  },
  needs_amendment: {
    needs_amendment: ["agent_owner"],    // PATCH / edit during re-work
    submitted:       ["agent_owner"],    // resubmit
    cancelled:       ["agent_owner"],    // withdraw
  },
  paid: {},       // terminal
  cancelled: {},  // terminal
  deleted: {},    // terminal
} as const;

export function canTransition(from: ClaimStatus, to: ClaimStatus, actor: Actor): boolean {
  const allowed = TRANSITIONS[from]?.[to];
  if (!allowed) return false;
  return allowed.includes(actor);
}

export function assertTransition(from: ClaimStatus, to: ClaimStatus, actor: Actor): void {
  if (!canTransition(from, to, actor)) {
    throw new ClaimError("forbidden_transition", {
      message: `Transition ${from} → ${to} not allowed for ${actor}.`,
      from,
      to,
    });
  }
}
