import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedUrlCache } from "../storage-cache";

// Mock the Supabase client factory so we never touch real Supabase.
const signedUploadUrlMock = vi.fn(async () => ({
  data: {
    signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/listing-media/units/u1/x.jpg?token=abc",
    path: "units/u1/x.jpg",
    token: "abc",
  },
  error: null,
}));
const createSignedUrlMock = vi.fn(async (_key: string, _ttl: number, _opts?: unknown) => ({
  data: { signedUrl: "https://project.supabase.co/storage/v1/object/sign/listing-media/units/u1/x.jpg?token=xyz" },
  error: null,
}));
const downloadMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        createSignedUploadUrl: signedUploadUrlMock,
        createSignedUrl: createSignedUrlMock,
        download: downloadMock,
      })),
    },
  })),
}));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.SUPABASE_STORAGE_BUCKET = "listing-media";
  signedUploadUrlMock.mockClear();
  createSignedUrlMock.mockClear();
  downloadMock.mockReset();
  signedUrlCache.clear();
});

describe("createSignedUploadUrl", () => {
  it("returns { uploadUrl, method: 'PUT', headers, storageKey } shape", async () => {
    const { createSignedUploadUrl } = await import("../storage");
    const result = await createSignedUploadUrl({
      storageKey: "units/u1/x.jpg",
      contentType: "image/jpeg",
    });
    expect(result).toEqual({
      uploadUrl: expect.stringContaining("upload/sign"),
      method: "PUT",
      headers: expect.objectContaining({
        "content-type": "image/jpeg",
        authorization: expect.stringContaining("Bearer"),
      }),
      storageKey: "units/u1/x.jpg",
    });
  });
});

describe("createSignedDownloadUrl", () => {
  it("attaches Content-Disposition when filename given", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg", { filename: "unit-01.jpg" });
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      "units/u1/x.jpg",
      expect.any(Number),
      expect.objectContaining({
        download: "unit-01.jpg",
      }),
    );
  });

  it("forwards Supabase image transform when given", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg", {
      transform: { width: 600, height: 600, resize: "cover", quality: 75 },
    });
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      "units/u1/x.jpg",
      expect.any(Number),
      expect.objectContaining({
        transform: { width: 600, height: 600, resize: "cover", quality: 75 },
      }),
    );
  });

  it("passes undefined opts when neither filename nor transform given", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg");
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      "units/u1/x.jpg",
      expect.any(Number),
      undefined,
    );
  });
});

describe("fetchStorageBuffer", () => {
  it("returns a Buffer with the object bytes on a hit", async () => {
    const u8 = new Uint8Array(Buffer.from("%PDF-1.4 receipt bytes"));
    downloadMock.mockResolvedValueOnce({
      data: { arrayBuffer: async () => u8.buffer },
      error: null,
    });
    const { fetchStorageBuffer } = await import("../storage");
    const buf = await fetchStorageBuffer("owner-statements/o1/receipt.pdf");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf?.toString()).toBe("%PDF-1.4 receipt bytes");
    expect(downloadMock).toHaveBeenCalledWith("owner-statements/o1/receipt.pdf");
  });

  it("returns null (never throws) when Supabase reports an error", async () => {
    downloadMock.mockResolvedValueOnce({ data: null, error: { message: "Object not found" } });
    const { fetchStorageBuffer } = await import("../storage");
    await expect(fetchStorageBuffer("missing/key.jpg")).resolves.toBeNull();
  });

  it("returns null (never throws) when the download call rejects", async () => {
    downloadMock.mockRejectedValueOnce(new Error("network down"));
    const { fetchStorageBuffer } = await import("../storage");
    await expect(fetchStorageBuffer("flaky/key.png")).resolves.toBeNull();
  });
});

describe("createSignedDownloadUrl + signedUrlCache integration", () => {
  it("calls Supabase once when the same key+opts is requested twice", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg", { transform: { width: 400 } });
    await createSignedDownloadUrl("units/u1/x.jpg", { transform: { width: 400 } });
    expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
  });

  it("calls Supabase twice when the same key has different transform opts", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg", { transform: { width: 400 } });
    await createSignedDownloadUrl("units/u1/x.jpg", { transform: { width: 800 } });
    expect(createSignedUrlMock).toHaveBeenCalledTimes(2);
  });

  it("calls Supabase twice when the same key has different filename opts", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg", { filename: "first.jpg" });
    await createSignedDownloadUrl("units/u1/x.jpg", { filename: "second.jpg" });
    expect(createSignedUrlMock).toHaveBeenCalledTimes(2);
  });

  it("calls Supabase twice when called once with no opts and once with opts", async () => {
    const { createSignedDownloadUrl } = await import("../storage");
    await createSignedDownloadUrl("units/u1/x.jpg");
    await createSignedDownloadUrl("units/u1/x.jpg", { filename: "x.jpg" });
    expect(createSignedUrlMock).toHaveBeenCalledTimes(2);
  });
});
