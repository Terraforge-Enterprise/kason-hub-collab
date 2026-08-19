import { describe, it, expect, beforeEach, vi } from "vitest";

const repo = {
  searchOwnersForAgent: vi.fn(),
  findOwnerByIdForAgent: vi.fn(),
  createOwner: vi.fn(),
};

vi.mock("../portal.parties.repository", () => ({
  portalPartiesRepository: () => repo,
}));

import { searchOwnersService, createOwnerService } from "../portal.parties.service";

const baseCtx = { orgId: "org-1", agentPartyId: "agent-1", actorUserId: "user-1" };

beforeEach(() => Object.values(repo).forEach((fn: any) => fn.mockReset()));

describe("searchOwnersService", () => {
  it("returns owners scoped to the calling agent's prior submissions", async () => {
    repo.searchOwnersForAgent.mockResolvedValue([
      { id: "o1", displayName: "John Tan", primaryPhone: "+60123", primaryEmail: "j@t.com" },
    ]);
    const result = await searchOwnersService({ q: "John" }, baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
    expect(repo.searchOwnersForAgent).toHaveBeenCalledWith("org-1", "agent-1", "John");
  });

  it("returns empty list when q is empty", async () => {
    const result = await searchOwnersService({ q: "" }, baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(0);
    expect(repo.searchOwnersForAgent).not.toHaveBeenCalled();
  });

  it("trims q before searching", async () => {
    repo.searchOwnersForAgent.mockResolvedValue([]);
    await searchOwnersService({ q: "  Jane  " }, baseCtx);
    expect(repo.searchOwnersForAgent).toHaveBeenCalledWith("org-1", "agent-1", "Jane");
  });
});

describe("createOwnerService", () => {
  it("creates a new owner Party in this org", async () => {
    // Use canonical Malaysian mobile format ("60XXXXXXXXX") — Chunk D added a
    // defensive `optionalPhoneSchema.parse()` at the service layer which
    // rejects non-canonical input. Routes always pre-canonicalize, so the
    // test mirrors the real wire format reaching the service.
    repo.createOwner.mockResolvedValue({
      id: "new-o", displayName: "Jane Lee", primaryPhone: "60123456789", primaryEmail: "jane@l.com",
    });
    const result = await createOwnerService(
      { displayName: "Jane Lee", primaryPhone: "60123456789", primaryEmail: "jane@l.com" },
      baseCtx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("new-o");
    expect(repo.createOwner).toHaveBeenCalledWith({
      orgId: "org-1",
      displayName: "Jane Lee",
      primaryPhone: "60123456789",
      primaryEmail: "jane@l.com",
      partyType: "owner",
    });
  });

  it("rejects empty displayName", async () => {
    const result = await createOwnerService(
      { displayName: " ", primaryPhone: "+60124" },
      baseCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_display_name");
  });

  it("forwards null phone (schema-normalized empty) as undefined to repo", async () => {
    repo.createOwner.mockResolvedValue({ id: "x", displayName: "X", primaryPhone: null, primaryEmail: null });
    // After Task 7 wired optionalPhoneSchema into createOwnerSchema, empty
    // input is normalized to `null` BEFORE reaching the service. The
    // service then forwards `null` as `undefined` so Prisma omits the
    // column. Email still receives raw "  " from this direct service
    // call (no schema run); the service trims it to undefined.
    await createOwnerService(
      { displayName: "X", primaryPhone: null, primaryEmail: "  " },
      baseCtx,
    );
    const call = repo.createOwner.mock.calls[0][0];
    expect(call.primaryPhone).toBeUndefined();
    expect(call.primaryEmail).toBeUndefined();
  });
});
