import { describe, it, expect } from "vitest";
import { assertTransition, canTransition, type ClaimStatus, type Actor } from "../claim-state-machine";
import { isClaimError } from "../claim-errors";

describe("claim state machine", () => {
  it("draft → submitted by agent_owner is allowed", () => {
    expect(canTransition("draft", "submitted", "agent_owner")).toBe(true);
  });

  it("submitted → approved by admin is allowed", () => {
    expect(canTransition("submitted", "approved", "admin")).toBe(true);
  });

  it("submitted → approved by agent_owner is FORBIDDEN", () => {
    expect(canTransition("submitted", "approved", "agent_owner")).toBe(false);
  });

  it("rejected → anything is FORBIDDEN — rejected is terminal for agents", () => {
    // Per project rule: agents cannot resubmit a rejected claim. They must
    // file a new one. See feedback_rejected_terminal_for_agents memory note.
    for (const to of ["submitted", "draft", "approved", "amended"] as ClaimStatus[]) {
      expect(canTransition("rejected", to, "agent_owner")).toBe(false);
    }
  });

  it("paid → anything is FORBIDDEN (terminal)", () => {
    for (const to of ["draft", "submitted", "approved", "rejected", "cancelled"] as ClaimStatus[]) {
      expect(canTransition("paid", to, "admin")).toBe(false);
    }
  });

  it("approved → submitted by admin (undo) is allowed", () => {
    expect(canTransition("approved", "submitted", "admin")).toBe(true);
  });

  it("approved → submitted by manager (undo) is FORBIDDEN (admin-only)", () => {
    expect(canTransition("approved", "submitted", "manager")).toBe(false);
  });

  it("assertTransition throws a ClaimError with code forbidden_transition", () => {
    expect.assertions(3);
    try {
      assertTransition("paid", "draft", "admin");
    } catch (err) {
      expect(isClaimError(err)).toBe(true);
      if (isClaimError(err)) {
        expect(err.code).toBe("forbidden_transition");
        expect((err.data as { from: string; to: string }).from).toBe("paid");
      }
    }
  });

  it("assertTransition returns undefined on success", () => {
    expect(assertTransition("draft", "submitted", "agent_owner")).toBeUndefined();
  });

  it("same-state transitions: draft → draft by owner allowed (PATCH/edit)", () => {
    expect(canTransition("draft", "draft", "agent_owner")).toBe(true);
  });

  it("approved → amended by agent_owner is allowed (agent edits approved claim)", () => {
    expect(canTransition("approved", "amended", "agent_owner")).toBe(true);
  });

  it("approved → amended by admin / manager / editor is FORBIDDEN", () => {
    expect(canTransition("approved", "amended", "admin")).toBe(false);
    expect(canTransition("approved", "amended", "manager")).toBe(false);
    expect(canTransition("approved", "amended", "editor")).toBe(false);
  });

  it("amended → approved by admin is allowed (re-approval)", () => {
    expect(canTransition("amended", "approved", "admin")).toBe(true);
  });

  it("amended → approved by manager is allowed (re-approval)", () => {
    expect(canTransition("amended", "approved", "manager")).toBe(true);
  });

  it("amended → approved by editor is FORBIDDEN", () => {
    expect(canTransition("amended", "approved", "editor")).toBe(false);
  });

  it("amended → approved by agent_owner is FORBIDDEN", () => {
    expect(canTransition("amended", "approved", "agent_owner")).toBe(false);
  });

  it("submitted → amended is FORBIDDEN for all actors", () => {
    for (const actor of ["agent_owner", "admin", "manager", "editor"] as Actor[]) {
      expect(canTransition("submitted", "amended", actor)).toBe(false);
    }
  });

  it("paid → amended is FORBIDDEN for all actors (paid is terminal)", () => {
    for (const actor of ["agent_owner", "admin", "manager", "editor"] as Actor[]) {
      expect(canTransition("paid", "amended", actor)).toBe(false);
    }
  });

  it("amended → amended by agent_owner is allowed (further edits before re-approval)", () => {
    expect(canTransition("amended", "amended", "agent_owner")).toBe(true);
  });

  // ── Pre-approval self-edit (submitted → submitted) ───────────────────────

  it("submitted → submitted by agent_owner is allowed (pre-approval edit)", () => {
    expect(canTransition("submitted", "submitted", "agent_owner")).toBe(true);
  });

  it("submitted → submitted by admin is FORBIDDEN", () => {
    expect(canTransition("submitted", "submitted", "admin")).toBe(false);
  });

  it("submitted → submitted by manager is FORBIDDEN", () => {
    expect(canTransition("submitted", "submitted", "manager")).toBe(false);
  });

  it("submitted → submitted by editor is FORBIDDEN", () => {
    expect(canTransition("submitted", "submitted", "editor")).toBe(false);
  });
});

