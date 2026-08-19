import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist all mock fns so vi.mock factories can reference them ────────────────
const { mockFindUnique, mockUpdate, mockDeleteObjectsBestEffort } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDeleteObjectsBestEffort: vi.fn(),
}));

// ── Mock @kason/db ────────────────────────────────────────────────────────────
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => ({
    party: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  })),
}));

// ── Mock lib/storage ──────────────────────────────────────────────────────────
vi.mock("../../../../lib/storage", () => ({
  deleteObjectsBestEffort: mockDeleteObjectsBestEffort,
  createSignedDownloadUrl: vi.fn(),
  createSignedUploadUrl: vi.fn(),
}));

// Import AFTER mocks are wired
import { updateMyPortalProfile } from "../portal.profile.repository";

const SESSION = { partyId: "p1", orgId: "org-1", userId: "u1" };
const PREFIX = `avatars/parties/${SESSION.partyId}/`;

describe("updateMyPortalProfile — avatar orphan cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
  });

  // ─── 1. replace ─────────────────────────────────────────────────────────────
  it("calls deleteObjectsBestEffort with the old key when replacing photo", async () => {
    const oldKey = `${PREFIX}old.jpg`;
    const newKey = `${PREFIX}new.jpg`;

    mockFindUnique.mockResolvedValueOnce({ photoKey: oldKey });

    const result = await updateMyPortalProfile(SESSION, { photoKey: newKey });

    expect(result).toEqual({ ok: true });
    expect(mockFindUnique).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledWith([oldKey]);
  });

  // ─── 2. clear ───────────────────────────────────────────────────────────────
  it("calls deleteObjectsBestEffort with the old key when clearing photo (null)", async () => {
    const oldKey = `${PREFIX}existing.jpg`;

    mockFindUnique.mockResolvedValueOnce({ photoKey: oldKey });

    const result = await updateMyPortalProfile(SESSION, { photoKey: null });

    expect(result).toEqual({ ok: true });
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).toHaveBeenCalledWith([oldKey]);
  });

  // ─── 3. photo unchanged (undefined) ─────────────────────────────────────────
  it("does NOT call deleteObjectsBestEffort or findUnique when photoKey is undefined", async () => {
    const result = await updateMyPortalProfile(SESSION, { fullName: "New Name" });

    expect(result).toEqual({ ok: true });
    // findUnique should not be called at all — no photo work needed
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });

  // ─── 4. set with no prior photo ─────────────────────────────────────────────
  it("does NOT call deleteObjectsBestEffort when old photoKey is null (no prior photo)", async () => {
    const newKey = `${PREFIX}first.jpg`;

    mockFindUnique.mockResolvedValueOnce({ photoKey: null });

    const result = await updateMyPortalProfile(SESSION, { photoKey: newKey });

    expect(result).toEqual({ ok: true });
    expect(mockFindUnique).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });

  // ─── 5. same key ────────────────────────────────────────────────────────────
  it("does NOT call deleteObjectsBestEffort when new photoKey equals old photoKey", async () => {
    const sameKey = `${PREFIX}same.jpg`;

    mockFindUnique.mockResolvedValueOnce({ photoKey: sameKey });

    const result = await updateMyPortalProfile(SESSION, { photoKey: sameKey });

    expect(result).toEqual({ ok: true });
    expect(mockFindUnique).toHaveBeenCalledOnce();
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });

  // ─── ownership guard still enforced ─────────────────────────────────────────
  it("returns 403 if photoKey does not belong to caller's prefix", async () => {
    const result = await updateMyPortalProfile(SESSION, {
      photoKey: "avatars/parties/OTHER/evil.jpg",
    });

    expect(result).toEqual({ ok: false, status: 403, error: expect.any(String) });
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockDeleteObjectsBestEffort).not.toHaveBeenCalled();
  });
});
