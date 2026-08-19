import { beforeEach, describe, expect, it, vi } from "vitest";
const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));
vi.mock("@kason/db", () => ({ getDb: () => ({ party: { findFirst: mockFindFirst } }) }));
vi.mock("../parties.repository", () => ({ findRole: vi.fn(), updateParty: vi.fn() }));
import * as repo from "../parties.repository";
import { reactivateTenantService, setPartyStatusService } from "../parties.service";

const session = { orgId: "org1", userId: "u1", role: "manager" } as any;
beforeEach(() => { vi.mocked(repo.findRole).mockReset(); vi.mocked(repo.updateParty).mockReset(); mockFindFirst.mockReset(); });

describe("setPartyStatusService", () => {
  it("rejects when blacklisted", async () => {
    vi.mocked(repo.findRole).mockResolvedValue({ id: "r1" } as any);
    mockFindFirst.mockResolvedValue({ isBlacklisted: true });
    const res = await setPartyStatusService(session, "tenant", { partyId: "p1", status: "inactive" });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(repo.updateParty).not.toHaveBeenCalled();
  });
  it("sets status when not blacklisted", async () => {
    vi.mocked(repo.findRole).mockResolvedValue({ id: "r1" } as any);
    mockFindFirst.mockResolvedValue({ isBlacklisted: false });
    const res = await setPartyStatusService(session, "tenant", { partyId: "p1", status: "inactive" });
    expect(res.ok).toBe(true);
    expect(repo.updateParty).toHaveBeenCalledWith("p1", { status: "inactive" });
  });
});

describe("reactivateTenantService status choice", () => {
  it("resolves blacklist to inactive when status='inactive'", async () => {
    vi.mocked(repo.findRole).mockResolvedValue({ id: "r1" } as any);
    const res = await reactivateTenantService(session, { partyId: "p1", status: "inactive" } as any);
    expect(res.ok).toBe(true);
    expect(repo.updateParty).toHaveBeenCalledWith("p1", { isBlacklisted: false, blacklistReason: null, status: "inactive" });
  });
  it("defaults to active", async () => {
    vi.mocked(repo.findRole).mockResolvedValue({ id: "r1" } as any);
    await reactivateTenantService(session, { partyId: "p1" } as any);
    expect(repo.updateParty).toHaveBeenCalledWith("p1", { isBlacklisted: false, blacklistReason: null, status: "active" });
  });
});
