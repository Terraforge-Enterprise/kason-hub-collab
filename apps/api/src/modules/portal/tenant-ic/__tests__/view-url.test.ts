// apps/api/src/modules/portal/tenant-ic/__tests__/view-url.test.ts
import { describe, it, expect, vi } from "vitest";
import { viewUrlForAgent, viewUrlForAdmin } from "../tenant-ic.service";

describe("viewUrlForAgent", () => {
  const mkSession = () => ({ partyId: "party-1", orgId: "org-1", role: "agent" });
  const signView = vi.fn(async (key: string) => ({ viewUrl: `https://v/${key}`, expiresAt: new Date(Date.now() + 5 * 60 * 1000) }));

  it("returns view URL for own pending upload + writes IcAccessLog with viewerScope='agent_self'", async () => {
    const prisma = {
      pendingUpload: {
        findFirst: vi.fn(async () => ({
          id: "pu-1", storageKey: "tenant-ic/org-1/party-1/temp/x/front-y.jpg",
          consumedClaimItemId: null, side: "front",
        })),
      },
      icAccessLog: { create: vi.fn(async () => ({ id: "log-1" })) },
      user: { findFirst: vi.fn(async () => ({ id: "user-1" })) },   // session→user lookup
    } as any;
    const result = await viewUrlForAgent({
      prisma, signSupabaseView: signView, session: mkSession(),
      storageKey: "tenant-ic/org-1/party-1/temp/x/front-y.jpg",
      ip: "127.0.0.1", userAgent: "ua",
    });
    expect(result.viewUrl).toMatch(/^https:\/\/v\//);
    expect(prisma.icAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ viewerScope: "agent_self", side: "front" }),
      }),
    );
  });

  it("404 when storage key not owned by session party", async () => {
    const prisma = {
      pendingUpload: { findFirst: vi.fn(async () => null) },
      icAccessLog: { create: vi.fn() },
      user: { findFirst: vi.fn() },
    } as any;
    await expect(
      viewUrlForAgent({
        prisma, signSupabaseView: signView, session: mkSession(),
        storageKey: "tenant-ic/other/other/x/y.jpg",
        ip: "1", userAgent: "ua",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("viewUrlForAdmin", () => {
  const mkAdminSession = () => ({ partyId: "admin-party", orgId: "org-1", role: "admin", userId: "user-admin" });
  const signView = vi.fn(async (key: string) => ({ viewUrl: `https://v/${key}`, expiresAt: new Date() }));

  it("returns view URL when claim item is in same org + writes IcAccessLog viewerScope='admin'", async () => {
    const prisma = {
      commissionClaimItem: {
        findFirst: vi.fn(async () => ({
          id: "ci-1", organizationId: "org-1",
          tenantIcFrontKey: "tenant-ic/org-1/party-1/temp/x/front-y.jpg",
          tenantIcBackKey: null,
        })),
      },
      icAccessLog: { create: vi.fn(async () => ({ id: "log-2" })) },
    } as any;
    const result = await viewUrlForAdmin({
      prisma, signSupabaseView: signView, session: mkAdminSession(),
      claimItemId: "ci-1", side: "front", ip: "127.0.0.1", userAgent: "ua",
    });
    expect(result.viewUrl).toMatch(/^https:\/\/v\//);
    expect(prisma.icAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          viewerScope: "admin",
          viewerUserId: "user-admin",
          claimItemId: "ci-1",
          side: "front",
        }),
      }),
    );
  });

  it("403 when role is not admin or manager", async () => {
    await expect(
      viewUrlForAdmin({
        prisma: {} as any, signSupabaseView: signView,
        session: { ...mkAdminSession(), role: "editor" },
        claimItemId: "ci-1", side: "front", ip: "1", userAgent: "ua",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("404 when claim item is in a different org", async () => {
    const prisma = {
      commissionClaimItem: { findFirst: vi.fn(async () => null) },
      icAccessLog: { create: vi.fn() },
    } as any;
    await expect(
      viewUrlForAdmin({
        prisma, signSupabaseView: signView, session: mkAdminSession(),
        claimItemId: "missing", side: "front", ip: "1", userAgent: "ua",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404 when the requested side has no key on the item", async () => {
    const prisma = {
      commissionClaimItem: {
        findFirst: vi.fn(async () => ({
          id: "ci-1", organizationId: "org-1",
          tenantIcFrontKey: "tenant-ic/x/y/z/front.jpg",
          tenantIcBackKey: null,   // back missing
        })),
      },
      icAccessLog: { create: vi.fn() },
    } as any;
    await expect(
      viewUrlForAdmin({
        prisma, signSupabaseView: signView, session: mkAdminSession(),
        claimItemId: "ci-1", side: "back", ip: "1", userAgent: "ua",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
