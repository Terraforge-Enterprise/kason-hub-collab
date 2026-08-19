import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blacklistAgentService,
  createOwnerService,
  createTenantService,
  updateOwnerService,
  updateTenantService,
  updateAgentService,
  reactivateAgentService,
  reactivateTenantService,
  reactivateOwnerService,
  getAgentDetailService,
  revokePortalAccessService,
  setUplineService,
  listAssignableMembersService,
  coerceEmptyStringsToNull,
  createPortalAccessService,
  getAgentsService,
  getOwnersService,
  getTenantsService,
  getOwnerDetailService,
  getTenantDetailService,
} from "../parties.service";
import * as repo from "../parties.repository";
import { StaleUpdateError, NotFoundError, InvalidStateError } from "../../../lib/concurrency-error";
import { createOwnerSchema, createTenantSchema, updateOwnerSchema, updateTenantSchema, updateAgentSchema } from "@kason/shared";

// ── Mock storage ─────────────────────────────────────────────────────────────
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(),
}));
import { createSignedDownloadUrl } from "../../../lib/storage";

// party.create/update, partyRole.create, and $transaction are used ONLY by
// the "tenant/owner field-parity persistence" describe block below, which
// bypasses the parties.repository mock (via vi.importActual) to exercise the
// REAL createOwner/createTenant/updateParty write-arms. Every other test in
// this file only ever touches party.findFirst / partyRole.findFirst /
// user.findFirst / user.create through the fully-mocked repository, so
// adding these keys does not change behaviour for the other ~180 tests.
const mockDb = {
  party: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  partyRole: { findFirst: vi.fn(), create: vi.fn() },
  user: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb)),
};

vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock("../../../lib/auth", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));

vi.mock("../parties.repository", () => ({
  listOwners: vi.fn(),
  listTenants: vi.fn(),
  findRole: vi.fn(),
  findPartyByIdNumber: vi.fn(),
  createOwner: vi.fn(),
  createTenant: vi.fn(),
  updateParty: vi.fn(),
  listAgents: vi.fn(),
  listAssignableMembers: vi.fn(),
  createAgent: vi.fn(),
  blacklistAgentTx: vi.fn(),
  reactivateAgentTx: vi.fn(),
  getAgentDetail: vi.fn(),
  revokePortalAccessTx: vi.fn(),
  getAgentHierarchy: vi.fn(),
  getAncestors: vi.fn(),
  getDirectDownlines: vi.fn(),
  getSubtree: vi.fn(),
  setUplineTx: vi.fn(),
  getPartyById: vi.fn(),
  validateUplineChange: vi.fn(),
  // B1 contact-uniqueness guard (Task 1). Default: no conflict, no P2002.
  checkContactUniqueness: vi.fn().mockResolvedValue(null),
  isContactUniqueViolation: vi.fn().mockReturnValue(false),
  // T4 deletion-blocker helpers (Task 4). Default: deletable=true (clean row).
  isPartyDeletable: vi.fn().mockReturnValue(true),
  // T2 detail helpers.
  findOwnerDetail: vi.fn(),
  findUnitsOwned: vi.fn(),
  findTenantDetail: vi.fn(),
  findPortalUserByParty: vi.fn(),
  // T3 active-tenancy helper.
  hasActiveTenancy: vi.fn(),
}));

vi.mock("../../../lib/auth-status-cache", () => ({
  authStatusCache: { delete: vi.fn() },
}));

const mockedRepo = vi.mocked(repo);
const session = { userId: "u1", orgId: "o1", role: "admin" };

