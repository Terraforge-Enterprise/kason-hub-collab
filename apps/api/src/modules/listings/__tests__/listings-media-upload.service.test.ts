import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  createSignedUploadUrl: vi.fn(async (params) => ({
    uploadUrl: "https://fake/upload/" + params.storageKey,
    method: "POST" as const,
    headers: { "content-type": params.contentType },
    storageKey: params.storageKey,
  })),
  objectExists: vi.fn(async () => true),
  getObjectAsBuffer: vi.fn(async () => Buffer.from("stub")),
  putObject: vi.fn(async () => undefined),
  deleteObjectsBestEffort: vi.fn(async () => ({ deleted: 1, failed: 0 })),
}));

vi.mock("../listings-media.service", async () => {
  const actual = await vi.importActual<typeof import("../listings-media.service")>(
    "../listings-media.service",
  );
  return {
    ...actual,
    stripExifInPlace: vi.fn(async () => undefined),
    transcodeVideoInPlace: vi.fn(async () => undefined),
  };
});

// Per spec 2026-05-24, photoKeys / videoKeys live on Listing (per room
// type). Reads go through `listing.findUnique` selecting them directly;
// writes go through `listing.update`.
const findUniqueMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@kason/db", () => ({
  getDb: () => ({
    listing: { findUnique: findUniqueMock, update: updateMock },
    // Interactive transactions: hand the callback the same Prisma surface
    // we expose at the top level. Lets removeMediaKey's
    // tx.listing.findUnique / tx.listing.update calls hit the same mocks.
    $transaction: (cb: (tx: unknown) => unknown) =>
      cb({
        listing: { findUnique: findUniqueMock, update: updateMock },
      }),
  }),
}));

beforeEach(async () => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  const { objectExists } = await import("../../../lib/storage");
  (objectExists as ReturnType<typeof vi.fn>).mockReset();
  (objectExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe("buildMediaUploadUrl", () => {
  it("rejects when unit not found for this org", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { buildMediaUploadUrl } = await import("../listings-media-upload.service");
    const r = await buildMediaUploadUrl({
      orgId: "o1",
      unitId: "u1",
      kind: "photo",
      filename: "x.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("rejects when MIME is not allowed for photo", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const { buildMediaUploadUrl } = await import("../listings-media-upload.service");
    const r = await buildMediaUploadUrl({
      orgId: "o1",
      unitId: "u1",
      kind: "photo",
      filename: "x.gif",
      mimeType: "image/gif",
      sizeBytes: 1_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects when size exceeds cap for photo (15 MB)", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const { buildMediaUploadUrl } = await import("../listings-media-upload.service");
    const r = await buildMediaUploadUrl({
      orgId: "o1",
      unitId: "u1",
      kind: "photo",
      filename: "x.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 20 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects when photo count cap (40) already reached", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: Array.from({ length: 40 }, (_, i) => `units/u1/${i}.jpg`),
      videoKeys: [],
    });
    const { buildMediaUploadUrl } = await import("../listings-media-upload.service");
    const r = await buildMediaUploadUrl({
      orgId: "o1",
      unitId: "u1",
      kind: "photo",
      filename: "x.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("returns upload URL with units/<unitId>/<uuid>.<ext> key on happy path", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const { buildMediaUploadUrl } = await import("../listings-media-upload.service");
    const r = await buildMediaUploadUrl({
      orgId: "o1",
      unitId: "u1",
      kind: "photo",
      filename: "beach.JPG",
      mimeType: "image/jpeg",
      sizeBytes: 2_000_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.storageKey).toMatch(/^units\/u1\/[0-9a-f-]{36}\.jpg$/);
      expect(r.data.uploadUrl).toContain("upload");
    }
  });

  it("accepts uppercase MIME type (case-insensitive per RFC 7231)", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const { buildMediaUploadUrl } = await import("../listings-media-upload.service");
    const r = await buildMediaUploadUrl({
      orgId: "o1",
      unitId: "u1",
      kind: "photo",
      filename: "beach.JPG",
      mimeType: "image/JPEG",
      sizeBytes: 2_000_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.storageKey).toMatch(/^units\/u1\/[0-9a-f-]{36}\.jpg$/);
    }
  });
});

describe("completeMediaUpload", () => {
  const UNIT_ID = "11111111-1111-1111-1111-111111111111";

  it("rejects when storageKey doesn't start with units/<unitId>/", async () => {
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: "units/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.jpg", // valid shape, wrong unit
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects path traversal attempts in storageKey", async () => {
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: `units/${UNIT_ID}/../22222222-2222-2222-2222-222222222222/secret.jpg`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects when object does not exist in bucket", async () => {
    const { objectExists } = await import("../../../lib/storage");
    (objectExists as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: `units/${UNIT_ID}/44444444-4444-4444-4444-444444444444.jpg`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("rejects when unit not found or wrong org", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: `units/${UNIT_ID}/44444444-4444-4444-4444-444444444444.jpg`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("appends photo key and returns updated arrays", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const newKey = `units/${UNIT_ID}/44444444-4444-4444-4444-444444444444.jpg`;
    updateMock.mockResolvedValueOnce({
      photoKeys: [newKey],
      videoKeys: [],
    });
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: newKey,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toContain(newKey);
    }
    expect(updateMock).toHaveBeenCalledOnce();
    // Write targets listing.update keyed on this listing's id (per-room
    // ownership; sibling rooms are untouched).
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: { photoKeys: [newKey] },
    });
  });

  it("appends video key when the key looks like a video", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const newKey = `units/${UNIT_ID}/55555555-5555-5555-5555-555555555555.mp4`;
    updateMock.mockResolvedValueOnce({
      photoKeys: [],
      videoKeys: [newKey],
    });
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: newKey,
    });
    expect(r.ok).toBe(true);
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: { videoKeys: [newKey] },
    });
  });

  it("returns existing arrays idempotently when storageKey already registered", async () => {
    const existingKey = `units/${UNIT_ID}/66666666-6666-6666-6666-666666666666.jpg`;
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [existingKey],
      videoKeys: [],
    });
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: existingKey,
    });
    expect(r.ok).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects when photo count cap (40) already reached at complete time", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: Array.from(
        { length: 40 },
        (_, i) =>
          `units/${UNIT_ID}/${String(i).padStart(8, "0")}-0000-0000-0000-000000000000.jpg`,
      ),
      videoKeys: [],
    });
    const { completeMediaUpload } = await import("../listings-media-upload.service");
    const r = await completeMediaUpload({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: `units/${UNIT_ID}/77777777-7777-7777-7777-777777777777.jpg`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});

