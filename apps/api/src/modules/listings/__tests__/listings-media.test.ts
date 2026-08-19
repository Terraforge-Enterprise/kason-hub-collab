import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// -----------------------------------------------------------------------------
// Mocks — we never touch Supabase Storage or shell out to ffmpeg in unit tests.
// -----------------------------------------------------------------------------

vi.mock("../../../lib/storage", () => ({
  getObjectAsBuffer: vi.fn(async () => Buffer.from("raw-bytes")),
  putObject: vi.fn(async () => undefined),
}));

// sharp() returns a chainable pipeline; toBuffer() yields the final bytes.
// vi.hoisted — these spies must be defined before vi.mock factories run (top-of-file hoist).
const { sharpFn, sharpRotate, sharpWithMetadata, sharpToBuffer } = vi.hoisted(() => {
  const sharpToBuffer = vi.fn(async () => Buffer.from("stripped-bytes"));
  const sharpWithMetadata = vi.fn(() => ({ toBuffer: sharpToBuffer }));
  const sharpRotate = vi.fn(() => ({ withMetadata: sharpWithMetadata }));
  const sharpFn = vi.fn(() => ({ rotate: sharpRotate }));
  return { sharpFn, sharpRotate, sharpWithMetadata, sharpToBuffer };
});
vi.mock("sharp", () => ({ default: sharpFn }));

// fluent-ffmpeg returns a chainable command; we fire the 'end' listener on save().
vi.mock("fluent-ffmpeg", () => {
  const ffmpegFn = vi.fn(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const chain = {
      outputOptions: vi.fn(() => chain),
      save: vi.fn(() => {
        // Invoke the 'end' handler asynchronously so the awaiting promise resolves.
        queueMicrotask(() => handlers.end?.());
        return chain;
      }),
      on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
        handlers[evt] = cb;
        return chain;
      }),
    };
    return chain;
  });
  return { default: ffmpegFn };
});

// fs: stub file I/O so we don't actually read/write temp files.
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: vi.fn(() => undefined),
    readFileSync: vi.fn(() => Buffer.from("transcoded-bytes")),
    unlinkSync: vi.fn(() => undefined),
  };
});

// -----------------------------------------------------------------------------
// Imports under test — AFTER mocks are registered.
// -----------------------------------------------------------------------------

import { getObjectAsBuffer, putObject } from "../../../lib/storage";
import {
  isVideoKey,
  sniffImageMime,
  stripExifInPlace,
  transcodeVideoInPlace,
} from "../listings-media.service";
import sharp from "sharp";

describe("listings-media.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("sniffImageMime", () => {
    it("maps known extensions to mime types", () => {
      expect(sniffImageMime("photo.jpg")).toBe("image/jpeg");
      expect(sniffImageMime("PHOTO.JPEG")).toBe("image/jpeg");
      expect(sniffImageMime("pic.png")).toBe("image/png");
      expect(sniffImageMime("banner.webp")).toBe("image/webp");
      expect(sniffImageMime("mystery")).toBe("application/octet-stream");
    });
  });

  describe("isVideoKey", () => {
    it("recognises video extensions case-insensitively", () => {
      expect(isVideoKey("clip.mp4")).toBe(true);
      expect(isVideoKey("clip.MOV")).toBe(true);
      expect(isVideoKey("clip.webm")).toBe(true);
      expect(isVideoKey("photo.jpg")).toBe(false);
    });
  });

  describe("stripExifInPlace", () => {
    it("fetches the object, strips EXIF via sharp, and writes back", async () => {
      await stripExifInPlace("listings/abc/photo.jpg");

      expect(getObjectAsBuffer).toHaveBeenCalledWith("listings/abc/photo.jpg");

      // sharp(buf).rotate().withMetadata({ exif: {} }).toBuffer()
      expect(sharp).toHaveBeenCalledTimes(1);
      expect(sharpRotate).toHaveBeenCalledTimes(1);
      expect(sharpWithMetadata).toHaveBeenCalledWith({ exif: {} });
      expect(sharpToBuffer).toHaveBeenCalledTimes(1);

      expect(putObject).toHaveBeenCalledWith(
        "listings/abc/photo.jpg",
        Buffer.from("stripped-bytes"),
        "image/jpeg",
      );
    });
  });

  describe("transcodeVideoInPlace", () => {
    it("fetches, runs ffmpeg, writes back as video/mp4", async () => {
      await expect(transcodeVideoInPlace("listings/abc/clip.mp4")).resolves.toBeUndefined();

      expect(getObjectAsBuffer).toHaveBeenCalledWith("listings/abc/clip.mp4");
      expect(putObject).toHaveBeenCalledWith(
        "listings/abc/clip.mp4",
        Buffer.from("transcoded-bytes"),
        "video/mp4",
      );
    });
  });
});

// -----------------------------------------------------------------------------
// Route-level test: 202 + setImmediate fires exactly once.
// -----------------------------------------------------------------------------

describe("POST /:id/media/:key/processed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202 and schedules processing via setImmediate", async () => {
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");

    // Import routes after mocks so storage/sharp/ffmpeg are all stubbed.
    const { listingsRoutes } = await import("../listings.routes");

    type TestSession = { orgId: string; userId: string; role: string; userType: string };
    const app = new Hono<{ Variables: { session: TestSession } }>();
    app.use("*", async (c, next) => {
      c.set("session", {
        orgId: "o1",
        userId: "u1",
        role: "manager",
        userType: "operator",
      });
      await next();
    });
    app.route("/api/listings", listingsRoutes);

    const res = await app.request("/api/listings/abc/media/test.jpg/processed", {
      method: "POST",
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ queued: true });
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);

    setImmediateSpy.mockRestore();
  });
});