describe("parties.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks duplicate tenant id number", async () => {
    mockedRepo.findPartyByIdNumber.mockResolvedValueOnce({ id: "dup" } as never);

    const res = await createTenantService(session, {
      displayName: "Tenant A",
      idNumber: "901010101010",
      legalName: "",
      primaryEmail: "",
      primaryPhone: "",
      idType: "ic",
      nationality: "MY",
      occupation: "",
      employerName: "",
      monthlyIncome: "",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("returns not found when updating non-owner", async () => {
    mockedRepo.findRole.mockResolvedValueOnce(null);

    const res = await updateOwnerService(session, {
      partyId: "11111111-1111-1111-1111-111111111111",
      displayName: "Owner X",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  // ── updateAgentService ────────────────────────────────────────────────────

  describe("updateAgentService", () => {
    const partyId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const updatedAt = "2026-04-18T10:00:00.000Z";
    const baseInput = { partyId, updatedAt, displayName: "Agent A" };

    it("returns 404 when agent role is not found", async () => {
      mockedRepo.findRole.mockResolvedValueOnce(null);

      const res = await updateAgentService(session, baseInput);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
      expect(mockedRepo.updateParty).not.toHaveBeenCalled();
    });

    it("returns 409 when updateParty returns null (stale) — row still exists", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce(null as never);
      // delete-probe: row still exists → 409
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);

      const res = await updateAgentService(session, baseInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toContain("Record changed");
      }
    });

    it("returns 404 when updateParty returns null and row was concurrently deleted", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce(null as never);
      // delete-probe: row is gone → 404
      mockedRepo.findRole.mockResolvedValueOnce(null as never);

      const res = await updateAgentService(session, baseInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(404);
        expect(res.error).toContain("not found");
      }
    });

    it("returns ok:true with updatedAt on success", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      const res = await updateAgentService(session, baseInput);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.data.id).toBe(partyId);
        expect(res.data.updatedAt).toBe(freshDate.toISOString());
      }
    });

    it("passes correct args to updateParty including expectedUpdatedAt", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      await updateAgentService(session, baseInput);

      expect(mockedRepo.updateParty).toHaveBeenCalledWith(
        partyId,
        updatedAt,
        expect.objectContaining({ displayName: "Agent A" }),
      );
    });

    it("coerces explicit empty strings on nullable text columns to null before persisting", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      // Wire-format pattern: the agent edit drawer forwards "" when the
      // user clears a field (so that intent is unambiguous on the wire,
      // distinct from `undefined` "leave alone"). The service must
      // translate "" → null before Prisma sees it. Only fields present
      // in updateAgentSchema are exercised here — idType/idNumber are
      // covered by the dedicated coerceEmptyStringsToNull unit test.
      await updateAgentService(session, {
        ...baseInput,
        legalName: "",
        primaryEmail: "",
        primaryPhone: "",
        bankName: "",
        bankAccountHolder: "",
        bankAccountNumber: "",
        nationality: "",
      } as never);

      expect(mockedRepo.updateParty).toHaveBeenCalledWith(
        partyId,
        updatedAt,
        expect.objectContaining({
          legalName: null,
          primaryEmail: null,
          primaryPhone: null,
          bankName: null,
          bankAccountHolder: null,
          bankAccountNumber: null,
          nationality: null,
        }),
      );
    });

    it("does NOT coerce non-empty strings — values are forwarded unchanged", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      await updateAgentService(session, {
        ...baseInput,
        primaryEmail: "agent@example.com",
        bankName: "Maybank",
      } as never);

      expect(mockedRepo.updateParty).toHaveBeenCalledWith(
        partyId,
        updatedAt,
        expect.objectContaining({
          primaryEmail: "agent@example.com",
          bankName: "Maybank",
        }),
      );
    });

    // Regression: optionalPhoneSchema's preprocess turns missing-key → null
    // before validation. If the update schema doesn't wrap that with
    // `.optional()`, every PATCH that omits primaryPhone would write
    // `primaryPhone: null` — silently wiping the existing phone. This test
    // exercises the FULL wire path (schema parse, then service) so a
    // future regression on the schema layer surfaces here.
    it("does NOT touch primaryPhone when client omits the key (PATCH semantics)", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      // Mirror real wire-format: client sends a PATCH with NO primaryPhone
      // field. The route would parse this through updateAgentSchema before
      // calling the service — replicate that here. Use a real UUID v4
      // because the schema validates UUID format strictly (the parent
      // describe's `partyId` uses `aaaa-...` which is not a valid v4).
      const realPartyId = "550e8400-e29b-41d4-a716-446655440001";
      const wirePayload = { partyId: realPartyId, updatedAt, displayName: "Agent A" };
      const parsed = updateAgentSchema.parse(wirePayload);

      await updateAgentService(session, parsed);

      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
      // updateAgentService uses the 3-arg overload: (partyId, updatedAt, data).
      const callArgs = mockedRepo.updateParty.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
      const data = callArgs[2];
      // The bug we are guarding against: schema producing primaryPhone:null
      // (because preprocess turned undefined→null), then service spreading
      // that null into the update — wiping the DB phone.
      expect("primaryPhone" in data).toBe(false);
    });
  });

  // ── updateOwnerService PATCH semantics ────────────────────────────────────

  describe("updateOwnerService PATCH semantics", () => {
    // Real UUID v4 — schemas validate format strictly.
    const partyId = "550e8400-e29b-41d4-a716-446655440000";

    it("does NOT touch primaryPhone when client omits the key (regression)", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({} as never);

      // Full wire-path: schema parse, then service. Without `.optional()`
      // on updateOwnerSchema's primaryPhone field, this parsed payload
      // would carry `primaryPhone: null` and the service's `!== undefined`
      // check would propagate that null to updateParty.
      const wirePayload = { partyId, displayName: "New Owner Name" };
      const parsed = updateOwnerSchema.parse(wirePayload);

      await updateOwnerService(session, parsed);

      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
      const callArgs = mockedRepo.updateParty.mock.calls[0]!;
      // updateOwnerService signature: updateParty(partyId, data) — data at index 1.
      const data = callArgs[1] as Record<string, unknown>;
      expect("primaryPhone" in data).toBe(false);
    });

    it("DOES write primaryPhone: null when client explicitly clears it (empty string → null)", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({} as never);

      // Full wire-path: schema parse normalizes "" → null (intentional clear).
      const wirePayload = { partyId, displayName: "Owner Z", primaryPhone: "" };
      const parsed = updateOwnerSchema.parse(wirePayload);

      await updateOwnerService(session, parsed);

      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
      const callArgs = mockedRepo.updateParty.mock.calls[0]!;
      const data = callArgs[1] as Record<string, unknown>;
      expect(data.primaryPhone).toBeNull();
    });

    it("normalizes a valid phone before reaching the repo", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({} as never);

      const wirePayload = { partyId, displayName: "Owner W", primaryPhone: "012-345 6789" };
      const parsed = updateOwnerSchema.parse(wirePayload);

      await updateOwnerService(session, parsed);

      const callArgs = mockedRepo.updateParty.mock.calls[0]!;
      const data = callArgs[1] as Record<string, unknown>;
      expect(data.primaryPhone).toBe("60123456789");
    });

    // ── duplicate-IC guard ────────────────────────────────────────────────────

    it("returns 409 when idNumber is already used by a DIFFERENT party", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.findPartyByIdNumber.mockResolvedValueOnce({ id: "other-party" } as never);

      const wirePayload = { partyId, displayName: "Owner D", idNumber: "901010101010" };
      const parsed = updateOwnerSchema.parse(wirePayload);

      const res = await updateOwnerService(session, parsed);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toBe("Owner ID/passport already exists");
      }
      expect(mockedRepo.updateParty).not.toHaveBeenCalled();
    });

    it("allows update (no 409) when idNumber belongs to the SAME party (self-update)", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      // findPartyByIdNumber returns the same partyId → not a dup
      mockedRepo.findPartyByIdNumber.mockResolvedValueOnce({ id: partyId } as never);
      mockedRepo.checkContactUniqueness.mockResolvedValueOnce(null as never);
      mockedRepo.updateParty.mockResolvedValueOnce({} as never);

      const wirePayload = { partyId, displayName: "Owner S", idNumber: "901010101010" };
      const parsed = updateOwnerSchema.parse(wirePayload);

      const res = await updateOwnerService(session, parsed);

      expect(res.ok).toBe(true);
      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    });

    it("does NOT call findPartyByIdNumber when idNumber is omitted", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce({} as never);

      const wirePayload = { partyId, displayName: "Owner N" };
      const parsed = updateOwnerSchema.parse(wirePayload);

      await updateOwnerService(session, parsed);

      expect(mockedRepo.findPartyByIdNumber).not.toHaveBeenCalled();
      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    });
  });

  // ── reactivateTenantService ───────────────────────────────────────────────
  // Substantive post-state coverage: the route test mocks the service, so the
  // exact un-blacklist write ({ isBlacklisted:false, blacklistReason:null,
  // status:"active" }) is proven HERE, at the service↔repo boundary.

  describe("reactivateTenantService", () => {
    // Real UUID v4 — schemas validate format strictly.
    const partyId = "550e8400-e29b-41d4-a716-446655440001";

    it("writes the exact un-blacklist post-state and returns ok:true 200 when role exists", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce(undefined as never);

      const res = await reactivateTenantService(session, { partyId });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ id: partyId });
      }
      expect(mockedRepo.findRole).toHaveBeenCalledWith(session.orgId, partyId, "tenant");
      // 2-arg overload: updateParty(partyId, data) — data at index 1.
      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
      expect(mockedRepo.updateParty).toHaveBeenCalledWith(partyId, {
        isBlacklisted: false,
        blacklistReason: null,
        status: "active",
      });
    });

    it("returns 404 and does NOT call updateParty when tenant role is not found", async () => {
      mockedRepo.findRole.mockResolvedValueOnce(null);

      const res = await reactivateTenantService(session, { partyId });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
      expect(mockedRepo.updateParty).not.toHaveBeenCalled();
    });
  });

  // ── reactivateOwnerService ────────────────────────────────────────────────

  describe("reactivateOwnerService", () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440002";

    it("writes the exact un-blacklist post-state and returns ok:true 200 when role exists", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.updateParty.mockResolvedValueOnce(undefined as never);

      const res = await reactivateOwnerService(session, { partyId });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ id: partyId });
      }
      expect(mockedRepo.findRole).toHaveBeenCalledWith(session.orgId, partyId, "owner");
      expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
      expect(mockedRepo.updateParty).toHaveBeenCalledWith(partyId, {
        isBlacklisted: false,
        blacklistReason: null,
        status: "active",
      });
    });

    it("returns 404 and does NOT call updateParty when owner role is not found", async () => {
      mockedRepo.findRole.mockResolvedValueOnce(null);

      const res = await reactivateOwnerService(session, { partyId });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
      expect(mockedRepo.updateParty).not.toHaveBeenCalled();
    });
  });

  // ── blacklistAgentService ─────────────────────────────────────────────────

  describe("blacklistAgentService", () => {
    const agentPartyId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const updatedAt = "2026-04-18T10:00:00.000Z";
    const blacklistInput = { partyId: agentPartyId, reason: "Fraud suspected", updatedAt };

    it("returns 404 when agent role is not found", async () => {
      mockedRepo.findRole.mockResolvedValueOnce(null);

      const res = await blacklistAgentService(session, blacklistInput);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
      expect(mockedRepo.blacklistAgentTx).not.toHaveBeenCalled();
    });

    it("calls blacklistAgentTx with correct args and returns ok:true with updatedAt on success", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.blacklistAgentTx.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      const res = await blacklistAgentService(session, blacklistInput);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.data.id).toBe(agentPartyId);
        expect(res.data.updatedAt).toBe(freshDate.toISOString());
      }
      expect(mockedRepo.blacklistAgentTx).toHaveBeenCalledWith(
        session.orgId,
        agentPartyId,
        blacklistInput.reason,
        updatedAt,
        session.userId,
      );
    });

    it("returns 409 when blacklistAgentTx throws StaleUpdateError", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.blacklistAgentTx.mockRejectedValueOnce(new StaleUpdateError());

      const res = await blacklistAgentService(session, blacklistInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toContain("Record changed");
      }
    });

    it("returns 409 when blacklistAgentTx throws StaleUpdateError with custom message", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.blacklistAgentTx.mockRejectedValueOnce(new StaleUpdateError("Record changed since last read"));

      const res = await blacklistAgentService(session, blacklistInput);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(409);
    });

    it("propagates error when blacklistAgentTx throws an untagged error (db connection lost)", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.blacklistAgentTx.mockRejectedValueOnce(new Error("db connection lost"));

      await expect(blacklistAgentService(session, blacklistInput)).rejects.toThrow("db connection lost");
    });

    it("propagates error when blacklistAgentTx throws a non-stale error (transaction rollback contract)", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.blacklistAgentTx.mockRejectedValueOnce(new Error("DB error"));

      await expect(blacklistAgentService(session, blacklistInput)).rejects.toThrow("DB error");
    });
  });

  // ── reactivateAgentService ────────────────────────────────────────────────

  describe("reactivateAgentService", () => {
    const partyId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const updatedAt = "2026-04-18T10:00:00.000Z";
    const reactivateInput = { partyId, note: "Cleared after investigation", updatedAt };

    it("returns 404 when findRole returns null", async () => {
      mockedRepo.findRole.mockResolvedValueOnce(null);

      const res = await reactivateAgentService(session, reactivateInput);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
      expect(mockedRepo.reactivateAgentTx).not.toHaveBeenCalled();
    });

    it("returns 409 when tx throws NOT_BLACKLISTED", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.reactivateAgentTx.mockRejectedValueOnce(new InvalidStateError("NOT_BLACKLISTED", "Agent is not blacklisted"));

      const res = await reactivateAgentService(session, reactivateInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toContain("not blacklisted");
      }
    });

    it("propagates non-business errors", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.reactivateAgentTx.mockRejectedValueOnce(new Error("db connection lost"));

      await expect(reactivateAgentService(session, reactivateInput)).rejects.toThrow("db connection lost");
    });

    it("returns 409 when tx throws StaleUpdateError", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.reactivateAgentTx.mockRejectedValueOnce(new StaleUpdateError());

      const res = await reactivateAgentService(session, reactivateInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toContain("Record changed");
      }
    });

    it("returns ok:true with updatedAt ISO on success and calls tx with correct args", async () => {
      const freshDate = new Date("2026-04-18T10:01:00.000Z");
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.reactivateAgentTx.mockResolvedValueOnce({ updatedAt: freshDate } as never);

      const res = await reactivateAgentService(session, reactivateInput);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.data.id).toBe(partyId);
        expect(res.data.updatedAt).toBe(freshDate.toISOString());
      }
      expect(mockedRepo.reactivateAgentTx).toHaveBeenCalledWith(
        session.orgId,
        partyId,
        reactivateInput.note,
        updatedAt,
        session.userId,
      );
    });
  });

  // ── getAgentDetailService ─────────────────────────────────────────────────

  describe("getAgentDetailService", () => {
    const partyId = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    it("returns 404 when findRole returns null", async () => {
      mockedRepo.findRole.mockResolvedValueOnce(null);

      const res = await getAgentDetailService(session, partyId);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
      expect(mockedRepo.getAgentDetail).not.toHaveBeenCalled();
    });

    it("returns 404 when getAgentDetail returns null", async () => {
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.getAgentDetail.mockResolvedValueOnce(null as never);

      const res = await getAgentDetailService(session, partyId);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(404);
    });

    it("returns ok:true with agent detail shape on success", async () => {
      const detail = {
        id: partyId, displayName: "Agent C", legalName: null,
        primaryEmail: "agent@example.com", primaryPhone: null,
        idType: null, idNumber: null, nationality: "MY", agentLevel: "new_agent",
        bank: { name: null, accountHolder: null, accountNumber: null },
        status: "active", isBlacklisted: false, blacklistReason: null,
        portalUser: null,
        claimStats: { submitted: 1, approved: 0, paid: 2, rejected: 0, totalPaidCommission: 500 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-04-18T10:00:00.000Z",
      };
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.getAgentDetail.mockResolvedValueOnce(detail as never);

      const res = await getAgentDetailService(session, partyId);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        // Service projects `primaryPhone` (read-tolerant canonical) and
        // `formattedPhone` (pre-rendered display) on top of the repo shape.
        // Fixture has `primaryPhone: null`, so both project to null.
        expect(res.data).toEqual({ ...detail, formattedPhone: null });
      }
      expect(mockedRepo.getAgentDetail).toHaveBeenCalledWith(session.orgId, partyId);
    });

    it("includes formattedPhone (display) and canonical primaryPhone when phone is present", async () => {
      const detail = {
        id: partyId, displayName: "Agent C", legalName: null,
        primaryEmail: "agent@example.com", primaryPhone: "60123456789",
        idType: null, idNumber: null, nationality: "MY", agentLevel: "new_agent",
        bank: { name: null, accountHolder: null, accountNumber: null },
        status: "active", isBlacklisted: false, blacklistReason: null,
        portalUser: null,
        claimStats: { submitted: 0, approved: 0, paid: 0, rejected: 0, totalPaidCommission: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-04-18T10:00:00.000Z",
      };
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.getAgentDetail.mockResolvedValueOnce(detail as never);

      const res = await getAgentDetailService(session, partyId);

      expect(res.ok).toBe(true);
      if (res.ok) {
        // primaryPhone stays canonical; formattedPhone is the display form.
        expect(res.data).toMatchObject({
          primaryPhone: "60123456789",
          formattedPhone: "+60 12-345 6789",
        });
      }
    });

    it("normalizes legacy `+60`-prefixed primaryPhone to canonical and formats", async () => {
      // Pre-backfill UAT data may still carry `+60` — service must canonicalize
      // at the read boundary so the API contract is uniform.
      const detail = {
        id: partyId, displayName: "Agent C", legalName: null,
        primaryEmail: null, primaryPhone: "+60123456789",
        idType: null, idNumber: null, nationality: "MY", agentLevel: "new_agent",
        bank: { name: null, accountHolder: null, accountNumber: null },
        status: "active", isBlacklisted: false, blacklistReason: null,
        portalUser: null,
        claimStats: { submitted: 0, approved: 0, paid: 0, rejected: 0, totalPaidCommission: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-04-18T10:00:00.000Z",
      };
      mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
      mockedRepo.getAgentDetail.mockResolvedValueOnce(detail as never);

      const res = await getAgentDetailService(session, partyId);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toMatchObject({
          primaryPhone: "60123456789",
          formattedPhone: "+60 12-345 6789",
        });
      }
    });
  });

  // ── getOwnersService — formattedPhone projection ──────────────────────────

  describe("getOwnersService", () => {
    it("returns rows with formattedPhone populated when primaryPhone is canonical", async () => {
      mockedRepo.listOwners.mockResolvedValueOnce([
        {
          id: "o1", displayName: "Owner One", legalName: null,
          primaryEmail: "o1@example.com", primaryPhone: "60123456789",
          nationality: "MY", idType: null, idNumber: null,
          bankName: null, bankAccountHolder: null, bankAccountNumber: null,
          isBlacklisted: false, status: "active",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ] as never);

      const rows = await getOwnersService(session);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "o1",
        primaryPhone: "60123456789",
        formattedPhone: "+60 12-345 6789",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
    });

    it("returns formattedPhone null when primaryPhone is null", async () => {
      mockedRepo.listOwners.mockResolvedValueOnce([
        {
          id: "o2", displayName: "Owner Two", legalName: null,
          primaryEmail: null, primaryPhone: null,
          nationality: null, idType: null, idNumber: null,
          bankName: null, bankAccountHolder: null, bankAccountNumber: null,
          isBlacklisted: false, status: "active",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ] as never);

      const rows = await getOwnersService(session);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "o2",
        primaryPhone: null,
        formattedPhone: null,
      });
    });

    it("maps ownedUnits to units and dedupes a partitioned apartment to one entry", async () => {
      mockedRepo.listOwners.mockResolvedValueOnce([
        {
          id: "o3", displayName: "Owner Three", legalName: null,
          primaryEmail: null, primaryPhone: null,
          nationality: null, idType: null, idNumber: null,
          bankName: null, bankAccountHolder: null, bankAccountNumber: null,
          isBlacklisted: false, status: "active",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          ownedUnits: [
            { apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
            { apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
          ],
        },
      ] as never);

      const rows = await getOwnersService(session);

      expect(rows[0].units).toEqual([{ propertyName: "Vista Court", unitCode: "B-08-08" }]);
    });

    it("returns units: [] when the owner owns nothing and does not leak ownedUnits", async () => {
      mockedRepo.listOwners.mockResolvedValueOnce([
        {
          id: "o4", displayName: "Owner Four", legalName: null,
          primaryEmail: null, primaryPhone: null,
          nationality: null, idType: null, idNumber: null,
          bankName: null, bankAccountHolder: null, bankAccountNumber: null,
          isBlacklisted: false, status: "active",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          ownedUnits: [],
        },
      ] as never);

      const rows = await getOwnersService(session);

      expect(rows[0].units).toEqual([]);
      expect("ownedUnits" in rows[0]).toBe(false);
    });
  });

  // ── getOwnerDetailService — monthlyIncome projection (task A1 companion) ──
  // findOwnerDetail's select gained `monthlyIncome` (a Prisma Decimal column).
  // getTenantDetailService already stringifies its Decimal the same way
  // (`row.monthlyIncome?.toString() ?? null`) so the API always returns a
  // plain string, never a raw Decimal instance. getOwnerDetailService must
  // do the same now that owners carry the same column.

  describe("getOwnerDetailService — monthlyIncome projection", () => {
    it("stringifies a Decimal monthlyIncome instead of leaking the raw Decimal object", async () => {
      const partyId = "550e8400-e29b-41d4-a716-446655440031";
      mockedRepo.findOwnerDetail.mockResolvedValueOnce({
        id: partyId, displayName: "Owner Income", legalName: null,
        primaryEmail: null, primaryPhone: null, whatsappPhone: null,
        idType: null, idNumber: null, nationality: null,
        gender: null, dateOfBirth: null,
        occupation: null, employerName: "Acme Sdn Bhd", employerAddress: null,
        monthlyIncome: { toString: () => "4500.50" },
        emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
        bankName: null, bankAccountHolder: null, bankAccountNumber: null,
        isBlacklisted: false, blacklistReason: null, status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } as never);
      mockedRepo.findUnitsOwned.mockResolvedValueOnce([]);
      mockedRepo.findPortalUserByParty.mockResolvedValueOnce(null);

      const res = await getOwnerDetailService(session, partyId);

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.monthlyIncome).toBe("4500.50");
        expect(res.data.employerName).toBe("Acme Sdn Bhd");
      }
    });

    it("returns null (not the string 'null') when monthlyIncome is absent", async () => {
      const partyId = "550e8400-e29b-41d4-a716-446655440032";
      mockedRepo.findOwnerDetail.mockResolvedValueOnce({
        id: partyId, displayName: "Owner No Income", legalName: null,
        primaryEmail: null, primaryPhone: null, whatsappPhone: null,
        idType: null, idNumber: null, nationality: null,
        gender: null, dateOfBirth: null,
        occupation: null, employerName: null, employerAddress: null,
        monthlyIncome: null,
        emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
        bankName: null, bankAccountHolder: null, bankAccountNumber: null,
        isBlacklisted: false, blacklistReason: null, status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } as never);
      mockedRepo.findUnitsOwned.mockResolvedValueOnce([]);
      mockedRepo.findPortalUserByParty.mockResolvedValueOnce(null);

      const res = await getOwnerDetailService(session, partyId);

      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.monthlyIncome).toBeNull();
    });
  });

  // ── revokePortalAccessService ─────────────────────────────────────────────

  describe("revokePortalAccessService", () => {
    const partyId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const updatedAt = "2026-04-18T10:00:00.000Z";
    const revokeInput = { partyId, updatedAt };

    it("returns 404 when tx throws NOT_FOUND", async () => {
      mockedRepo.revokePortalAccessTx.mockRejectedValueOnce(new NotFoundError("portal user", "Portal user not found for this party"));

      const res = await revokePortalAccessService(session, revokeInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(404);
        expect(res.error).toContain("Portal user not found");
      }
    });

    it("propagates non-business errors", async () => {
      mockedRepo.revokePortalAccessTx.mockRejectedValueOnce(new Error("db connection lost"));

      await expect(revokePortalAccessService(session, revokeInput)).rejects.toThrow("db connection lost");
    });

    it("returns 409 when tx throws StaleUpdateError", async () => {
      mockedRepo.revokePortalAccessTx.mockRejectedValueOnce(new StaleUpdateError());

      const res = await revokePortalAccessService(session, revokeInput);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toContain("Record changed");
      }
    });

    it("returns ok:true and invalidates auth cache AFTER tx resolves", async () => {
      const { authStatusCache } = await import("../../../lib/auth-status-cache");
      const userId = "user-xyz-123";
      const txOrder: string[] = [];

      mockedRepo.revokePortalAccessTx.mockImplementationOnce(async () => {
        txOrder.push("tx");
        return { userId };
      });
      vi.mocked(authStatusCache.delete).mockImplementationOnce(() => {
        txOrder.push("cache");
      });

      const res = await revokePortalAccessService(session, revokeInput);

      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data).toEqual({ ok: true });
      expect(authStatusCache.delete).toHaveBeenCalledWith(userId);
      expect(txOrder).toEqual(["tx", "cache"]);
    });
  });
});

