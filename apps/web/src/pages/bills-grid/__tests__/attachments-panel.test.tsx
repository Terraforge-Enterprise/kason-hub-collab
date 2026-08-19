// UI Task 7 — AttachmentsPanel. 4 acceptance rows per the brief. Mocks
// @/api/bills-grid's listAttachments/uploadAttachments/deleteAttachment
// directly (mirrors setting-drawer.test.tsx's mocking convention — this
// component owns its own react-query wiring, unlike the presentational
// components/attachments-panel.tsx). File selection goes through the hidden
// `<input type="file">` via `container.querySelector` + `fireEvent.change`,
// mirroring attach-strip.test.tsx (the direct-multipart house analogue).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import { ApiError } from "@/lib/api-client";
import { GRID_QUERY_KEY_ROOT, type AttachmentListItem } from "@/api/bills-grid";
import { AttachmentsPanel } from "../attachments-panel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockListAttachments = vi.fn();
const mockUploadAttachments = vi.fn();
const mockDeleteAttachment = vi.fn();
const mockGetAttachmentUrl = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    listAttachments: (apartmentId: string, period: string) => mockListAttachments(apartmentId, period),
    uploadAttachments: (apartmentId: string, period: string, files: File[]) =>
      mockUploadAttachments(apartmentId, period, files),
    deleteAttachment: (apartmentId: string, attachmentId: string) =>
      mockDeleteAttachment(apartmentId, attachmentId),
    getAttachmentUrl: (attachmentId: string) => mockGetAttachmentUrl(attachmentId),
  };
});

