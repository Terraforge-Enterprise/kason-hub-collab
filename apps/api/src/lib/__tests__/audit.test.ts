/**
 * Tests for recordAudit transactional helper.
 *
 * Two modes:
 *  1. Default (mocked) — verifies the helper delegates correctly to
 *     `tx.auditLog.create` with the right payload, and that a throw
 *     inside the outer transaction callback propagates (so callers can
 *     rely on Prisma's own rollback). Runs on every `npx vitest run`.
 *  2. Integration (RUN_INTEGRATION=1) — exercises real Postgres rollback.
 *     Requires local Postgres with the AuditLog migration applied.
 *     Skipped by default.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("recordAudit (unit — mocked tx)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an audit row via the provided TransactionClient", async () => {
    const createMock = vi.fn().mockResolvedValue({ id: "audit-1" });
    const tx = { auditLog: { create: createMock } };

    const { recordAudit } = await import("../audit");

    await recordAudit(tx as never, {
      organizationId: "org-1",
      actorUserId: "user-1",
      actorRole: "manager",
      action: "claim.approve",
      entityType: "CommissionClaim",
      entityId: "claim-9",
      diff: { before: { status: "submitted" }, after: { status: "approved" } },
      ip: "1.2.3.4",
      userAgent: "test",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        actorUserId: "user-1",
        actorRole: "manager",
        action: "claim.approve",
        entityType: "CommissionClaim",
        entityId: "claim-9",
        diff: { before: { status: "submitted" }, after: { status: "approved" } },
        ip: "1.2.3.4",
        userAgent: "test",
      },
    });
  });

  it("propagates errors thrown inside the outer transaction (caller controls rollback)", async () => {
    const createMock = vi.fn().mockResolvedValue({ id: "audit-1" });
    const tx = { auditLog: { create: createMock } };

    const { recordAudit } = await import("../audit");

    // Simulate the caller's transaction callback: write audit, then throw.
    // Prisma will roll back both in a real $transaction; here we just
    // verify the helper does not swallow the error.
    const outer = async () => {
      await recordAudit(tx as never, {
        organizationId: "org-1",
        actorUserId: "user-1",
        actorRole: "admin",
        action: "test.fail",
        entityType: "Test",
        entityId: "x",
      });
      throw new Error("boom");
    };

    await expect(outer()).rejects.toThrow("boom");
    // The helper itself did write via the tx — Prisma would then undo it
    // on rollback. We do not assert "no create call" because the semantics
    // are: helper writes through tx; rollback is Prisma's responsibility.
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Integration tests — real Postgres, real $transaction, real rollback.
 * Run with:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://..." \
 *     npx vitest run src/lib/__tests__/audit.test.ts
 */
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

dn("recordAudit (integration — real $transaction)", () => {
  type PrismaLike = {
    organization: { upsert: (args: unknown) => Promise<unknown> };
    user: { upsert: (args: unknown) => Promise<unknown> };
    auditLog: {
      deleteMany: (args: unknown) => Promise<unknown>;
      findMany: (args: unknown) => Promise<Array<{ action: string; diff: unknown }>>;
    };
    $transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
    $disconnect: () => Promise<void>;
  };

  // Lazy-require to avoid loading the real @kason/db when RUN is false —
  // the default vitest env aliases @kason/db to a mock that doesn't
  // expose a real Prisma client. With RUN_INTEGRATION=1 the alias is off
  // and getDb() returns a properly-configured PrismaClient (pg adapter,
  // SSL handling, etc.) from packages/db.
  let prisma: PrismaLike;

  beforeAll(async () => {
    const { getDb } = await import("@kason/db");
    prisma = getDb() as unknown as PrismaLike;

    await prisma.organization.upsert({
      where: { id: ORG_ID },
      create: {
        id: ORG_ID,
        name: "audit-test-org",
        slug: "audit-test",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
      update: {},
    });
    await prisma.user.upsert({
      where: { id: USER_ID },
      create: {
        id: USER_ID,
        organizationId: ORG_ID,
        email: "audit-test@example.com",
        fullName: "Audit Test",
        passwordHash: "x",
        status: "active",
        role: "admin",
        userType: "operator",
      },
      update: {},
    });
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: ORG_ID } });
  });

  it("writes an audit row inside an outer transaction", async () => {
    const { recordAudit } = await import("../audit");
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx as never, {
        organizationId: ORG_ID,
        actorUserId: USER_ID,
        actorRole: "manager",
        action: "claim.approve",
        entityType: "CommissionClaim",
        entityId: "00000000-0000-0000-0000-000000000009",
        diff: { before: { status: "submitted" }, after: { status: "approved" } },
        ip: "1.2.3.4",
        userAgent: "test",
      });
    });

    const rows = await prisma.auditLog.findMany({ where: { organizationId: ORG_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("claim.approve");
    expect(rows[0].diff).toMatchObject({ after: { status: "approved" } });
  });

  it("rolls back when the outer transaction fails", async () => {
    const { recordAudit } = await import("../audit");
    await expect(
      prisma.$transaction(async (tx) => {
        await recordAudit(tx as never, {
          organizationId: ORG_ID,
          actorUserId: USER_ID,
          actorRole: "admin",
          action: "test.fail",
          entityType: "Test",
          entityId: "x",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await prisma.auditLog.findMany({ where: { organizationId: ORG_ID } });
    expect(rows).toHaveLength(0);
  });
});