// ── tenant/owner field-parity persistence (task A1, #1 #2) ────────────────
//
// Every test above mocks the WHOLE parties.repository module, so calling
// createTenantService/createOwnerService only proves the service forwards
// its `input` object to the (mocked) createTenant/createOwner — it can
// never see a bug in the REAL write-arm (the literal field list inside
// `tx.party.create({ data: {...} })`). That write-arm is exactly what this
// task adds fields to, and exactly what report A warned can silently drop a
// field even when the zod schema accepts it. So these tests import the REAL
// parties.repository via vi.importActual (bypassing this file's top-level
// vi.mock for just this describe block) and assert on the mocked Prisma
// client call itself — the only way to prove a field survives BOTH the
// schema parse AND the repository's write-arm.
describe("tenant/owner field-parity persistence (task A1, #1 #2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.party.findFirst.mockResolvedValue(null);
    mockDb.partyRole.findFirst.mockResolvedValue({ id: "role-1" });
    mockDb.partyRole.create.mockResolvedValue({});
    mockDb.$transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
  });

  it("create tenant persists gender, dateOfBirth, and emergencyContactPhone to the Party row", async () => {
    const { createTenant } = await vi.importActual<typeof import("../parties.repository")>("../parties.repository");
    mockDb.party.create.mockResolvedValueOnce({ id: "tenant-new-1" });

    // Schema parse first — proves the key survives zod (not stripped as an
    // unrecognized key) — then the REAL repository write-arm.
    const parsed = createTenantSchema.parse({
      displayName: "Tenant Field-Parity",
      gender: "male",
      dateOfBirth: "1990-05-15",
      emergencyContactPhone: "60123456789",
    });

    await createTenant("o1", parsed as Record<string, unknown>);

    expect(mockDb.party.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gender: "male",
          dateOfBirth: new Date("1990-05-15"),
          emergencyContactPhone: "60123456789",
        }),
      }),
    );
  });

  it("create tenant persists whatsappPhone and employerAddress (remaining gap fields)", async () => {
    const { createTenant } = await vi.importActual<typeof import("../parties.repository")>("../parties.repository");
    mockDb.party.create.mockResolvedValueOnce({ id: "tenant-new-2" });

    const parsed = createTenantSchema.parse({
      displayName: "Tenant Full Profile",
      whatsappPhone: "60129876543",
      employerAddress: "2 Jalan Bukit Bintang, KL",
      emergencyContactName: "John Tan",
      emergencyContactRelation: "Father",
    });

    await createTenant("o1", parsed as Record<string, unknown>);

    expect(mockDb.party.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          whatsappPhone: "60129876543",
          employerAddress: "2 Jalan Bukit Bintang, KL",
          emergencyContactName: "John Tan",
          emergencyContactRelation: "Father",
        }),
      }),
    );
  });

  it("create owner persists employment fields — monthlyIncome, employerName, emergencyContactName", async () => {
    const { createOwner } = await vi.importActual<typeof import("../parties.repository")>("../parties.repository");
    mockDb.party.create.mockResolvedValueOnce({ id: "owner-new-1" });

    const parsed = createOwnerSchema.parse({
      displayName: "Owner Field-Parity",
      monthlyIncome: "4500.50",
      employerName: "Acme Sdn Bhd",
      emergencyContactName: "Jane Doe",
    });

    await createOwner("o1", parsed as Record<string, unknown>);

    expect(mockDb.party.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          monthlyIncome: 4500.5,
          employerName: "Acme Sdn Bhd",
          emergencyContactName: "Jane Doe",
        }),
      }),
    );
  });

  it("create owner persists whatsappPhone, gender, dateOfBirth, occupation, employerAddress, and emergencyContact trio", async () => {
    const { createOwner } = await vi.importActual<typeof import("../parties.repository")>("../parties.repository");
    mockDb.party.create.mockResolvedValueOnce({ id: "owner-new-2" });

    const parsed = createOwnerSchema.parse({
      displayName: "Owner Full Profile",
      whatsappPhone: "60129876543",
      gender: "female",
      dateOfBirth: "1985-11-02",
      occupation: "Engineer",
      employerAddress: "1 Jalan Ampang, KL",
      emergencyContactPhone: "60112223333",
      emergencyContactRelation: "Spouse",
    });

    await createOwner("o1", parsed as Record<string, unknown>);

    expect(mockDb.party.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          whatsappPhone: "60129876543",
          gender: "female",
          dateOfBirth: new Date("1985-11-02"),
          occupation: "Engineer",
          employerAddress: "1 Jalan Ampang, KL",
          emergencyContactPhone: "60112223333",
          emergencyContactRelation: "Spouse",
        }),
      }),
    );
  });

  // The "" → null coercion is a SERVICE-layer concern (updateOwnerService's
  // own spread logic), not a repository write-arm — updateParty is a fully
  // generic passthrough with no per-field logic, so testing at the service
  // level (repo mocked, matching every other test in this file) is the
  // correct and sufficient level here; no vi.importActual needed.
  it("owner update clears monthlyIncome to null (not NaN) when the client sends an empty string", async () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440099";
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    mockedRepo.updateParty.mockResolvedValueOnce({} as never);

    const parsed = updateOwnerSchema.parse({ partyId, monthlyIncome: "" });

    const result = await updateOwnerService(session, parsed);

    expect(result.ok).toBe(true);
    expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    const callArgs = mockedRepo.updateParty.mock.calls[0]!;
    const data = callArgs[1] as Record<string, unknown>;
    expect(data.monthlyIncome).toBeNull();
    expect(Number.isNaN(data.monthlyIncome)).toBe(false);
  });

  // ── blank dateOfBirth on EDIT (final whole-branch review, BLOCKER) ────────
  // The edit dialog renders <TextInput type="date" name="dateOfBirth"> and
  // submits via getEditFormData, which KEEPS empty strings — so leaving DOB
  // blank sends `dateOfBirth: ""`. Before the fix, updateOwner/TenantSchema's
  // `.regex(...).optional()` admitted only `undefined`, so "" failed the regex
  // and the route's safeParse 400'd EVERY owner/tenant edit with a blank DOB.
  // The `.or(z.literal(""))` (mirroring the adjacent monthlyIncome field) lets
  // "" through; the service already coerces "" → null on write.

  it("updateOwnerSchema accepts a blank dateOfBirth (edit dialog clears DOB → no 400)", () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440101";
    const res = updateOwnerSchema.safeParse({ partyId, dateOfBirth: "" });
    expect(res.success).toBe(true);
  });

  it("updateTenantSchema accepts a blank dateOfBirth (edit dialog clears DOB → no 400)", () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440102";
    const res = updateTenantSchema.safeParse({ partyId, dateOfBirth: "" });
    expect(res.success).toBe(true);
  });

  it("owner update clears dateOfBirth to null (not Invalid Date) when the client sends an empty string", async () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440103";
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    mockedRepo.updateParty.mockResolvedValueOnce({} as never);

    const parsed = updateOwnerSchema.parse({ partyId, dateOfBirth: "" });

    const result = await updateOwnerService(session, parsed);

    expect(result.ok).toBe(true);
    expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    const callArgs = mockedRepo.updateParty.mock.calls[0]!;
    const data = callArgs[1] as Record<string, unknown>;
    expect(data.dateOfBirth).toBeNull();
  });

  it("tenant update clears dateOfBirth to null (not Invalid Date) when the client sends an empty string", async () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440104";
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    mockedRepo.updateParty.mockResolvedValueOnce({} as never);

    const parsed = updateTenantSchema.parse({ partyId, dateOfBirth: "" });

    const result = await updateTenantService(session, parsed);

    expect(result.ok).toBe(true);
    expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    const callArgs = mockedRepo.updateParty.mock.calls[0]!;
    const data = callArgs[1] as Record<string, unknown>;
    expect(data.dateOfBirth).toBeNull();
  });

  it("owner update persists occupation, employerName, employerAddress, and emergencyContact trio", async () => {
    const partyId = "550e8400-e29b-41d4-a716-446655440098";
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    mockedRepo.updateParty.mockResolvedValueOnce({} as never);

    const parsed = updateOwnerSchema.parse({
      partyId,
      occupation: "Doctor",
      employerName: "KPJ Hospital",
      employerAddress: "3 Jalan Tun Razak, KL",
      emergencyContactName: "Mary Lee",
      emergencyContactPhone: "60134445555",
      emergencyContactRelation: "Sister",
    });

    const result = await updateOwnerService(session, parsed);

    expect(result.ok).toBe(true);
    const callArgs = mockedRepo.updateParty.mock.calls[0]!;
    const data = callArgs[1] as Record<string, unknown>;
    expect(data).toMatchObject({
      occupation: "Doctor",
      employerName: "KPJ Hospital",
      employerAddress: "3 Jalan Tun Razak, KL",
      emergencyContactName: "Mary Lee",
      emergencyContactPhone: "60134445555",
      emergencyContactRelation: "Sister",
    });
  });
});