function item(overrides: Partial<AttachmentListItem> = {}): AttachmentListItem {
  return {
    id: "att-1",
    filename: "owner-receipt.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    storageKey: "org/apt-1/att-1.pdf",
    uploadedBy: "user-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(role: User["role"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test", email: "t@t.com", role, orgId: "org-1" };
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <AttachmentsPanel apartmentId="apt-1" periodMonth="2026-07-01" />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector("input[type='file']") as HTMLInputElement;
  expect(input).toBeTruthy();
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttachmentsPanel", () => {
  it("owner-owned: a file uploaded via the per-unit button is viewable and attaches to NO expense line", async () => {
    mockListAttachments.mockResolvedValue({ items: [] });
    mockUploadAttachments.mockResolvedValue({ data: [{ id: "att-1", storageKey: "org/apt-1/att-1.pdf" }] });

    const { container } = renderPanel("manager");

    await screen.findByText("No attachments yet.");

    // After a confirmed 2xx upload, the list refetches and shows the row —
    // owned entirely by this panel, with NO expense-line/tenancy API ever
    // touched (the mocked module only exposes attachment functions).
    mockListAttachments.mockResolvedValue({ items: [item()] });
    pickFile(container, new File(["pdf-bytes"], "owner-receipt.pdf", { type: "application/pdf" }));

    expect(await screen.findByText("owner-receipt.pdf")).toBeInTheDocument();
    expect(mockUploadAttachments).toHaveBeenCalledWith("apt-1", "2026-07-01", [expect.any(File)]);
  });

  it("502: a failed delete keeps the row and shows Couldn't remove file — Retry", async () => {
    mockListAttachments.mockResolvedValue({ items: [item()] });
    mockDeleteAttachment.mockRejectedValue(
      new ApiError("ATTACHMENT_DELETE_FAILED", 502, undefined, { error: "ATTACHMENT_DELETE_FAILED" }),
    );

    renderPanel("manager");

    const deleteButton = await screen.findByRole("button", { name: "Delete owner-receipt.pdf" });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(mockDeleteAttachment).toHaveBeenCalledWith("apt-1", "att-1"));

    // The row STAYS (server retained it — no orphan) and the retry affordance shows.
    expect(await screen.findByText("Couldn't remove file — Retry")).toBeInTheDocument();
    expect(screen.getByText("owner-receipt.pdf")).toBeInTheDocument();
  });

  it("upload failed: a non-2xx upload adds no row and shows Upload failed — Retry", async () => {
    mockListAttachments.mockResolvedValue({ items: [] });
    mockUploadAttachments.mockRejectedValue(new Error("Upload failed: 500"));

    const { container } = renderPanel("manager");

    await screen.findByText("No attachments yet.");
    pickFile(container, new File(["pdf-bytes"], "bad.pdf", { type: "application/pdf" }));

    expect(await screen.findByText("Upload failed — Retry")).toBeInTheDocument();
    // No row was optimistically added — the empty state is still showing.
    expect(screen.getByText("No attachments yet.")).toBeInTheDocument();
    expect(screen.queryByText("bad.pdf")).not.toBeInTheDocument();
  });

  it("editor cannot delete: the Delete control is ABSENT for an editor", async () => {
    mockListAttachments.mockResolvedValue({ items: [item()] });

    renderPanel("editor");

    expect(await screen.findByText("owner-receipt.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete owner-receipt.pdf" })).not.toBeInTheDocument();
  });

  // Punch-list Item 4: the admin can PREVIEW an uploaded file (catch a wrong
  // upload). Clicking the filename fetches a short-lived signed URL and opens the
  // inline viewer — a PDF in an <iframe> (an <img> can't paint a PDF). Preview is
  // NOT manager-gated: an editor can view too.
  it("preview: clicking a filename fetches a signed URL and opens the inline viewer (PDF → iframe)", async () => {
    mockListAttachments.mockResolvedValue({ items: [item()] });
    mockGetAttachmentUrl.mockResolvedValue({
      downloadUrl: "https://signed.example/owner-receipt.pdf",
      filename: "owner-receipt.pdf",
      contentType: "application/pdf",
    });

    renderPanel("editor");

    const nameBtn = await screen.findByRole("button", { name: "owner-receipt.pdf" });
    fireEvent.click(nameBtn);

    await waitFor(() => expect(mockGetAttachmentUrl).toHaveBeenCalledWith("att-1"));

    const lightbox = await screen.findByTestId("bill-lightbox");
    await waitFor(() => expect(lightbox.querySelector("iframe")).not.toBeNull());
    expect(lightbox.querySelector("iframe")).toHaveAttribute("src", "https://signed.example/owner-receipt.pdf");
    // The "Open in new tab" escape hatch points at the same signed URL.
    expect(within(lightbox).getByRole("link", { name: /open in new tab/i })).toHaveAttribute(
      "href",
      "https://signed.example/owner-receipt.pdf",
    );
  });

  // Review #3: a failed preview-URL fetch (e.g. the row was deleted between
  // list-render and click → 404) must NOT leave an open-but-blank viewer — it
  // toasts and closes.
  it("preview error: a failed URL fetch closes the viewer and toasts, never a blank lightbox", async () => {
    const { toast } = await import("sonner");
    mockListAttachments.mockResolvedValue({ items: [item()] });
    mockGetAttachmentUrl.mockRejectedValue(
      new ApiError("ATTACHMENT_NOT_FOUND", 404, undefined, { error: "ATTACHMENT_NOT_FOUND" }),
    );

    renderPanel("editor");

    fireEvent.click(await screen.findByRole("button", { name: "owner-receipt.pdf" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't open the attachment."));
    expect(screen.queryByTestId("bill-lightbox")).not.toBeInTheDocument();
  });

  // R6 — a successful upload must re-derive the grid's attachment badge live
  // (no manual refresh). Asserts against the SAME QueryClient instance the
  // panel renders under, not a fresh one (mirrors setting-drawer.test.tsx's
  // R5 guard).
  it("upload invalidates the grid — a successful upload also invalidates the grid root query key", async () => {
    mockListAttachments.mockResolvedValue({ items: [] });
    mockUploadAttachments.mockResolvedValue({ data: [{ id: "att-1", storageKey: "org/apt-1/att-1.pdf" }] });

    const { container, queryClient } = renderPanel("manager");
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    await screen.findByText("No attachments yet.");
    mockListAttachments.mockResolvedValue({ items: [item()] });
    pickFile(container, new File(["pdf-bytes"], "owner-receipt.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(mockUploadAttachments).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });

  // R6 — a successful delete must also re-derive the grid live.
  it("delete invalidates the grid — a successful delete also invalidates the grid root query key", async () => {
    mockListAttachments.mockResolvedValue({ items: [item()] });
    mockDeleteAttachment.mockResolvedValue({ ok: true });

    const { queryClient } = renderPanel("manager");
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    const deleteButton = await screen.findByRole("button", { name: "Delete owner-receipt.pdf" });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(mockDeleteAttachment).toHaveBeenCalledWith("apt-1", "att-1"));
    expect(spy).toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });

  // R6 negative guard — a 502 ATTACHMENT_DELETE_FAILED retains the row
  // server-side (no attachment row may ever point at a missing object); the
  // grid must NOT be told to refetch on that path — onError only sets the
  // per-row Retry affordance, same pattern as the 502 test above.
  it("502 does not invalidate the grid — a failed delete does NOT invalidate the grid root query key", async () => {
    mockListAttachments.mockResolvedValue({ items: [item()] });
    mockDeleteAttachment.mockRejectedValue(
      new ApiError("ATTACHMENT_DELETE_FAILED", 502, undefined, { error: "ATTACHMENT_DELETE_FAILED" }),
    );

    const { queryClient } = renderPanel("manager");
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    const deleteButton = await screen.findByRole("button", { name: "Delete owner-receipt.pdf" });
    fireEvent.click(deleteButton);

    await screen.findByText("Couldn't remove file — Retry");
    expect(spy).not.toHaveBeenCalledWith({ queryKey: GRID_QUERY_KEY_ROOT });
  });
});

// REGRESSION (2026-08-19). An admin filed a supplier bill here and expected the
// tenant's proforma to carry it. It never can: these rows carry `expenseId: null`,
// and BOTH pdf.service source B and attachment-pdf-invalidation gate that source on
// `counterpartyType === "owner"` — so the file reaches owner documents only, and not
// even a re-Bill changes that (proved by the sibling API suite
// apps/api/src/modules/bills-grid/__tests__/attachment-scope.integration.test.ts).
// The BEHAVIOUR stays (a unit-level bill covers the whole unit, i.e. other tenants'
// consumption); the panel must SAY so and name the control that does reach a tenant.
// Asserting the destination words specifically — a generic "renders a Callout" check
// would survive someone rewriting the copy into something silent again.
describe("AttachmentsPanel — owner-only scope disclosure", () => {
  beforeEach(() => {
    mockListAttachments.mockResolvedValue({ items: [] });
  });

  it("says these files never reach a tenant, and points at the per-line control", async () => {
    renderPanel("manager");
    await screen.findByText("No attachments yet.");

    const note = screen.getByText(/Owner-only/i).closest("div")!;
    expect(note).toHaveTextContent(/never on a tenant's invoice or proforma/i);
    expect(note).toHaveTextContent(/attach it to that expense line in Expenses/i);
  });

  it("the panel title names the owner scope, not just 'Attachments'", async () => {
    renderPanel("manager");
    expect(await screen.findByText("Unit bills (owner)")).toBeInTheDocument();
  });

  it("an editor (non-manager) sees the disclosure too — it is not manager-gated", async () => {
    renderPanel("editor");
    await screen.findByText("No attachments yet.");
    expect(screen.getByText(/Owner-only/i)).toBeInTheDocument();
  });
});
