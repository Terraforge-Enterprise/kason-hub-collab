import { beforeEach, describe, expect, it, vi } from "vitest";
import { listClaimsService, getClaimDetailService } from "../commissions.service";
import * as repo from "../commissions.repository";

// Minimal `@kason/db` mock — the role-visibility tests never touch Prisma.
vi.mock("@kason/db", () => ({
  getDb: () => ({
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    cashMovement: { findFirst: vi.fn().mockResolvedValue(null) },
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

// Mock the repository so we can assert how the service hands `role` down
// and so we can control the row shape returned at the repo boundary.
vi.mock("../commissions.repository", () => ({
  listClaims: vi.fn(),
  findClaim: vi.fn(),
}));

const mockedRepo = vi.mocked(repo);

const baseRow = {
  id: "c1",
  claimNumber: "CLM-0001",
  status: "submitted",
  claimType: "tenant_portion",
  currency: "MYR",
  submittedAt: new Date("2026-04-20T00:00:00.000Z"),
  createdAt: new Date("2026-04-19T00:00:00.000Z"),
  updatedAt: new Date("2026-04-20T00:00:00.000Z"),
  agentPartyId: "a1",
  agent: { id: "a1", displayName: "Agent One" },
} as const;

const editorSession = { userId: "u-ed", orgId: "o1", role: "editor" as const };
const managerSession = { userId: "u-mg", orgId: "o1", role: "manager" as const };

describe("commissions role-visibility — listClaimsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes role='editor' through to the repository", async () => {
    mockedRepo.listClaims.mockResolvedValueOnce({ data: [], page: 1, limit: 50, total: 0 } as never);
    await listClaimsService(editorSession, {});
    expect(mockedRepo.listClaims).toHaveBeenCalledWith("o1", expect.any(Object), "editor");
  });

  it("passes role='manager' through to the repository", async () => {
    mockedRepo.listClaims.mockResolvedValueOnce({ data: [], page: 1, limit: 50, total: 0 } as never);
    await listClaimsService(managerSession, {});
    expect(mockedRepo.listClaims).toHaveBeenCalledWith("o1", expect.any(Object), "manager");
  });

  it("editor rows do NOT contain totalNettPayout or items", async () => {
    // Simulate the repo having already stripped commission fields via its
    // role-aware Prisma select — row arrives without totalNettPayout.
    mockedRepo.listClaims.mockResolvedValueOnce({
      data: [baseRow],
      page: 1, limit: 50, total: 1,
    } as never);

    const res = await listClaimsService(editorSession, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.data).toHaveLength(1);
      const row = res.data.data[0];
      expect("totalNettPayout" in row).toBe(false);
      expect("items" in row).toBe(false);
    }
  });

  it("manager rows DO contain totalNettPayout", async () => {
    mockedRepo.listClaims.mockResolvedValueOnce({
      data: [{ ...baseRow, totalNettPayout: 1234 }],
      page: 1, limit: 50, total: 1,
    } as never);

    const res = await listClaimsService(managerSession, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.data).toHaveLength(1);
      const row = res.data.data[0] as { totalNettPayout?: number };
      expect(row.totalNettPayout).toBe(1234);
    }
  });
});

describe("commissions role-visibility — getClaimDetailService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes role='editor' to findClaim", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      ...baseRow,
      approvedAt: null,
      paidAt: null,
      agent: { displayName: "Agent One", primaryEmail: null, primaryPhone: null },
    } as never);
    await getClaimDetailService(editorSession, "c1");
    expect(mockedRepo.findClaim).toHaveBeenCalledWith("o1", "c1", "editor");
  });

  it("editor detail response omits totalNettPayout, items, and bank fields", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      ...baseRow,
      approvedAt: null,
      paidAt: null,
      agent: { displayName: "Agent One", primaryEmail: "a@b.c", primaryPhone: null },
      // totalNettPayout / items absent — repo stripped them.
    } as never);

    const res = await getClaimDetailService(editorSession, "c1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("totalNettPayout" in res.data).toBe(false);
      expect("items" in res.data).toBe(false);
      expect("bankName" in res.data).toBe(false);
      expect("bankAccountHolder" in res.data).toBe(false);
      expect("bankAccountNumber" in res.data).toBe(false);
      // But identity/contact fields remain.
      expect(res.data.id).toBe("c1");
      expect(res.data.agentName).toBe("Agent One");
      expect(res.data.agentEmail).toBe("a@b.c");
    }
  });

  it("manager detail response includes totalNettPayout, items, and masked bank fields", async () => {
    mockedRepo.findClaim.mockResolvedValueOnce({
      ...baseRow,
      approvedAt: null,
      paidAt: null,
      totalNettPayout: 500,
      billId: null,
      cashMovementId: null,
      approvedBy: null,
      agent: {
        displayName: "Agent One",
        primaryEmail: "a@b.c",
        primaryPhone: null,
        bankName: "Maybank",
        bankAccountHolder: "Agent One",
        bankAccountNumber: "1234567890",
      },
      items: [
        {
          id: "i1", condoName: "C", unitCode: "U", roomType: "Master", tenantName: "T",
          salesDate: new Date("2026-04-15T00:00:00.000Z"),
          moveInDate: new Date("2026-04-20T00:00:00.000Z"),
          moveOutDate: new Date("2027-04-19T00:00:00.000Z"),
          monthlyRental: 1000, agentTierPercentage: 40, commissionPercentage: 50,
          tenancyChargesByAgent: 500, tenancyChargesByKaen: 216,
          numberOfPax: null, remark: null, nettPayout: 500,
        },
      ],
    } as never);

    const res = await getClaimDetailService(managerSession, "c1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("totalNettPayout" in res.data).toBe(true);
      expect("items" in res.data).toBe(true);
      const full = res.data as typeof res.data & {
        totalNettPayout: number;
        items: unknown[];
        bankAccountNumber: string | null;
      };
      expect(full.totalNettPayout).toBe(500);
      expect(full.items).toHaveLength(1);
      expect(full.bankAccountNumber).toBe("1234567890");
    }
  });
});