describe("setUplineService", () => {
  beforeEach(() => vi.clearAllMocks());
  const session = { orgId: "org1", userId: "u1" } as any;

  it("maps repo NOT_FOUND to 404", async () => {
    (repo.setUplineTx as any).mockResolvedValueOnce({ ok: false, error: "NOT_FOUND" });
    const result = await setUplineService(session, "a1", "b1");
    expect(result).toMatchObject({ ok: false, status: 404, error: "NOT_FOUND" });
  });

  it.each([
    "UPLINE_SELF_REFERENCE",
    "UPLINE_INVALID_TARGET",
    "UPLINE_WOULD_CREATE_CYCLE",
    "UPLINE_DEPTH_EXCEEDED",
  ])("maps repo error %s to 400", async (err) => {
    (repo.setUplineTx as any).mockResolvedValueOnce({ ok: false, error: err });
    const result = await setUplineService(session, "a1", "b1");
    expect(result).toMatchObject({ ok: false, status: 400, error: err });
  });

  it("happy path returns updatedAt", async () => {
    const now = new Date();
    (repo.setUplineTx as any).mockResolvedValueOnce({ ok: true, updatedAt: now, changed: true });
    const result = await setUplineService(session, "a1", "b1");
    expect(result).toMatchObject({ ok: true, status: 200, updatedAt: now });
    expect(repo.setUplineTx).toHaveBeenCalledWith("org1", "a1", "b1", "u1");
  });

  it("no-op path (unchanged) still returns ok without ActivityLog spam", async () => {
    const now = new Date();
    (repo.setUplineTx as any).mockResolvedValueOnce({ ok: true, updatedAt: now, changed: false });
    const result = await setUplineService(session, "a1", "b1");
    expect(result).toMatchObject({ ok: true, status: 200, updatedAt: now });
  });

  it("forwards null to clear upline", async () => {
    (repo.setUplineTx as any).mockResolvedValueOnce({ ok: true, updatedAt: new Date(), changed: true });
    await setUplineService(session, "a1", null);
    expect(repo.setUplineTx).toHaveBeenCalledWith("org1", "a1", null, "u1");
  });
});