describe("needs_amendment transitions (admin-initiated send-back)", () => {
  it("allows manager + admin to transition submitted → needs_amendment", () => {
    expect(canTransition("submitted", "needs_amendment", "manager")).toBe(true);
    expect(canTransition("submitted", "needs_amendment", "admin")).toBe(true);
  });

  it("allows manager + admin to transition approved → needs_amendment", () => {
    expect(canTransition("approved", "needs_amendment", "manager")).toBe(true);
    expect(canTransition("approved", "needs_amendment", "admin")).toBe(true);
  });

  it("allows manager + admin to transition amended → needs_amendment", () => {
    expect(canTransition("amended", "needs_amendment", "manager")).toBe(true);
    expect(canTransition("amended", "needs_amendment", "admin")).toBe(true);
  });

  it("forbids editor from transitioning to needs_amendment", () => {
    expect(canTransition("submitted", "needs_amendment", "editor")).toBe(false);
    expect(canTransition("approved", "needs_amendment", "editor")).toBe(false);
    expect(canTransition("amended", "needs_amendment", "editor")).toBe(false);
  });

  it("forbids agent_owner from transitioning to needs_amendment (admin-only action)", () => {
    expect(canTransition("submitted", "needs_amendment", "agent_owner")).toBe(false);
    expect(canTransition("approved", "needs_amendment", "agent_owner")).toBe(false);
    expect(canTransition("amended", "needs_amendment", "agent_owner")).toBe(false);
  });

  it("forbids transition into needs_amendment from terminal / non-eligible states", () => {
    // Note: needs_amendment → needs_amendment by agent_owner IS allowed (the
    // PATCH/edit pattern, mirroring draft → draft and submitted → submitted).
    // That case is covered by the "agent re-work" describe block below.
    for (const from of ["draft", "rejected", "paid", "cancelled", "deleted"] as ClaimStatus[]) {
      for (const actor of ["agent_owner", "admin", "manager", "editor"] as Actor[]) {
        expect(canTransition(from, "needs_amendment", actor)).toBe(false);
      }
    }
  });
});

describe("needs_amendment transitions (agent re-work)", () => {
  it("allows agent_owner to edit (needs_amendment → needs_amendment)", () => {
    expect(canTransition("needs_amendment", "needs_amendment", "agent_owner")).toBe(true);
  });

  it("allows agent_owner to resubmit (needs_amendment → submitted)", () => {
    expect(canTransition("needs_amendment", "submitted", "agent_owner")).toBe(true);
  });

  it("allows agent_owner to withdraw (needs_amendment → cancelled)", () => {
    expect(canTransition("needs_amendment", "cancelled", "agent_owner")).toBe(true);
  });

  it("forbids admin / manager / editor from agent-side transitions out of needs_amendment", () => {
    for (const actor of ["admin", "manager", "editor"] as Actor[]) {
      expect(canTransition("needs_amendment", "needs_amendment", actor)).toBe(false);
      expect(canTransition("needs_amendment", "submitted", actor)).toBe(false);
      expect(canTransition("needs_amendment", "cancelled", actor)).toBe(false);
    }
  });

  it("forbids needs_amendment → terminal-other-than-cancelled by agent (must resubmit first)", () => {
    expect(canTransition("needs_amendment", "rejected", "agent_owner")).toBe(false);
    expect(canTransition("needs_amendment", "approved", "agent_owner")).toBe(false);
    expect(canTransition("needs_amendment", "paid", "agent_owner")).toBe(false);
    expect(canTransition("needs_amendment", "amended", "agent_owner")).toBe(false);
  });
});
