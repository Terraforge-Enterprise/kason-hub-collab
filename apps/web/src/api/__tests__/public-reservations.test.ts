// public-reservations.test.ts — Task 8 (reservation ID-upload fields).
//
// Pure web unit test: mocks global fetch (and XMLHttpRequest for the upload
// fn) and asserts the new public reservation client fns target the right
// /public-api/reservations/:token/... URLs + HTTP methods, and that they
// surface server error messages from a non-2xx JSON body. No DB, no
// portalApiFetch — this bundle is the unauthenticated public one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  requestReservationUploadUrl,
  uploadReservationFile,
  markReservationDoc,
  deleteReservationDoc,
  type ReservationUploadSigned,
} from "../public-reservations";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("public-reservations API client — upload fns", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("requestReservationUploadUrl", () => {
    it("requests upload url — targets /public-api/reservations/:token/upload-url via POST and returns signed config", async () => {
      const signed: ReservationUploadSigned = {
        uploadUrl: "https://storage.example/upload",
        method: "PUT",
        headers: { "x-amz-foo": "bar" },
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: signed }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await requestReservationUploadUrl("tok123", {
        kind: "nric_front",
        contentType: "image/png",
        filename: "id.png",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("/public-api/reservations/tok123/upload-url");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "content-type": "application/json" });
      expect(JSON.parse(init.body)).toEqual({
        kind: "nric_front",
        contentType: "image/png",
        filename: "id.png",
      });
      expect(result).toEqual(signed);
    });

    it("surfaces upload error — a non-200 upload-url response throws with the server error message", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ error: "Document kind already uploaded" }, 409));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        requestReservationUploadUrl("tok123", {
          kind: "nric_front",
          contentType: "image/png",
          filename: "id.png",
        }),
      ).rejects.toThrow("Document kind already uploaded");
    });

    it("falls back to a generic status message when the error body has no `error` field", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        requestReservationUploadUrl("tok123", {
          kind: "nric_front",
          contentType: "image/png",
          filename: "id.png",
        }),
      ).rejects.toThrow("Upload URL failed: 500");
    });
  });

  describe("markReservationDoc", () => {
    it("targets /public-api/reservations/:token/documents/mark-uploaded via POST and returns the doc", async () => {
      const doc = { id: "d1", kind: "nric_front", filename: "id.png", uploadedAt: "2026-07-17T00:00:00.000Z" };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: doc }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await markReservationDoc("tok123", { kind: "nric_front", filename: "id.png" });

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("/public-api/reservations/tok123/documents/mark-uploaded");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ kind: "nric_front", filename: "id.png" });
      expect(result).toEqual(doc);
    });

    it("surfaces server error message on failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Not found" }, 404));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        markReservationDoc("tok123", { kind: "nric_front", filename: "id.png" }),
      ).rejects.toThrow("Not found");
    });
  });

  describe("deleteReservationDoc", () => {
    it("targets /public-api/reservations/:token/documents/:kind via DELETE", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, 204));
      vi.stubGlobal("fetch", fetchMock);

      await deleteReservationDoc("tok123", "nric_front");

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("/public-api/reservations/tok123/documents/nric_front");
      expect(init.method).toBe("DELETE");
    });

    it("surfaces server error message on failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Cannot delete" }, 400));
      vi.stubGlobal("fetch", fetchMock);

      await expect(deleteReservationDoc("tok123", "nric_front")).rejects.toThrow("Cannot delete");
    });
  });

  describe("uploadReservationFile", () => {
    class FakeXHR {
      static instances: FakeXHR[] = [];
      status = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn();
      constructor() {
        FakeXHR.instances.push(this);
      }
    }

    beforeEach(() => {
      FakeXHR.instances = [];
    });

    it("opens with the signed method/url, sets headers, and sends the file", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
      const signed: ReservationUploadSigned = {
        uploadUrl: "https://storage.example/upload",
        method: "PUT",
        headers: { "x-amz-foo": "bar" },
      };
      const file = new File(["x"], "id.png", { type: "image/png" });

      const promise = uploadReservationFile(signed, file);
      const xhr = FakeXHR.instances[0];
      expect(xhr.open).toHaveBeenCalledWith("PUT", signed.uploadUrl);
      expect(xhr.setRequestHeader).toHaveBeenCalledWith("x-amz-foo", "bar");
      expect(xhr.send).toHaveBeenCalledWith(file);

      xhr.status = 200;
      xhr.onload?.();
      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects when the upload responds with a non-2xx status", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
      const signed: ReservationUploadSigned = {
        uploadUrl: "https://storage.example/upload",
        method: "PUT",
        headers: {},
      };
      const file = new File(["x"], "id.png", { type: "image/png" });

      const promise = uploadReservationFile(signed, file);
      const xhr = FakeXHR.instances[0];
      xhr.status = 403;
      xhr.onload?.();
      await expect(promise).rejects.toThrow("Upload failed (403)");
    });

    it("reports progress via onProgress when the upload emits progress events", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
      const signed: ReservationUploadSigned = {
        uploadUrl: "https://storage.example/upload",
        method: "PUT",
        headers: {},
      };
      const file = new File(["x"], "id.png", { type: "image/png" });
      const onProgress = vi.fn();

      const promise = uploadReservationFile(signed, file, onProgress);
      const xhr = FakeXHR.instances[0];
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      expect(onProgress).toHaveBeenCalledWith(50);

      xhr.status = 200;
      xhr.onload?.();
      await promise;
    });
  });
});