describe("updateAgentService — uplineId path", () => {
  beforeEach(() => vi.clearAllMocks());
  const session = { orgId: "org1", userId: "u1" } as any;

  it("updateAgentService forwards uplineId to setUplineTx when provided", async () => {
    const now = new Date();
    (repo.findRole as any).mockResolvedValueOnce({ id: "role1" });
    (repo.validateUplineChange as any).mockResolvedValueOnce({ ok: true });
    (repo.updateParty as any).mockResolvedValueOnce({ id: "a1", updatedAt: now });

    const result = await updateAgentService(
      session,
      { partyId: "a1", uplineId: "b1", updatedAt: now.toISOString() } as any
    );

    expect(result.ok).toBe(true);
    expect(repo.validateUplineChange).toHaveBeenCalledWith("org1", "a1", "b1");
  });

  it("updateAgentService bubbles up upline invariant failures as 400", async () => {
    const now = new Date();
    (repo.findRole as any).mockResolvedValueOnce({ id: "role1" });
    (repo.validateUplineChange as any).mockResolvedValueOnce({ ok: false, error: "UPLINE_WOULD_CREATE_CYCLE" });

    const result = await updateAgentService(
      session,
      { partyId: "a1", uplineId: "b1", updatedAt: now.toISOString() } as any
    );

    expect(result).toMatchObject({ ok: false, status: 400, error: "UPLINE_WOULD_CREATE_CYCLE" });
    // Regression guard — a failed invariant MUST NOT commit the generic update.
    expect(repo.updateParty).not.toHaveBeenCalled();
  });
});

