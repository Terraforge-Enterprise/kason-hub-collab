// The admin reads the slip HERE — it must not leave as a download.
//
// Two of these tests guard properties, not pixels:
//   • the bytes are stamped with the server's mimeType, never with whatever
//     content type storage served (the tenant chooses that one);
//   • an unpreviewable or unreachable slip degrades to a download link rather
//     than to a blank box on a screen whose whole job is looking at proof.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PendingPaymentSlip } from "@/api/payments";
import { SlipViewer } from "../slip-viewer";

const IMAGE_SLIP: PendingPaymentSlip = {
  url: "https://storage.test/sign/slip-1.jpg?download=transfer-slip-PAY-1-1.jpg",
  kind: "image",
  mimeType: "image/jpeg",
  filename: "transfer-slip-PAY-1-1.jpg",
};

const PDF_SLIP: PendingPaymentSlip = {
  url: "https://storage.test/sign/slip-2.pdf?download=transfer-slip-PAY-1-1.pdf",
  kind: "pdf",
  mimeType: "application/pdf",
  filename: "transfer-slip-PAY-1-1.pdf",
};

const UNKNOWN_SLIP: PendingPaymentSlip = {
  url: "https://storage.test/sign/slip-3.bin?download=transfer-slip-PAY-1-1",
  kind: "other",
  mimeType: null,
  filename: "transfer-slip-PAY-1-1",
};

const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let stamped: Blob[] = [];

/** Storage answers with a content type of the tenant's choosing. */
function mockStorage(servedType: string) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["bytes"], { type: servedType }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  stamped = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    stamped.push(b);
    return `blob:slip-${stamped.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  mockStorage("image/jpeg");
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  // Back to the test-setup polyfills, which are real functions — testing-
  // library's auto-cleanup unmounts (and therefore revokes) after this hook.
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("SlipViewer", () => {
  it("shows the slip inline as an image instead of handing over a download", async () => {
    render(<SlipViewer slips={[IMAGE_SLIP]} />);

    const img = await screen.findByAltText("Transfer slip");
    expect(img).toHaveAttribute("src", "blob:slip-1");
    // The URL is fetched, never navigated to.
    expect(globalThis.fetch).toHaveBeenCalledWith(IMAGE_SLIP.url);
  });

  it("stamps the bytes with the server's mimeType, not the served content type", async () => {
    // A slip whose bytes storage is willing to call HTML. Rendering it as HTML
    // is the hole the download disposition was protecting against; re-stamping
    // is what lets us show it inline at all.
    mockStorage("text/html");
    render(<SlipViewer slips={[IMAGE_SLIP]} />);

    await screen.findByAltText("Transfer slip");
    expect(stamped).toHaveLength(1);
    expect(stamped[0].type).toBe("image/jpeg");
  });

  it("opens a full-size viewer when the slip is clicked", async () => {
    render(<SlipViewer slips={[IMAGE_SLIP]} />);

    fireEvent.click(await screen.findByRole("button", { name: /view transfer slip/i }));
    expect(await screen.findByLabelText(/transfer slip viewer/i)).toBeInTheDocument();
  });

  it("renders a PDF slip in place too, with the browser's own fallback inside it", async () => {
    render(<SlipViewer slips={[PDF_SLIP]} />);

    const embedded = await screen.findByTitle("Transfer slip");
    expect(embedded.tagName).toBe("OBJECT");
    expect(embedded).toHaveAttribute("data", "blob:slip-1");
    expect(embedded).toHaveAttribute("type", "application/pdf");
    // The children are what a browser that can't display PDFs shows instead.
    expect(embedded).toHaveTextContent(/open it to check the slip/i);
  });

  it("numbers the slips when a transfer carries more than one", async () => {
    render(<SlipViewer slips={[IMAGE_SLIP, { ...PDF_SLIP }]} />);

    expect(await screen.findByAltText("Transfer slip 1 of 2")).toBeInTheDocument();
    expect(await screen.findByTitle("Transfer slip 2 of 2")).toBeInTheDocument();
  });

  it("falls back to a download for a file it cannot place, without fetching it", async () => {
    render(<SlipViewer slips={[UNKNOWN_SLIP]} />);

    expect(await screen.findByText(/download it to check the slip/i)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("falls back to a download when the bytes cannot be fetched", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch;
    render(<SlipViewer slips={[IMAGE_SLIP]} />);

    expect(await screen.findByText(/download it to check the slip/i)).toBeInTheDocument();
    expect(screen.queryByAltText("Transfer slip")).toBeNull();
  });

  it("falls back to a download when the image will not decode (HEIC off Safari)", async () => {
    render(<SlipViewer slips={[IMAGE_SLIP]} />);

    fireEvent.error(await screen.findByAltText("Transfer slip"));
    expect(await screen.findByText(/download it to check the slip/i)).toBeInTheDocument();
  });

  it("releases the blob when the panel goes away", async () => {
    const { unmount } = render(<SlipViewer slips={[IMAGE_SLIP]} />);
    await screen.findByAltText("Transfer slip");

    unmount();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:slip-1"));
  });
});
