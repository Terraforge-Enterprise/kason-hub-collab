import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — must be before static imports (Vitest hoists vi.mock() calls)
// ---------------------------------------------------------------------------

// Preserve real implementations for describeBlockers/isPartyDeletable;
// mock findRole, loadPartyDeletionShape, deletePartyTx for service-level tests.
vi.mock("../parties.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parties.repository")>();
  return {
    ...actual,
    listTenants: vi.fn(),
    listOwners: vi.fn(),
    findRole: vi.fn(),
    loadPartyDeletionShape: vi.fn(),
    deletePartyTx: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Static imports (resolved after vi.mock hoisting)
// ---------------------------------------------------------------------------

import { describeBlockers, isPartyDeletable, listTenants } from "../parties.repository";
import * as repo from "../parties.repository";
import { getTenantsService, deletePartyByRoleService } from "../parties.service";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const zero = {
  tenancies: 0, charges: 0, payments: 0, deposits: 0, bills: 0,
  landlordTenancies: 0, salesUnitsOwned: 0, invoicesAsBillTo: 0,
  invoicesAsOwner: 0, managementFeeConfigs: 0,
};

// ---------------------------------------------------------------------------
// Pure-helper tests (no DB — describeBlockers / isPartyDeletable)
// ---------------------------------------------------------------------------

describe("describeBlockers / isPartyDeletable", () => {
  it("clean record is deletable", () => {
    const shape = {
      displayName: "x", primaryEmail: null, primaryPhone: null,
      userAccount: null, _count: { ...zero },
    };
    expect(isPartyDeletable(shape)).toBe(true);
    expect(describeBlockers(shape)).toEqual([]);
  });

  it("payments + a portal login block, pluralised", () => {
    const shape = {
      displayName: "x", primaryEmail: null, primaryPhone: null,
      userAccount: { id: "u1" }, _count: { ...zero, payments: 2 },
    };
    expect(isPartyDeletable(shape)).toBe(false);
    expect(describeBlockers(shape)).toEqual(["2 payments", "a portal login"]);
  });
});

// ---------------------------------------------------------------------------
// Service-level: getTenantsService emits `deletable` per row
// ---------------------------------------------------------------------------

describe("getTenantsService deletable mapping", () => {
  const session = { orgId: "org1", userId: "u1", role: "admin" as const };

  const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: "p1",
    displayName: "Test",
    legalName: null,
    primaryEmail: null,
    primaryPhone: null,
    nationality: null,
    occupation: null,
    employerName: null,
    monthlyIncome: null,
    idType: null,
    idNumber: null,
    isBlacklisted: false,
    blacklistReason: null,
    status: "active",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    userAccount: null,
    _count: { ...zero },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps deletable:true for a clean row and does not leak _count or userAccount", async () => {
    vi.mocked(listTenants).mockResolvedValueOnce([makeRow()] as never);
    const result = await getTenantsService(session);
    expect(result[0].deletable).toBe(true);
    // _count and userAccount must NOT appear in the DTO
    expect(result[0]).not.toHaveProperty("_count");
    expect(result[0]).not.toHaveProperty("userAccount");
  });

  it("maps deletable:false when payments > 0", async () => {
    vi.mocked(listTenants).mockResolvedValueOnce([
      makeRow({
        _count: { ...zero, payments: 1 },
      }),
    ] as never);
    const result = await getTenantsService(session);
    expect(result[0].deletable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deletePartyByRoleService — hard-delete with zero-links guard
// ---------------------------------------------------------------------------

describe("deletePartyByRoleService", () => {
  const session = { orgId: "org1", userId: "u1", role: "manager" } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("409 when linked — deletePartyTx NOT called", async () => {
    vi.mocked(repo.findRole).mockResolvedValue({ id: "r1" } as any);
    vi.mocked(repo.loadPartyDeletionShape).mockResolvedValue({
      displayName: "x",
      primaryEmail: null,
      primaryPhone: null,
      userAccount: null,
      _count: { ...zero, tenancies: 1 },
    } as any);
    const res = await deletePartyByRoleService(session, "tenant", "p1");
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(repo.deletePartyTx).not.toHaveBeenCalled();
  });

  it("deletes a clean record — deletePartyTx called with correct args", async () => {
    vi.mocked(repo.findRole).mockResolvedValue({ id: "r1" } as any);
    vi.mocked(repo.loadPartyDeletionShape).mockResolvedValue({
      displayName: "x",
      primaryEmail: null,
      primaryPhone: null,
      userAccount: null,
      _count: { ...zero },
    } as any);
    vi.mocked(repo.deletePartyTx).mockResolvedValue(undefined as any);
    const res = await deletePartyByRoleService(session, "tenant", "p1");
    expect(res.ok).toBe(true);
    expect(repo.deletePartyTx).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1", partyId: "p1", role: "tenant", actorUserId: "u1" }),
    );
  });
});