describe("blacklistAgentService — downline detach cascade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detaches direct downlines inside the blacklist transaction", async () => {
    (repo.findRole as any).mockResolvedValueOnce({ id: "role1" });
    (repo.blacklistAgentTx as any).mockResolvedValueOnce({
      detachedDownlineIds: ["c1", "c2"],
      updatedAt: new Date(),
    });
    const result = await blacklistAgentService(
      { orgId: "org1", userId: "u1" } as any,
      { partyId: "a1", reason: "fraud investigation ongoing x3", updatedAt: new Date().toISOString() } as any
    );
    expect(result.ok).toBe(true);
    expect(repo.blacklistAgentTx).toHaveBeenCalled();
  });
});

describe("listAssignableMembersService — surfaces non-agent parties", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns admin/manager rows alongside agents (no partyType filter at service)", async () => {
    // Repo returns a heterogeneous list — including an admin (partyType=individual)
    // — and the service must pass it through unchanged. Regression guard: the
    // legacy /parties/agents endpoint hid these rows behind a partyType filter
    // and the Unit "in-charge" picker couldn't see admins/managers.
    mockedRepo.listAssignableMembers.mockResolvedValueOnce([
      { id: "p-agent", displayName: "Aiman", agentLevel: "leader", partyType: "agent", status: "active" },
      { id: "p-admin", displayName: "Aliya (Admin)", agentLevel: null, partyType: "individual", status: "active" },
      { id: "p-mgr", displayName: "Manager Mike", agentLevel: "leader", partyType: "agent", status: "active" },
    ] as never);

    const res = await listAssignableMembersService(session as any, "a", 20);

    expect(res.data).toHaveLength(3);
    // Critical: the admin row (partyType=individual, agentLevel=null) is present.
    const admin = res.data.find((r) => r.id === "p-admin");
    expect(admin).toBeDefined();
    expect(admin?.partyType).toBe("individual");
    // Service must call repo with the org from the session, not hardcoded.
    expect(mockedRepo.listAssignableMembers).toHaveBeenCalledWith("o1", "a", 20, undefined);
  });

  it("defaults take to 20 when caller omits it", async () => {
    mockedRepo.listAssignableMembers.mockResolvedValueOnce([] as never);
    await listAssignableMembersService(session as any, "x", undefined);
    expect(mockedRepo.listAssignableMembers).toHaveBeenCalledWith("o1", "x", 20, undefined);
  });
});

// ── coerceEmptyStringsToNull (unit) ─────────────────────────────────────────
describe("coerceEmptyStringsToNull", () => {
  it("maps empty strings to null on every nullable text column", () => {
    const out = coerceEmptyStringsToNull({
      legalName: "",
      primaryEmail: "",
      primaryPhone: "",
      idType: "",
      idNumber: "",
      nationality: "",
      bankName: "",
      bankAccountHolder: "",
      bankAccountNumber: "",
    });
    expect(out).toEqual({
      legalName: null,
      primaryEmail: null,
      primaryPhone: null,
      idType: null,
      idNumber: null,
      nationality: null,
      bankName: null,
      bankAccountHolder: null,
      bankAccountNumber: null,
    });
  });

  it("leaves non-empty strings untouched", () => {
    const out = coerceEmptyStringsToNull({
      legalName: "Apex Holdings",
      primaryEmail: "ops@apex.com",
    });
    expect(out).toEqual({
      legalName: "Apex Holdings",
      primaryEmail: "ops@apex.com",
    });
  });

  it("does not coerce keys outside the allowlist (e.g. displayName, status)", () => {
    const out = coerceEmptyStringsToNull({
      displayName: "",
      status: "",
      legalName: "",
    });
    // displayName is REQUIRED and never nullable — should remain ""
    expect(out.displayName).toBe("");
    // status uses an enum, never nullable — should remain ""
    expect(out.status).toBe("");
    // legalName IS in the allowlist
    expect(out.legalName).toBeNull();
  });

  it("returns a shallow copy — does not mutate input", () => {
    const input = { legalName: "" };
    const out = coerceEmptyStringsToNull(input);
    expect(input.legalName).toBe(""); // original unchanged
    expect(out.legalName).toBeNull();
  });

  it("preserves values that are already null", () => {
    const out = coerceEmptyStringsToNull({ legalName: null });
    expect(out.legalName).toBeNull();
  });
});

describe("createPortalAccessService", () => {
  const session = { orgId: "org1" };
  const partyId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const input = { email: "agent@example.com", password: "TempPass1!", fullName: "Agent One" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.party.findFirst.mockResolvedValue({ id: partyId });
    mockDb.partyRole.findFirst.mockResolvedValue({ id: "role1", roleType: "agent" });
    mockDb.user.findFirst.mockResolvedValue(null);
    mockDb.user.create.mockResolvedValue({ id: "user-new" });
  });

  it("sets mustChangePassword=true when granting portal access", async () => {
    const res = await createPortalAccessService(session, partyId, input);

    expect(res.ok).toBe(true);
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mustChangePassword: true }),
      }),
    );
  });

  it("returns 404 when party is not found", async () => {
    mockDb.party.findFirst.mockResolvedValue(null);

    const res = await createPortalAccessService(session, partyId, input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("returns 409 when portal access already exists", async () => {
    // first findFirst (party) → found, second (existing user) → found
    mockDb.user.findFirst.mockResolvedValueOnce({ id: "existing-user" });

    const res = await createPortalAccessService(session, partyId, input);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("grants owner portal access with userType 'owner'", async () => {
    mockDb.partyRole.findFirst.mockResolvedValue({ id: "role1", roleType: "owner" });
    const res = await createPortalAccessService(session, partyId, input);
    expect(res.ok).toBe(true);
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userType: "owner" }) }),
    );
  });

  it("still maps tenant role to userType 'tenant'", async () => {
    mockDb.partyRole.findFirst.mockResolvedValue({ id: "role1", roleType: "tenant" });
    const res = await createPortalAccessService(session, partyId, input);
    expect(res.ok).toBe(true);
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userType: "tenant" }) }),
    );
  });
});

// ── getAgentsService — photoUrl injection ────────────────────────────────────

const makeAgent = (overrides: Record<string, unknown> = {}) => ({
  id: "a1", displayName: "Agent A", legalName: null,
  primaryEmail: null, primaryPhone: null,
  nationality: null, isBlacklisted: false, status: "active",
  agentLevel: null, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-02"),
  idType: null, idNumber: null,
  bankName: null, bankAccountHolder: null, bankAccountNumber: null,
  userAccount: null, uplineId: null, upline: null,
  photoKey: null,
  ...overrides,
});

describe("getAgentsService — photoUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes photoUrl=null for agents without a photoKey", async () => {
    mockedRepo.listAgents.mockResolvedValueOnce([makeAgent({ photoKey: null })] as never);

    const result = await getAgentsService({ orgId: "o1" } as never);

    expect(Array.isArray(result)).toBe(true);
    const agents = result as unknown as Array<{ photoUrl: string | null }>;
    expect(agents[0].photoUrl).toBeNull();
  });

  it("includes a signed photoUrl for agents with a photoKey", async () => {
    mockedRepo.listAgents.mockResolvedValueOnce([
      makeAgent({ photoKey: "avatars/parties/a1/photo.jpg" }),
    ] as never);
    vi.mocked(createSignedDownloadUrl).mockResolvedValueOnce("https://signed/photo.jpg");

    const result = await getAgentsService({ orgId: "o1" } as never);

    const agents = result as unknown as Array<{ photoUrl: string | null }>;
    expect(agents[0].photoUrl).toBe("https://signed/photo.jpg");
  });
});