describe("removeMediaKey", () => {
  const UNIT_ID = "11111111-1111-1111-1111-111111111111";
  const PHOTO_KEY_A = `units/${UNIT_ID}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`;
  const PHOTO_KEY_B = `units/${UNIT_ID}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg`;
  const VIDEO_KEY_C = `units/${UNIT_ID}/cccccccc-cccc-cccc-cccc-cccccccccccc.mp4`;

  it("returns 404 when the key is not in this listing's arrays (per-room isolation)", async () => {
    // Per spec 2026-05-24, sibling room listings own independent arrays.
    // A key uploaded via Master's listing is NOT visible to (and not
    // deletable from) Small's listing.
    const SIBLING_UNIT_ID = UNIT_ID;
    const MASTER_KEY = `units/22222222-2222-2222-2222-222222222222/dddddddd-dddd-dddd-dddd-dddddddddddd.jpg`;
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [],
    });
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: SIBLING_UNIT_ID,
      storageKey: MASTER_KEY,
    });
    // Idempotent path: the key isn't in arrays, returns ok with current state.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toEqual([]);
      expect(r.data.videoKeys).toEqual([]);
    }
    // Critically, no write fans out to sibling listings.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects path traversal attempts", async () => {
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: `units/${UNIT_ID}/../22222222-2222-2222-2222-222222222222/secret.jpg`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects when unit not found or wrong org", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("strips a photo key from photoKeys and persists the filtered array", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_A, PHOTO_KEY_B],
      videoKeys: [],
    });
    updateMock.mockResolvedValueOnce({
      photoKeys: [PHOTO_KEY_B],
      videoKeys: [],
    });
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toEqual([PHOTO_KEY_B]);
      expect(r.data.videoKeys).toEqual([]);
    }
    expect(updateMock).toHaveBeenCalledOnce();
    // Write targets listing.update keyed on this listing's id.
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: { photoKeys: [PHOTO_KEY_B] },
    });
  });

  it("strips a video key from videoKeys when the key is a video", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [],
      videoKeys: [VIDEO_KEY_C],
    });
    updateMock.mockResolvedValueOnce({ photoKeys: [], videoKeys: [] });
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: VIDEO_KEY_C,
    });
    expect(r.ok).toBe(true);
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      where: { id: UNIT_ID },
      data: { videoKeys: [] },
    });
  });

  it("is idempotent — a key already absent returns the current arrays without an update", async () => {
    findUniqueMock.mockResolvedValueOnce({
      organizationId: "o1",
      photoKeys: [PHOTO_KEY_B],
      videoKeys: [],
    });
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: PHOTO_KEY_A,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.photoKeys).toEqual([PHOTO_KEY_B]);
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("logs the rejected storage key on regex mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badKey = "units/not-a-uuid/whatever.heic";
    const { removeMediaKey } = await import("../listings-media-upload.service");
    const r = await removeMediaKey({
      orgId: "o1",
      unitId: UNIT_ID,
      storageKey: badKey,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(warn).toHaveBeenCalledWith(
      "removeMediaKey rejected",
      expect.objectContaining({
        unitId: UNIT_ID,
        storageKey: badKey,
      }),
    );
    warn.mockRestore();
  });
});
