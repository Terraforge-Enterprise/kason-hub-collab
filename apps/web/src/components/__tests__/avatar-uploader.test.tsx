import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { AvatarUploader } from "../avatar-uploader";

function renderWithQc(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const originalFetch = globalThis.fetch;

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AvatarUploader (admin mode)", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("on file pick: requests upload-url, PUTs file, then PATCHes /me", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ data: { url: "https://put.example", key: "avatars/users/u1/x.jpg", headers: { "content-type": "image/jpeg" } } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // S3 PUT
      .mockResolvedValueOnce(makeResponse({ data: { id: "u1", email: "me@x.com", fullName: "Me", role: "editor", photoKey: "avatars/users/u1/x.jpg", photoUrl: "https://put.example", mustChangePassword: false, lastLoginAt: null } }));

    renderWithQc(<AvatarUploader mode="admin" currentPhotoUrl={null} name="Me" />);

    const file = new File(["dummy"], "avatar.jpg", { type: "image/jpeg" });
    const input = screen.getByLabelText(/upload avatar/i) as HTMLInputElement;
    await userEvent.upload(input, file);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    expect((fetchMock.mock.calls[0][0] as string)).toContain("/profile/avatar/upload-url");
    expect((fetchMock.mock.calls[1][0] as string)).toBe("https://put.example");
    expect((fetchMock.mock.calls[1][1] as RequestInit)?.method).toBe("PUT");
    expect((fetchMock.mock.calls[2][0] as string)).toContain("/profile/me");
  });

  it("rejects files larger than 5MB without firing any request", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    renderWithQc(<AvatarUploader mode="admin" currentPhotoUrl={null} name="Me" />);
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" });
    const input = screen.getByLabelText(/upload avatar/i) as HTMLInputElement;
    await userEvent.upload(input, big);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/max 5MB/i)).toBeInTheDocument();
  });

  it("rejects non-image MIME without firing any request", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    renderWithQc(<AvatarUploader mode="admin" currentPhotoUrl={null} name="Me" />);
    const pdf = new File(["x"], "doc.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText(/upload avatar/i) as HTMLInputElement;
    // applyAccept: false bypasses the input's `accept` attribute filtering so we
    // can test the JS guard. In real usage the native picker honors `accept`,
    // but a determined user can still bypass it (rename .pdf → .jpg) — the JS
    // guard is the actual security layer and must be tested independently.
    await userEvent.upload(input, pdf, { applyAccept: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/JPEG, PNG, or WebP/i)).toBeInTheDocument();
  });
});