// ── updateTenantService — idType/idNumber + dup-check ────────────────────────

describe("updateTenantService — idType/idNumber fields and dup-check", () => {
  beforeEach(() => vi.clearAllMocks());

  const partyId = "550e8400-e29b-41d4-a716-446655440010";

  it("calls updateParty with idType and idNumber when no dup exists", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    mockedRepo.findPartyByIdNumber.mockResolvedValueOnce(null);
    mockedRepo.updateParty.mockResolvedValueOnce(undefined as never);

    const res = await updateTenantService(session, {
      partyId,
      idType: "ic",
      idNumber: "901010101234",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(200);
    expect(mockedRepo.updateParty).toHaveBeenCalledWith(
      partyId,
      expect.objectContaining({ idType: "ic", idNumber: "901010101234" }),
    );
  });

  it("returns 409 and does NOT call updateParty when idNumber belongs to a different party", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    // findPartyByIdNumber returns a DIFFERENT party
    mockedRepo.findPartyByIdNumber.mockResolvedValueOnce({ id: "other-party-id" } as never);

    const res = await updateTenantService(session, {
      partyId,
      idNumber: "901010101234",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    expect(mockedRepo.updateParty).not.toHaveBeenCalled();
  });

  it("proceeds (self-check) when idNumber belongs to the SAME party being updated", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    // findPartyByIdNumber returns the SAME party id — self-update, not a dup
    mockedRepo.findPartyByIdNumber.mockResolvedValueOnce({ id: partyId } as never);
    mockedRepo.updateParty.mockResolvedValueOnce(undefined as never);

    const res = await updateTenantService(session, {
      partyId,
      idNumber: "901010101234",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(200);
    expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
  });
});

// ── updateOwnerService — idType/idNumber fields ──────────────────────────────

describe("updateOwnerService — idType/idNumber fields", () => {
  beforeEach(() => vi.clearAllMocks());

  const partyId = "550e8400-e29b-41d4-a716-446655440020";

  it("calls updateParty with idType and idNumber when no dup exists", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "role1" } as never);
    // no existing party with this idNumber
    mockedRepo.findPartyByIdNumber.mockResolvedValueOnce(null as never);
    mockedRepo.checkContactUniqueness.mockResolvedValueOnce(null as never);
    mockedRepo.updateParty.mockResolvedValueOnce({} as never);

    const res = await updateOwnerService(session, {
      partyId,
      idType: "passport",
      idNumber: "A12345678",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(200);
    expect(mockedRepo.findPartyByIdNumber).toHaveBeenCalledWith("o1", "A12345678");
    expect(mockedRepo.updateParty).toHaveBeenCalledWith(
      partyId,
      expect.objectContaining({ idType: "passport", idNumber: "A12345678" }),
    );
  });
});

// ── getOwnersService — IC masking (PDPA) ─────────────────────────────────────

describe("getOwnersService — IC masking (PDPA)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("masks idNumber to last-4 and excludes raw idNumber from list rows", async () => {
    mockedRepo.listOwners.mockResolvedValueOnce([
      {
        id: "o3", displayName: "Owner Three", legalName: null,
        primaryEmail: null, primaryPhone: null,
        nationality: "MY", idType: "ic", idNumber: "901010145678",
        bankName: null, bankAccountHolder: null, bankAccountNumber: null,
        isBlacklisted: false, status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ] as never);

    const rows = await getOwnersService(session);

    expect(rows).toHaveLength(1);
    // Must have the masked IC field
    expect(rows[0]).toMatchObject({ idNumberMasked: "••••5678" });
    // Must NOT leak the raw IC
    expect("idNumber" in (rows[0] as object)).toBe(false);
  });

  it("produces idNumberMasked: null when idNumber is null", async () => {
    mockedRepo.listOwners.mockResolvedValueOnce([
      {
        id: "o4", displayName: "Owner Four", legalName: null,
        primaryEmail: null, primaryPhone: null,
        nationality: null, idType: null, idNumber: null,
        bankName: null, bankAccountHolder: null, bankAccountNumber: null,
        isBlacklisted: false, status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ] as never);

    const rows = await getOwnersService(session);

    expect(rows[0]).toMatchObject({ idNumberMasked: null });
    expect("idNumber" in (rows[0] as object)).toBe(false);
  });
});

// ── getTenantsService — IC masking (PDPA) ────────────────────────────────────

describe("getTenantsService — IC masking (PDPA)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("masks idNumber to last-4 and excludes raw idNumber from list rows", async () => {
    mockedRepo.listTenants.mockResolvedValueOnce([
      {
        id: "t3", displayName: "Tenant Three", legalName: null,
        primaryEmail: null, primaryPhone: null,
        nationality: "MY", occupation: null, employerName: null,
        monthlyIncome: null, idType: "ic", idNumber: "901010145678",
        isBlacklisted: false, status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        _count: { reservationsCreatedFrom: 0 },
      },
    ] as never);

    const rows = await getTenantsService(session);

    expect(rows).toHaveLength(1);
    // Must have the masked IC field
    expect(rows[0]).toMatchObject({ idNumberMasked: "••••5678" });
    // Must NOT leak the raw IC
    expect("idNumber" in (rows[0] as object)).toBe(false);
  });

  it("produces idNumberMasked: null when idNumber is null", async () => {
    mockedRepo.listTenants.mockResolvedValueOnce([
      {
        id: "t4", displayName: "Tenant Four", legalName: null,
        primaryEmail: null, primaryPhone: null,
        nationality: null, occupation: null, employerName: null,
        monthlyIncome: null, idType: null, idNumber: null,
        isBlacklisted: false, status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        _count: { reservationsCreatedFrom: 0 },
      },
    ] as never);

    const rows = await getTenantsService(session);

    expect(rows[0]).toMatchObject({ idNumberMasked: null });
    expect("idNumber" in (rows[0] as object)).toBe(false);
  });
});

// ── getTenantsService — units projection (property/unit search) ─────────────

describe("getTenantsService — units projection", () => {
  const base = {
    id: "t1", displayName: "Tenant One", legalName: null,
    primaryEmail: null, primaryPhone: null, nationality: null,
    occupation: null, employerName: null, monthlyIncome: null,
    idType: null, idNumber: null, isBlacklisted: false, status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    _count: { reservationsCreatedFrom: 0 },
  };

  it("maps active tenancies to units { propertyName, unitCode }", async () => {
    mockedRepo.listTenants.mockResolvedValueOnce([
      { ...base, tenancies: [
        { property: { name: "Tower B" }, unit: { apartment: { unitCode: "B-08-08" } } },
      ] },
    ] as never);

    const rows = await getTenantsService(session);

    expect(rows[0]).toMatchObject({ units: [{ propertyName: "Tower B", unitCode: "B-08-08" }] });
  });

  it("dedupes two active tenancies resolving to the same property+unit into one entry", async () => {
    mockedRepo.listTenants.mockResolvedValueOnce([
      { ...base, tenancies: [
        { property: { name: "Tower B" }, unit: { apartment: { unitCode: "B-08-08" } } },
        { property: { name: "Tower B" }, unit: { apartment: { unitCode: "B-08-08" } } },
      ] },
    ] as never);

    const rows = await getTenantsService(session);

    expect(rows[0].units).toEqual([{ propertyName: "Tower B", unitCode: "B-08-08" }]);
  });

  it("returns units: [] when the tenant has no active tenancy", async () => {
    mockedRepo.listTenants.mockResolvedValueOnce([{ ...base, tenancies: [] }] as never);

    const rows = await getTenantsService(session);

    expect(rows[0].units).toEqual([]);
  });

  it("does NOT leak the raw tenancies relation into the payload", async () => {
    mockedRepo.listTenants.mockResolvedValueOnce([
      { ...base, tenancies: [
        { property: { name: "X" }, unit: { apartment: { unitCode: "Y" } } },
      ] },
    ] as never);

    const rows = await getTenantsService(session);

    expect("tenancies" in rows[0]).toBe(false);
  });
});

