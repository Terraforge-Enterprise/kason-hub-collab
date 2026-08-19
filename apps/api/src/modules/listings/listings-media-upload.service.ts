import { randomUUID } from "node:crypto";
import { getDb } from "@kason/db";
import { createSignedUploadUrl, deleteObjectsBestEffort, objectExists, type SignedUploadUrl } from "../../lib/storage";
import { isVideoKey, stripExifInPlace, transcodeVideoInPlace } from "./listings-media.service";
import { runtimeConfig } from "../../lib/runtime-config";

const PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

// Caps come from runtime config so dev/staging/prod can each pick a value
// that matches their Supabase bucket's `file_size_limit`. Defaults: 15 MB
// photo, 50 MB video (Free-tier safe). Bump VIDEO_MAX_BYTES once the
// bucket cap is raised on Pro.
//
// The application cap MUST NOT exceed the bucket cap — pre-signing succeeds
// at app cap but the actual PUT 413s at bucket cap, leaving a confusing UX.
// See docs/runbooks/supabase-storage.md.
const PHOTO_MAX_COUNT = 40;
const VIDEO_MAX_COUNT = 10;

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

// Accepts only keys that match the exact shape buildMediaUploadUrl produces:
//   units/<uuid>/<uuid>.<ext>
// Rejects `..` / empty segments / unknown extensions / wrong top-level dir.
const STORAGE_KEY_RE =
  /^units\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|mov|webm)$/i;

type BuildMediaUploadUrlInput = {
  orgId: string;
  unitId: string;
  kind: "photo" | "video";
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

type BuildMediaUploadUrlResult =
  | { ok: true; data: SignedUploadUrl }
  | { ok: false; status: 400 | 404 | 409; error: string };

// photoKeys / videoKeys live on Listing (per-room) as of spec 2026-05-24.
// Each room-type Listing under a partitioned Apartment owns its own gallery
// — uploading via Master no longer affects Medium/Small.
async function findListingMediaContext(
  unitId: string,
  orgId: string,
): Promise<{ photoKeys: string[]; videoKeys: string[] } | null> {
  const listing = await getDb().listing.findUnique({
    where: { id: unitId },
    select: {
      organizationId: true,
      photoKeys: true,
      videoKeys: true,
    },
  });
  if (!listing || listing.organizationId !== orgId) return null;
  return {
    photoKeys: listing.photoKeys,
    videoKeys: listing.videoKeys,
  };
}

export async function buildMediaUploadUrl(
  input: BuildMediaUploadUrlInput,
): Promise<BuildMediaUploadUrlResult> {
  const allowedMimes = input.kind === "photo" ? PHOTO_MIMES : VIDEO_MIMES;
  const maxBytes =
    input.kind === "photo"
      ? runtimeConfig.limits.photoMaxBytes
      : runtimeConfig.limits.videoMaxBytes;
  const maxCount = input.kind === "photo" ? PHOTO_MAX_COUNT : VIDEO_MAX_COUNT;

  const normalisedMime = input.mimeType.toLowerCase();

  if (!allowedMimes.has(normalisedMime)) {
    return { ok: false, status: 400, error: `Unsupported ${input.kind} MIME type` };
  }
  if (input.sizeBytes > maxBytes) {
    return {
      ok: false,
      status: 400,
      error: `File too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)`,
    };
  }

  const ctx = await findListingMediaContext(input.unitId, input.orgId);
  if (!ctx) {
    return { ok: false, status: 404, error: "Unit not found" };
  }

  const currentCount =
    input.kind === "photo" ? ctx.photoKeys.length : ctx.videoKeys.length;
  if (currentCount >= maxCount) {
    return {
      ok: false,
      status: 409,
      error: `${input.kind === "photo" ? "Photo" : "Video"} limit reached (max ${maxCount} per unit)`,
    };
  }

  const ext = EXT_BY_MIME[normalisedMime] ?? "bin";
  const storageKey = `units/${input.unitId}/${randomUUID()}.${ext}`;

  const signed = await createSignedUploadUrl({
    storageKey,
    contentType: normalisedMime,
  });

  return { ok: true, data: signed };
}

type CompleteMediaUploadInput = {
  orgId: string;
  unitId: string;
  storageKey: string;
};

type CompleteMediaUploadResult =
  | { ok: true; data: { photoKeys: string[]; videoKeys: string[] } }
  | { ok: false; status: 400 | 404 | 409; error: string };

export async function completeMediaUpload(
  input: CompleteMediaUploadInput,
): Promise<CompleteMediaUploadResult> {
  if (
    !STORAGE_KEY_RE.test(input.storageKey) ||
    !input.storageKey.startsWith(`units/${input.unitId}/`)
  ) {
    return { ok: false, status: 400, error: "Invalid storage key" };
  }

  const exists = await objectExists(input.storageKey);
  if (!exists) {
    return { ok: false, status: 404, error: "Object not found in bucket" };
  }

  const ctx = await findListingMediaContext(input.unitId, input.orgId);
  if (!ctx) {
    return { ok: false, status: 404, error: "Unit not found" };
  }

  const isVideo = isVideoKey(input.storageKey);
  const existingKeys = isVideo ? ctx.videoKeys : ctx.photoKeys;

  // Idempotency: if the key is already registered, return current state
  // without a duplicate append. Lets clients safely retry /complete.
  if (existingKeys.includes(input.storageKey)) {
    return {
      ok: true,
      data: { photoKeys: ctx.photoKeys, videoKeys: ctx.videoKeys },
    };
  }

  // Hard cap — mirrors /upload-url. A client could previously get past
  // /upload-url while under the cap, then race other completes — this
  // guards the final invariant at write time.
  const maxCount = isVideo ? VIDEO_MAX_COUNT : PHOTO_MAX_COUNT;
  if (existingKeys.length >= maxCount) {
    return {
      ok: false,
      status: 409,
      error: `${isVideo ? "Video" : "Photo"} limit reached (max ${maxCount} per unit)`,
    };
  }

  const updated = isVideo
    ? { videoKeys: [...ctx.videoKeys, input.storageKey] }
    : { photoKeys: [...ctx.photoKeys, input.storageKey] };

  const saved = await getDb().listing.update({
    where: { id: input.unitId },
    data: updated,
    select: { photoKeys: true, videoKeys: true },
  });

  // Fire-and-forget post-processing. EXIF-strip photos; transcode videos to
  // 720p H.264. Errors logged but not surfaced — the original is still
  // viewable, and the existing POST /media/:key/processed endpoint can retry.
  const processFn = isVideo ? transcodeVideoInPlace : stripExifInPlace;
  setImmediate(() => {
    processFn(input.storageKey).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("media post-process failed", { key: input.storageKey, error: String(err) });
    });
  });

  return { ok: true, data: saved };
}

