import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Supabase client factory so we never touch real Supabase.
// The `remove` spy is the one we control per test.
const removeMock = vi.fn(
  async (_keys: string[]): Promise<{ error: { message: string; status?: number } | null }> => ({
    error: null,
  })
);

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        remove: removeMock,
        // Other methods the module may reference (for type safety with shared client)
        createSignedUploadUrl: vi.fn(),
        createSignedUrl: vi.fn(),
        list: vi.fn(),
        download: vi.fn(),
        upload: vi.fn(),
        getBucket: vi.fn(),
      })),
    },
  })),
}));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.SUPABASE_STORAGE_BUCKET = "listing-media";
  removeMock.mockClear();
  removeMock.mockResolvedValue({ error: null });
});

describe("deleteObjectsBestEffort", () => {
  it("deletes each unique key against the resolved bucket and returns {deleted:N, failed:0}", async () => {
    const { deleteObjectsBestEffort } = await import("../storage");
    const result = await deleteObjectsBestEffort(["units/u1/a.jpg", "units/u1/b.jpg"]);
    expect(result).toEqual({ deleted: 2, failed: 0 });
    // remove should be called once per unique key, each with the correct single-key array
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(removeMock).toHaveBeenCalledWith(["units/u1/a.jpg"]);
    expect(removeMock).toHaveBeenCalledWith(["units/u1/b.jpg"]);
  });

  it("dedupes duplicate keys — remove called once per unique key", async () => {
    const { deleteObjectsBestEffort } = await import("../storage");
    const result = await deleteObjectsBestEffort([
      "units/u1/a.jpg",
      "units/u1/a.jpg",
      "units/u1/b.jpg",
    ]);
    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(removeMock).toHaveBeenCalledTimes(2);
    expect(removeMock).toHaveBeenCalledWith(["units/u1/a.jpg"]);
    expect(removeMock).toHaveBeenCalledWith(["units/u1/b.jpg"]);
  });

  it("skips null/undefined/empty-string entries — remove not called for them", async () => {
    const { deleteObjectsBestEffort } = await import("../storage");
    const result = await deleteObjectsBestEffort([null, undefined, "", "units/u1/a.jpg"]);
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(["units/u1/a.jpg"]);
  });

  it("empty input → {deleted:0,failed:0}, remove never called, does NOT throw even when bucket is unset", async () => {
    delete process.env.SUPABASE_STORAGE_BUCKET;
    const { deleteObjectsBestEffort } = await import("../storage");
    await expect(deleteObjectsBestEffort([])).resolves.toEqual({ deleted: 0, failed: 0 });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("all-empty entries → {deleted:0,failed:0}, remove never called, does NOT throw even when bucket is unset", async () => {
    delete process.env.SUPABASE_STORAGE_BUCKET;
    const { deleteObjectsBestEffort } = await import("../storage");
    await expect(deleteObjectsBestEffort([null, undefined, ""])).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("one key's delete rejects → counted as failed, other keys still deleted, never throws", async () => {
    removeMock
      .mockResolvedValueOnce({ error: { message: "connection error", status: 500 } })
      .mockResolvedValueOnce({ error: null });

    const { deleteObjectsBestEffort } = await import("../storage");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await deleteObjectsBestEffort(["units/u1/fail.jpg", "units/u1/ok.jpg"]);
    warnSpy.mockRestore();

    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect(removeMock).toHaveBeenCalledTimes(2);
  });

  it("requireBucket() throwing (env unset) with non-empty keys → {deleted:0, failed:<count>}, never throws", async () => {
    delete process.env.SUPABASE_STORAGE_BUCKET;
    const { deleteObjectsBestEffort } = await import("../storage");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await deleteObjectsBestEffort(["units/u1/a.jpg", "units/u1/b.jpg"]);
    warnSpy.mockRestore();

    expect(result).toEqual({ deleted: 0, failed: 2 });
    expect(removeMock).not.toHaveBeenCalled();
  });
});