// ── getOwnerDetailService portalUser ─────────────────────────────────────────

// ── getTenantDetailService portalUser ─────────────────────────────────────────

describe("getTenantDetailService portalUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findTenantDetail.mockResolvedValue({
      id: "t1", displayName: "T", legalName: null, primaryEmail: "t@x.com", primaryPhone: null,
      whatsappPhone: null, idType: null, idNumber: null, nationality: null, gender: null,
      dateOfBirth: null, occupation: null, employerName: null, employerAddress: null,
      monthlyIncome: null, emergencyContactName: null, emergencyContactPhone: null,
      emergencyContactRelation: null, isBlacklisted: false, blacklistReason: null,
      status: "active", createdAt: new Date(),
    } as never);
    mockedRepo.hasActiveTenancy.mockResolvedValue(false);
  });

  it("returns portalUser=null when no login exists", async () => {
    mockedRepo.findPortalUserByParty.mockResolvedValue(null);
    const res = await getTenantDetailService(session, "t1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.portalUser).toBeNull();
  });

  it("returns portalUser with ISO dates when a login exists", async () => {
    const now = new Date();
    mockedRepo.findPortalUserByParty.mockResolvedValue({
      email: "t@x.com", status: "active", lastLoginAt: null, updatedAt: now,
    } as never);
    const res = await getTenantDetailService(session, "t1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.portalUser).toEqual({
        email: "t@x.com", status: "active", lastLoginAt: null, updatedAt: now.toISOString(),
      });
    }
  });
});

// ── getTenantDetailService hasActiveTenancy ───────────────────────────────────

describe("getTenantDetailService hasActiveTenancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findTenantDetail.mockResolvedValue({
      id: "t1", displayName: "T", legalName: null, primaryEmail: null, primaryPhone: null,
      whatsappPhone: null, idType: null, idNumber: null, nationality: null, gender: null,
      dateOfBirth: null, occupation: null, employerName: null, employerAddress: null,
      monthlyIncome: null, emergencyContactName: null, emergencyContactPhone: null,
      emergencyContactRelation: null, isBlacklisted: false, blacklistReason: null,
      status: "active", createdAt: new Date(),
    } as never);
    mockedRepo.findPortalUserByParty.mockResolvedValue(null);
  });

  it("reports hasActiveTenancy=false when none", async () => {
    mockedRepo.hasActiveTenancy.mockResolvedValue(false);
    const res = await getTenantDetailService(session, "t1");
    if (res.ok) expect(res.data.hasActiveTenancy).toBe(false);
  });

  it("reports hasActiveTenancy=true when an active tenancy exists", async () => {
    mockedRepo.hasActiveTenancy.mockResolvedValue(true);
    const res = await getTenantDetailService(session, "t1");
    if (res.ok) expect(res.data.hasActiveTenancy).toBe(true);
  });
});

// ── updateOwnerService extended fields ───────────────────────────────────────

describe("updateOwnerService extended fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findRole.mockResolvedValue({ id: "r1" } as never);
    mockedRepo.checkContactUniqueness.mockResolvedValue(null);
    mockedRepo.updateParty.mockResolvedValue(undefined as never);
  });

  it("writes gender, dateOfBirth (as Date), and whatsappPhone", async () => {
    await updateOwnerService(session, {
      partyId: "11111111-1111-1111-1111-111111111111",
      gender: "male", dateOfBirth: "1990-01-15", whatsappPhone: "+60123456789",
    } as never);
    expect(mockedRepo.updateParty).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.objectContaining({
        gender: "male",
        dateOfBirth: new Date("1990-01-15"),
        whatsappPhone: "+60123456789",
      }),
    );
  });
});

// ── updateTenantService extended fields ──────────────────────────────────────

describe("updateTenantService extended fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findRole.mockResolvedValue({ id: "r1" } as never);
    mockedRepo.findPartyByIdNumber.mockResolvedValue(null);
    mockedRepo.checkContactUniqueness.mockResolvedValue(null);
    mockedRepo.updateParty.mockResolvedValue(undefined as never);
  });

  it("writes gender, dateOfBirth, whatsappPhone, and emergency contact", async () => {
    await updateTenantService(session, {
      partyId: "22222222-2222-2222-2222-222222222222",
      gender: "female", dateOfBirth: "1995-06-01", whatsappPhone: "+60111222333",
      emergencyContactName: "Mom", emergencyContactPhone: "+60199", emergencyContactRelation: "parent",
    } as never);
    expect(mockedRepo.updateParty).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222",
      expect.objectContaining({
        gender: "female",
        dateOfBirth: new Date("1995-06-01"),
        whatsappPhone: "+60111222333",
        emergencyContactName: "Mom",
        emergencyContactPhone: "+60199",
        emergencyContactRelation: "parent",
      }),
    );
  });
});

// ── omit-key PATCH contract (negative path) ──────────────────────────────────

describe("omit-key PATCH contract — updateOwnerService", () => {
  const partyId = "550e8400-e29b-41d4-a716-446655440030";

  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findRole.mockResolvedValue({ id: "r1" } as never);
    mockedRepo.checkContactUniqueness.mockResolvedValue(null);
    mockedRepo.updateParty.mockResolvedValue(undefined as never);
  });

  it("does NOT write dateOfBirth or whatsappPhone when client omits them (only gender sent)", async () => {
    await updateOwnerService(session, {
      partyId,
      gender: "female",
    } as never);
    expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    const data = mockedRepo.updateParty.mock.calls[0]![1] as Record<string, unknown>;
    expect(data).toHaveProperty("gender", "female");
    expect(data).not.toHaveProperty("dateOfBirth");
    expect(data).not.toHaveProperty("whatsappPhone");
  });
});

describe("omit-key PATCH contract — updateTenantService", () => {
  const partyId = "550e8400-e29b-41d4-a716-446655440031";

  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findRole.mockResolvedValue({ id: "r1" } as never);
    mockedRepo.findPartyByIdNumber.mockResolvedValue(null);
    mockedRepo.checkContactUniqueness.mockResolvedValue(null);
    mockedRepo.updateParty.mockResolvedValue(undefined as never);
  });

  it("does NOT write dateOfBirth, whatsappPhone, or emergencyContactName when client omits them (only gender sent)", async () => {
    await updateTenantService(session, {
      partyId,
      gender: "female",
    } as never);
    expect(mockedRepo.updateParty).toHaveBeenCalledTimes(1);
    const data = mockedRepo.updateParty.mock.calls[0]![1] as Record<string, unknown>;
    expect(data).toHaveProperty("gender", "female");
    expect(data).not.toHaveProperty("dateOfBirth");
    expect(data).not.toHaveProperty("whatsappPhone");
    expect(data).not.toHaveProperty("emergencyContactName");
  });
});

// ── getOwnerDetailService portalUser ─────────────────────────────────────────

describe("getOwnerDetailService portalUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRepo.findOwnerDetail.mockResolvedValue({
      id: "p1", displayName: "O", legalName: null, primaryEmail: "o@x.com", primaryPhone: null,
      whatsappPhone: null, idType: null, idNumber: null, nationality: null, gender: null,
      dateOfBirth: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null,
      isBlacklisted: false, blacklistReason: null, status: "active", createdAt: new Date(),
    } as never);
    mockedRepo.findUnitsOwned.mockResolvedValue([]);
  });

  it("returns portalUser=null when no login exists", async () => {
    mockedRepo.findPortalUserByParty.mockResolvedValue(null);
    const res = await getOwnerDetailService(session, "p1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.portalUser).toBeNull();
  });

  it("returns portalUser with ISO dates when a login exists", async () => {
    const now = new Date();
    mockedRepo.findPortalUserByParty.mockResolvedValue({
      email: "o@x.com", status: "active", lastLoginAt: null, updatedAt: now,
    } as never);
    const res = await getOwnerDetailService(session, "p1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.portalUser).toEqual({
        email: "o@x.com", status: "active", lastLoginAt: null, updatedAt: now.toISOString(),
      });
    }
  });
});