type RemoveMediaKeyInput = {
  orgId: string;
  unitId: string;
  storageKey: string;
};

type RemoveMediaKeyResult =
  | { ok: true; data: { photoKeys: string[]; videoKeys: string[] } }
  | { ok: false; status: 400 | 404; error: string };

// Strips a storage key from this Listing's photoKeys / videoKeys, then
// best-effort deletes the object from storage after the transaction commits.
// If the removed photo was the listing's coverPhotoKey the cover is cleared
// in the same update to prevent a dangling 404 reference.
//
// Read+filter+write happens inside one interactive transaction so a
// concurrent upload-complete (or another delete) on the same listing can't
// resurrect the key by reading the pre-state and writing back its merged
// view. Without the tx, two writers could each read photoKeys=[X], one
// removes X, one appends Y — last writer leaves [X,Y] and the deleted key
// reappears.
export async function removeMediaKey(
  input: RemoveMediaKeyInput,
): Promise<RemoveMediaKeyResult> {
  if (!STORAGE_KEY_RE.test(input.storageKey)) {
    console.warn("removeMediaKey rejected", {
      unitId: input.unitId,
      storageKey: input.storageKey,
    });
    return { ok: false, status: 400, error: "Invalid storage key" };
  }

  const { result, keyWasRemoved } = await getDb().$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({
      where: { id: input.unitId },
      select: {
        organizationId: true,
        photoKeys: true,
        videoKeys: true,
        coverPhotoKey: true,
      },
    });
    if (!listing || listing.organizationId !== input.orgId) {
      return {
        result: { ok: false as const, status: 404 as const, error: "Unit not found" },
        keyWasRemoved: false,
      };
    }

    const photoKeys = listing.photoKeys;
    const videoKeys = listing.videoKeys;
    const inPhotos = photoKeys.includes(input.storageKey);
    const inVideos = videoKeys.includes(input.storageKey);

    // Idempotency: if the key is already absent, return current state.
    // A retried DELETE after a network blip lands as a no-op.
    if (!inPhotos && !inVideos) {
      return {
        result: { ok: true as const, data: { photoKeys, videoKeys } },
        keyWasRemoved: false,
      };
    }

    const isCover = inPhotos && listing.coverPhotoKey === input.storageKey;
    const next: Record<string, unknown> = inPhotos
      ? { photoKeys: photoKeys.filter((k) => k !== input.storageKey) }
      : { videoKeys: videoKeys.filter((k) => k !== input.storageKey) };

    if (isCover) {
      next.coverPhotoKey = null;
    }

    const saved = await tx.listing.update({
      where: { id: input.unitId },
      data: next,
      select: { photoKeys: true, videoKeys: true },
    });
    return { result: { ok: true as const, data: saved }, keyWasRemoved: true };
  });

  if (keyWasRemoved) {
    await deleteObjectsBestEffort([input.storageKey]);
  }

  return result;
}
