import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAllMedia } from "../download-media";

describe("downloadAllMedia", () => {
  const originalFetch = globalThis.fetch;
  const originalUserAgent = navigator.userAgent;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  function setUserAgent(ua: string) {
    Object.defineProperty(window.navigator, "userAgent", {
      value: ua,
      configurable: true,
    });
  }

  function mockBlobFetch() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      blob: async () => new Blob(["x"], { type: "image/jpeg" }),
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    setUserAgent(originalUserAgent);
    delete (navigator as unknown as { canShare?: unknown }).canShare;
    delete (navigator as unknown as { share?: unknown }).share;
  });

  it("returns immediately when given no urls", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadAllMedia([]);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("downloads via blob URLs on desktop, one click per file", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Chrome");
    mockBlobFetch();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const promise = downloadAllMedia(["https://a.example/1.jpg", "https://b.example/2.jpg"], "unit");
    // First click fires before the throttle; advance past the 600 ms gap to release the second.
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("revokes blob URLs after a delay so the click has time to start the download", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Chrome");
    mockBlobFetch();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const promise = downloadAllMedia(["https://a.example/1.jpg"], "unit");
    await promise;
    // Revoke is scheduled via setTimeout(..., 1000) — should not have fired yet.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("uses Web Share API on mobile when canShare returns true", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    mockBlobFetch();

    await downloadAllMedia(["https://a.example/1.jpg", "https://b.example/2.jpg"], "unit");

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0][0];
    expect(arg.files).toHaveLength(2);
    expect(arg.files[0].name).toBe("unit-1.jpeg");
    expect(arg.files[1].name).toBe("unit-2.jpeg");
  });

  it("falls back to blob downloads when canShare({files}) returns false on mobile", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 13) AppleWebKit Chrome");
    const canShare = vi.fn().mockReturnValue(false);
    const share = vi.fn();
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    mockBlobFetch();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const promise = downloadAllMedia(["https://a.example/1.jpg", "https://b.example/2.jpg"], "unit");
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    expect(share).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to blob downloads when share() throws a non-Abort error", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 13) AppleWebKit Chrome");
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockRejectedValue(new Error("not allowed"));
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    mockBlobFetch();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const promise = downloadAllMedia(["https://a.example/1.jpg", "https://b.example/2.jpg"], "unit");
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    expect(share).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("stops silently when the user cancels the share sheet", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi
      .fn()
      .mockRejectedValue(Object.assign(new DOMException("cancelled", "AbortError")));
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    mockBlobFetch();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadAllMedia(["https://a.example/1.jpg"], "unit");

    expect(share).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
