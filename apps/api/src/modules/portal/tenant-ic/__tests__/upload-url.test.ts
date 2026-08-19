// apps/api/src/modules/portal/tenant-ic/__tests__/upload-url.test.ts
import { describe, it, expect, vi } from "vitest";
import { requestUploadUrl } from "../tenant-ic.service";

describe("requestUploadUrl", () => {
  const mkSession = () => ({ partyId: "party-1", orgId: "org-1", role: "agent" });
  const mkPrisma = () => ({
    pendingUpload: {
      create: vi.fn(async ({ data }: any) => ({ ...data, id: "pu-1" })),
      count: vi.fn(async () => 0), // for rate-limit query
    },
  }) as any;
  const mkSigner = () => vi.fn(async (key: string) => ({
    uploadUrl: `https://x/upload/${key}`,
    method: "PUT" as const,
    headers: { authorization: "Bearer test-token", "x-upsert": "true", "content-type": "image/jpeg" },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  }));

  it("inserts a PendingUpload row and returns signed URL with method + headers", async () => {
    const prisma = mkPrisma();
    const signer = mkSigner();
    const result = await requestUploadUrl({
      prisma, signSupabaseUpload: signer, session: mkSession(),
      side: "front", contentType: "image/jpeg",
    });
    expect(result.uploadUrl).toMatch(/^https:\/\/x\/upload\//);
    // Supabase signed-upload URLs are POST-only and require a Bearer token.
    // The route MUST forward method + headers so the browser uses them.
    expect(result.method).toBe("PUT");
    expect(result.headers.authorization).toMatch(/^Bearer /);
    expect(result.storageKey).toMatch(/^tenant-ic\/org-1\/party-1\/temp\/[a-f0-9-]+\/front-[a-f0-9-]+\.jpeg$/);
    expect(prisma.pendingUpload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          partyId: "party-1",
          uploadType: "tenant_ic",
          side: "front",
          contentType: "image/jpeg",
          status: "pending",
          bucket: "tenant-ic",
        }),
      }),
    );
  });

  it("rejects unsupported contentType", async () => {
    await expect(
      requestUploadUrl({
        prisma: mkPrisma(), signSupabaseUpload: mkSigner(), session: mkSession(),
        side: "front", contentType: "application/pdf" as any,
      }),
    ).rejects.toThrow(/contentType/i);
  });

  it("rejects when over rate limit", async () => {
    const prisma = mkPrisma();
    prisma.pendingUpload.count = vi.fn(async () => 30);   // at limit
    await expect(
      requestUploadUrl({
        prisma, signSupabaseUpload: mkSigner(), session: mkSession(),
        side: "front", contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/rate.limit|429|too many/i);
  });

  it("rejects bad side value", async () => {
    await expect(
      requestUploadUrl({
        prisma: mkPrisma(), signSupabaseUpload: mkSigner(), session: mkSession(),
        side: "side" as any, contentType: "image/jpeg",
      }),
    ).rejects.toThrow(/side/i);
  });
});
