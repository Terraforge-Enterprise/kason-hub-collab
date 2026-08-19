import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { getAgentDetailService } from "../parties.service";
import { partiesRoutes } from "../parties.routes";
import * as repo from "../parties.repository";

// Minimal `@kason/db` mock — role-visibility tests never touch Prisma.
vi.mock("@kason/db", () => ({
  getDb: () => ({
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    user: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  }),
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
      code: string;
      constructor(msg: string, { code }: { code: string }) {
        super(msg);
        this.code = code;
      }
    },
  },
}));

// Mock just the two repository functions the service-level tests exercise.
// `importActual` + spread keeps the other exports real so route-level
// integration continues to import the same module graph.
vi.mock("../parties.repository", async () => {
  const actual = await vi.importActual<typeof import("../parties.repository")>("../parties.repository");
  return {
    ...actual,
    findRole: vi.fn(),
    getAgentDetail: vi.fn(),
  };
});

const mockedRepo = vi.mocked(repo);

const editorSession = { userId: "u-ed", orgId: "o1", role: "editor" as const };
const managerSession = { userId: "u-mg", orgId: "o1", role: "manager" as const };
const adminSession = { userId: "u-ad", orgId: "o1", role: "admin" as const };

const fullAgentDetail = {
  id: "a1",
  displayName: "Agent One",
  legalName: "Agent One Ltd",
  primaryEmail: "a@b.c",
  primaryPhone: null,
  idType: null,
  idNumber: null,
  nationality: null,
  agentLevel: "leader",
  bank: { name: null, accountHolder: null, accountNumber: null },
  status: "active",
  isBlacklisted: false,
  blacklistReason: null,
  portalUser: null,
  claimStats: {
    submitted: 1,
    approved: 2,
    paid: 3,
    rejected: 0,
    totalPaidCommission: 1234,
  },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-02T00:00:00.000Z",
};

describe("parties role-visibility — getAgentDetailService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editor: response omits claimStats (commission-derived)", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "pr1" } as never);
    mockedRepo.getAgentDetail.mockResolvedValueOnce(fullAgentDetail as never);

    const res = await getAgentDetailService(editorSession, "a1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("claimStats" in res.data).toBe(false);
      // Non-commission identity/status fields remain.
      expect(res.data.id).toBe("a1");
      expect(res.data.displayName).toBe("Agent One");
      expect(res.data.status).toBe("active");
    }
  });

  it("manager: response includes claimStats with totalPaidCommission", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "pr1" } as never);
    mockedRepo.getAgentDetail.mockResolvedValueOnce(fullAgentDetail as never);

    const res = await getAgentDetailService(managerSession, "a1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("claimStats" in res.data).toBe(true);
      const full = res.data as typeof res.data & { claimStats: { totalPaidCommission: number; paid: number } };
      expect(full.claimStats.totalPaidCommission).toBe(1234);
      expect(full.claimStats.paid).toBe(3);
    }
  });

  it("admin: response includes claimStats (same as manager)", async () => {
    mockedRepo.findRole.mockResolvedValueOnce({ id: "pr1" } as never);
    mockedRepo.getAgentDetail.mockResolvedValueOnce(fullAgentDetail as never);

    const res = await getAgentDetailService(adminSession, "a1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("claimStats" in res.data).toBe(true);
    }
  });

  it("editor: 404 still short-circuits before strip", async () => {
    mockedRepo.findRole.mockResolvedValueOnce(null as never);
    const res = await getAgentDetailService(editorSession, "a1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

// ── Route-level gating ──────────────────────────────────────────────────────
//
// The parties module is currently gated at `requireRole("manager")` for every
// route (see `partiesRoutes.use("*", requireRole("manager"))`). That means:
//   - editor → 403 on ALL party endpoints (list/get/mutate)
//   - manager → allowed for reads + set-inactive/blacklist
//   - admin → allowed everywhere (manager rank or higher)
//
// There is no dedicated "DELETE party" route today. The only DELETE is
// `/:partyId/portal-access`, which is a scoped portal-user revoke (the
// equivalent of "deactivate portal user") and per task spec stays at
// manager+. The admin-only DELETE gate from the task description is
// therefore a no-op today; these tests document the current, correct
// behaviour so any future DELETE-party route has to be explicit about
// its gating.

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", partiesRoutes);
  return app;
}

const adminSessionPayload: SessionPayload = { userId: "u1", orgId: "o1", role: "admin", userType: "operator" };
const managerSessionPayload: SessionPayload = { userId: "u2", orgId: "o1", role: "manager", userType: "operator" };
const editorSessionPayload: SessionPayload = { userId: "u3", orgId: "o1", role: "editor", userType: "operator" };

describe("parties route gating", () => {
  beforeEach(() => vi.clearAllMocks());

  // Any DELETE under /parties is blocked for editors at the module-level
  // `requireRole("manager")` gate — so a future "DELETE /:partyId" route
  // (if someone adds one without a per-route gate) would still reject
  // editors. We assert 403 here rather than 404 specifically to prove
  // the gate runs before Hono's route resolution.
  it("editor: DELETE /<any-path> returns 403 (module-level manager gate)", async () => {
    const res = await makeApp(editorSessionPayload).request("/some-party-id", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  // Revoke-portal-access is the destructive-ish party route that exists
  // today. Per task spec it stays at manager+ (NOT tightened to admin).
  // Admin + manager should be allowed past the gate; editor blocked.
  it("admin: can pass gate for DELETE /:partyId/portal-access", async () => {
    const res = await makeApp(adminSessionPayload).request("/p1/portal-access", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: "2026-04-01T00:00:00.000Z" }),
    });
    // We only care that the role gate did NOT block with 403.
    // (The call reaches the service which will 404 because the mocked
    // DB has no user row — that's fine; the gate passed.)
    expect(res.status).not.toBe(403);
  });

  it("manager: can pass gate for DELETE /:partyId/portal-access", async () => {
    const res = await makeApp(managerSessionPayload).request("/p1/portal-access", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: "2026-04-01T00:00:00.000Z" }),
    });
    expect(res.status).not.toBe(403);
  });

  it("editor: cannot pass gate for DELETE /:partyId/portal-access (403)", async () => {
    const res = await makeApp(editorSessionPayload).request("/p1/portal-access", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: "2026-04-01T00:00:00.000Z" }),
    });
    expect(res.status).toBe(403);
  });
});
