import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = { party: { findFirst: vi.fn() } };
vi.mock("@kason/db", () => ({ getDb: vi.fn(() => mockDb) }));

import { checkContactUniqueness } from "../parties.repository";

beforeEach(() => { mockDb.party.findFirst.mockReset(); });

describe("checkContactUniqueness", () => {
  it("flags a duplicate phone with the conflicting party", async () => {
    mockDb.party.findFirst
      .mockResolvedValueOnce(null) // email check — no conflict
      .mockResolvedValueOnce({ id: "p2", displayName: "Tan Wei Ming" }); // phone check — hit
    const hit = await checkContactUniqueness("org1", { email: "unique@example.com", phone: "60123456789" });
    expect(hit).toEqual({ field: "phone", party: { id: "p2", displayName: "Tan Wei Ming" } });
  });

  it("ignores self via excludePartyId and empty contacts", async () => {
    mockDb.party.findFirst.mockResolvedValue(null);
    const hit = await checkContactUniqueness("org1", { email: "", phone: null, excludePartyId: "p1" });
    expect(hit).toBeNull();
    expect(mockDb.party.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Service-level: createTenantService returns 409 when contact conflict found
// Approach: mock parties.repository (spreading actual so checkContactUniqueness
// stays real → it calls through to mockDb set up above), override only the
// I/O functions we need to control (findPartyByIdNumber, findRole, createTenant).
// ---------------------------------------------------------------------------

const mockRepo = vi.hoisted(() => ({
  findPartyByIdNumber: vi.fn().mockResolvedValue(null),
  isContactUniqueViolation: vi.fn().mockReturnValue(false),
  findRole: vi.fn(),
  createTenant: vi.fn(),
  createOwner: vi.fn(),
}));

vi.mock("../parties.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parties.repository")>();
  return {
    ...actual,
    findPartyByIdNumber: mockRepo.findPartyByIdNumber,
    isContactUniqueViolation: mockRepo.isContactUniqueViolation,
    findRole: mockRepo.findRole,
    createTenant: mockRepo.createTenant,
    createOwner: mockRepo.createOwner,
    // checkContactUniqueness is NOT overridden — it uses the real impl,
    // which calls mockDb.party.findFirst (mocked at the top of this file).
  };
});

import { createOwnerService, createTenantService, updateTenantService } from "../parties.service";

const session = { orgId: "org1", userId: "u1", role: "admin" as const };

describe("createTenantService contact uniqueness", () => {
  beforeEach(() => {
    mockRepo.findPartyByIdNumber.mockResolvedValue(null);
    mockRepo.createTenant.mockReset();
    mockDb.party.findFirst.mockReset();
  });

  it("returns 409 with a friendly message when checkContactUniqueness finds a phone conflict", async () => {
    // checkContactUniqueness will query for phone → simulate a hit
    mockDb.party.findFirst.mockResolvedValueOnce({ id: "p9", displayName: "Ahmad Razali" });
    const result = await createTenantService(session, {
      displayName: "New Tenant",
      primaryPhone: "60123456789",
    });
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(409);
    expect((result as { error: string }).error).toMatch(/phone number/);
    expect((result as { error: string }).error).toMatch(/Ahmad Razali/);
    expect(mockRepo.createTenant).not.toHaveBeenCalled();
  });

  it("tags primaryEmail in fieldErrors on an email conflict so the client reddens that field", async () => {
    // checkContactUniqueness queries email FIRST → simulate a hit on that call.
    mockDb.party.findFirst.mockResolvedValueOnce({ id: "p9", displayName: "Daniel Tan" });
    const result = await createTenantService(session, {
      displayName: "New Tenant",
      primaryEmail: "daniel@example.com",
      primaryPhone: null,
    });
    expect(result.ok).toBe(false);
    expect((result as { fieldErrors?: Record<string, string> }).fieldErrors).toEqual({
      primaryEmail: expect.stringContaining("Daniel Tan"),
    });
  });

  it("tags idNumber in fieldErrors when the IC is already registered (tenant)", async () => {
    mockRepo.findPartyByIdNumber.mockResolvedValue({ id: "existing-party" });
    const result = await createTenantService(session, {
      displayName: "New Tenant",
      idNumber: "900101-10-1234",
      primaryPhone: null,
    });
    expect(result.ok).toBe(false);
    expect((result as { fieldErrors?: Record<string, string> }).fieldErrors).toEqual({
      idNumber: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// Task A2 (#3.1): createOwnerService had NO idNumber dup-check at all (unlike
// its tenant sibling above and updateOwnerService, both of which already
// guard on findPartyByIdNumber). Two owners could silently share an IC. This
// mirrors the tenant-create pattern exactly, with no self-exclusion (there is
// no self on create). The dup-check must run org-wide (not owner-scoped)
// because findPartyByIdNumber has no partyType filter — a duplicate could be
// an existing tenant or agent, hence the neutral error message (never
// "Owner ID/passport already exists").
// ---------------------------------------------------------------------------
describe("createOwnerService IC uniqueness (task A2, #3.1)", () => {
  beforeEach(() => {
    mockRepo.findPartyByIdNumber.mockReset().mockResolvedValue(null);
    mockRepo.createOwner.mockReset();
    mockDb.party.findFirst.mockReset();
  });

  it("creates the owner and looks up the IC when idNumber is unique", async () => {
    mockRepo.createOwner.mockResolvedValue({ id: "owner-1", displayName: "New Owner" });
    const result = await createOwnerService(session, {
      displayName: "New Owner",
      primaryPhone: null,
      idNumber: "900101-01-1234",
    });
    expect(mockRepo.findPartyByIdNumber).toHaveBeenCalledWith("org1", "900101-01-1234");
    expect(result.ok).toBe(true);
    expect((result as { status: number }).status).toBe(201);
    expect(mockRepo.createOwner).toHaveBeenCalled();
  });

  it("owner create rejects duplicate IC", async () => {
    // The dup lookup returns only {id} (no partyType) — it cannot know, and
    // must not care, whether the matched party is an existing owner, tenant,
    // or agent. Hence the neutral message assertion below.
    mockRepo.findPartyByIdNumber.mockResolvedValue({ id: "existing-party-1" });
    const result = await createOwnerService(session, {
      displayName: "New Owner",
      primaryPhone: null,
      idNumber: "900101-01-1234",
    });
    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(409);
    expect((result as { error: string }).error).toBe(
      "This ID/passport number is already registered.",
    );
    expect(mockRepo.createOwner).not.toHaveBeenCalled();
  });

  it("skips the IC lookup when idNumber is omitted", async () => {
    mockRepo.createOwner.mockResolvedValue({ id: "owner-2", displayName: "No IC Owner" });
    const result = await createOwnerService(session, { displayName: "No IC Owner", primaryPhone: null });
    expect(mockRepo.findPartyByIdNumber).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(mockRepo.createOwner).toHaveBeenCalled();
  });

  it("owner: tags primaryEmail in fieldErrors on an email conflict", async () => {
    // idNumber lookup returns null (beforeEach); email check is findFirst #1.
    mockDb.party.findFirst.mockResolvedValueOnce({ id: "p3", displayName: "Existing Owner" });
    const result = await createOwnerService(session, {
      displayName: "New Owner",
      primaryEmail: "ops@apex.com",
      primaryPhone: null,
    });
    expect(result.ok).toBe(false);
    expect((result as { fieldErrors?: Record<string, string> }).fieldErrors).toEqual({
      primaryEmail: expect.stringContaining("Existing Owner"),
    });
  });

  it("owner: tags idNumber in fieldErrors when the IC is already registered", async () => {
    mockRepo.findPartyByIdNumber.mockResolvedValue({ id: "existing-party-1" });
    const result = await createOwnerService(session, {
      displayName: "New Owner",
      primaryPhone: null,
      idNumber: "900101-01-1234",
    });
    expect(result.ok).toBe(false);
    expect((result as { fieldErrors?: Record<string, string> }).fieldErrors).toEqual({
      idNumber: expect.any(String),
    });
  });
});

// The Edit dialogs bind fieldErrors too, so the UPDATE pre-checks must carry the
// same field tags as create — otherwise editing a tenant into a duplicate email
// shows a toast but reddens no field.
describe("updateTenantService contact uniqueness (edit path)", () => {
  const TENANT_ID = "11111111-1111-4111-8111-111111111111";
  beforeEach(() => {
    mockRepo.findRole.mockReset().mockResolvedValue({ id: "role-1" });
    mockRepo.findPartyByIdNumber.mockReset().mockResolvedValue(null);
    mockDb.party.findFirst.mockReset();
  });

  it("tags primaryEmail in fieldErrors when the edited email collides", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({ id: "p9", displayName: "Someone Else" });
    const result = await updateTenantService(session, {
      partyId: TENANT_ID,
      primaryEmail: "dup@example.com",
    });
    expect(result.ok).toBe(false);
    expect((result as { fieldErrors?: Record<string, string> }).fieldErrors).toEqual({
      primaryEmail: expect.stringContaining("Someone Else"),
    });
  });
});
