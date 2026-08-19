// use-listing-media-upload.ts — orphan/lost-upload fix (SP-2 review Finding A).
//
// Root cause under test: inside runOne, once the upload XHR's onload resolves
// (bytes are already in Supabase storage), the ORIGINAL code bailed out via
// `if (!mountedRef.current) return;` BEFORE calling POST .../media/complete.
// If the host component unmounted between onload firing and /complete being
// issued (edit-shell tab switch, dialog close), /complete never fires and the
// uploaded object is orphaned — the DB never learns the file exists. The fix
// must always call /complete once the upload itself succeeded, while still
// suppressing the onSuccess callback + terminal "done" patch after unmount.
//
// XHR is faked (no fetch/progress events exist for XHR in jsdom) so the test
// can drive onload/onabort by hand and control exactly when the "component"
// unmounts relative to the network callbacks.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useListingMediaUpload } from "../use-listing-media-upload";
import { apiFetch } from "@/lib/api-client";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

// ── Fake XHR ─────────────────────────────────────────────────────────────
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => {
    // Real XHR fires the abort event asynchronously via the event loop; the
    // hook's cleanup effect only needs abort() to eventually trigger onabort,
    // so firing synchronously here is an acceptable, simpler fake.
    this.onabort?.();
  });
  constructor() {
    FakeXHR.instances.push(this);
  }
}

function makeSignedUrlResponse(storageKey = "k1") {
  return {
    data: {
      uploadUrl: "https://storage.example/upload",
      method: "PUT" as const,
      headers: {},
      storageKey,
    },
  };
}

function mockApiFetch(opts: {
  complete?: { photoKeys: string[]; videoKeys: string[] };
  completeRejects?: boolean;
} = {}) {
  const complete = opts.complete ?? { photoKeys: ["k1"], videoKeys: [] };
  vi.mocked(apiFetch).mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.endsWith("/media/upload-url")) {
      return Promise.resolve(makeSignedUrlResponse());
    }
    if (u.endsWith("/media/complete")) {
      return opts.completeRejects
        ? Promise.reject(new Error("network error"))
        : Promise.resolve({ data: complete });
    }
    return Promise.reject(new Error(`unexpected apiFetch call: ${u}`));
  });
}

function makePhotoFile(name = "photo.jpg") {
  return new File(["x"], name, { type: "image/jpeg" });
}

/** Enqueue one file and wait until the hook has created its XHR (i.e. the
 * upload-url mint round-trip completed and xhr.send() was called). */
async function enqueueAndReachXHR(
  result: { current: ReturnType<typeof useListingMediaUpload> },
  file: File,
) {
  await act(async () => {
    result.current.enqueue([file]);
  });
  await waitFor(() => expect(FakeXHR.instances.length).toBe(1));
  return FakeXHR.instances[0];
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  vi.mocked(apiFetch).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("useListingMediaUpload — mounted happy path (non-regression pin)", () => {
  it("calls /complete and onSuccess on a normal mounted upload", async () => {
    mockApiFetch();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useListingMediaUpload({ listingId: "L1", onSuccess }),
    );

    const xhr = await enqueueAndReachXHR(result, makePhotoFile());
    xhr.status = 200;
    await act(async () => {
      xhr.onload?.();
    });

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/listings/L1/media/complete",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ photoKeys: ["k1"], videoKeys: [] }));
    await waitFor(() =>
      expect(result.current.queue.find((q) => q.id === result.current.queue[0]?.id)?.status).toBe(
        "done",
      ),
    );
  });
});

describe("useListingMediaUpload — Fix A: unmount between onload and /complete", () => {
  it("still calls apiFetch(.../media/complete) even though the host unmounted first (orphan prevention)", async () => {
    mockApiFetch();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() =>
      useListingMediaUpload({ listingId: "L1", onSuccess }),
    );

    const xhr = await enqueueAndReachXHR(result, makePhotoFile());
    xhr.status = 200;

    // Fire onload (resolves the upload promise) and unmount BEFORE the
    // promise continuation (a microtask) has a chance to run — this
    // reproduces the exact race the bug report describes: bytes are in
    // storage, but the component is gone by the time runOne resumes.
    xhr.onload?.();
    unmount();

    // Flush the microtask queue so runOne's continuation executes.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      "/listings/L1/media/complete",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does NOT call onSuccess after that unmount, even though /complete was called (second guard still holds)", async () => {
    mockApiFetch();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() =>
      useListingMediaUpload({ listingId: "L1", onSuccess }),
    );

    const xhr = await enqueueAndReachXHR(result, makePhotoFile());
    xhr.status = 200;

    xhr.onload?.();
    unmount();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("useListingMediaUpload — mid-transfer unmount (non-regression pin)", () => {
  it("aborts the XHR and never calls /complete when unmounted before onload fires", async () => {
    mockApiFetch();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() =>
      useListingMediaUpload({ listingId: "L1", onSuccess }),
    );

    const xhr = await enqueueAndReachXHR(result, makePhotoFile());

    // Unmount BEFORE onload — the cleanup effect aborts the in-flight XHR,
    // which rejects the upload promise via onabort → the catch block sets
    // status "error". /complete must never be reached.
    unmount();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(xhr.abort).toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalledWith(
      "/listings/L1/media/complete",
      expect.anything(),
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
