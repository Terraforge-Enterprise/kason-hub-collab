// T1 Task 5 — LineAttachments. Mirrors attachments-panel.test.tsx's mocking
// convention: mocks @/api/bills-grid's listLineAttachments/uploadLineAttachments/
// deleteAttachment directly (this component owns its own react-query wiring).
// File selection goes through the hidden `<input type="file">` via
// `container.querySelector` + `fireEvent.change`. Unlike the panel, this
// component attaches to a single expense LINE and, on an UNSAVED line, routes
// the upload through the `onEnsurePersisted` prop (A1 auto-save-on-attach) —
// the delicate behavior covered explicitly by B3/B4.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type User } from "@/lib/auth";
import { ApiError } from "@/lib/api-client";
import { type AttachmentListItem } from "@/api/bills-grid";
import { LineAttachments } from "../line-attachments";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockListLineAttachments = vi.fn();
const mockUploadLineAttachments = vi.fn();
const mockDeleteAttachment = vi.fn();
const mockGetAttachmentUrl = vi.fn();
vi.mock("@/api/bills-grid", async () => {
  const actual = await vi.importActual<typeof import("@/api/bills-grid")>("@/api/bills-grid");
  return {
    ...actual,
    listLineAttachments: (expenseId: string) => mockListLineAttachments(expenseId),
    uploadLineAttachments: (expenseId: string, files: File[]) =>
      mockUploadLineAttachments(expenseId, files),
    deleteAttachment: (apartmentId: string, attachmentId: string) =>
      mockDeleteAttachment(apartmentId, attachmentId),
    getAttachmentUrl: (attachmentId: string) => mockGetAttachmentUrl(attachmentId),
  };
});

function item(overrides: Partial<AttachmentListItem> = {}): AttachmentListItem {
  return {
    id: "att-1",
    filename: "line-receipt.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    storageKey: "org/entry-1/exp-1/att-1.pdf",
    uploadedBy: "user-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

type PanelProps = {
  expenseId?: string | null;
  apartmentId?: string;
  canUpload?: boolean;
  uploadHint?: string | null;
  isManager?: boolean;
  onEnsurePersisted?: () => Promise<string | null>;
  role?: User["role"];
};

function renderPanel(props: PanelProps = {}) {
  const {
    expenseId = "exp-1",
    apartmentId = "apt-1",
    canUpload = true,
    uploadHint = null,
    isManager = true,
    onEnsurePersisted = vi.fn(async () => null),
    role = "manager",
  } = props;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const user: User = { id: "u1", fullName: "Test", email: "t@t.com", role, orgId: "org-1" };
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}>
        <LineAttachments
          expenseId={expenseId}
          apartmentId={apartmentId}
          canUpload={canUpload}
          uploadHint={uploadHint}
          isManager={isManager}
          onEnsurePersisted={onEnsurePersisted}
        />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, onEnsurePersisted };
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

describe("LineAttachments", () => {
  // B1
  it("lists attachments for a persisted line and uploads to that id", async () => {
    mockListLineAttachments.mockResolvedValue({ items: [] });
    mockUploadLineAttachments.mockResolvedValue({ data: [{ id: "att-1", storageKey: "k" }] });

    const { container } = renderPanel({ expenseId: "exp-1" });

    await screen.findByText("No attachments yet.");
    expect(mockListLineAttachments).toHaveBeenCalledWith("exp-1");

    // After a confirmed 2xx upload the list refetches and the row renders.
    mockListLineAttachments.mockResolvedValue({ items: [item()] });
    pickFile(container, new File(["pdf"], "line-receipt.pdf", { type: "application/pdf" }));

    expect(await screen.findByText("line-receipt.pdf")).toBeInTheDocument();
    expect(mockUploadLineAttachments).toHaveBeenCalledWith("exp-1", [expect.any(File)]);
  });

  // Punch-list Item 4: a per-expense-line attachment previews inline too.
  // An IMAGE renders in an <img> (contentType image/*), pointed at the signed URL.
  it("preview: clicking a line-attachment filename fetches a signed URL and opens the inline viewer (image → img)", async () => {
    mockListLineAttachments.mockResolvedValue({
      items: [item({ filename: "tnb-bill.jpg", contentType: "image/jpeg" })],
    });
    mockGetAttachmentUrl.mockResolvedValue({
      downloadUrl: "https://signed.example/tnb-bill.jpg",
      filename: "tnb-bill.jpg",
      contentType: "image/jpeg",
    });

    renderPanel({ expenseId: "exp-1", isManager: false, role: "editor" });

    const nameBtn = await screen.findByRole("button", { name: "tnb-bill.jpg" });
    fireEvent.click(nameBtn);

    await waitFor(() => expect(mockGetAttachmentUrl).toHaveBeenCalledWith("att-1"));

    const lightbox = await screen.findByTestId("bill-lightbox");
    const img = await within(lightbox).findByRole("img", { name: "tnb-bill.jpg" });
    expect(img).toHaveAttribute("src", "https://signed.example/tnb-bill.jpg");
    expect(lightbox.querySelector("iframe")).toBeNull();
  });

  // Review #3 (line-attachment parity): a failed preview-URL fetch toasts + closes.
  it("preview error: a failed URL fetch closes the viewer and toasts, never a blank lightbox", async () => {
    const { toast } = await import("sonner");
    mockListLineAttachments.mockResolvedValue({ items: [item({ filename: "receipt.jpg", contentType: "image/jpeg" })] });
    mockGetAttachmentUrl.mockRejectedValue(
      new ApiError("ATTACHMENT_NOT_FOUND", 404, undefined, { error: "ATTACHMENT_NOT_FOUND" }),
    );

    renderPanel({ expenseId: "exp-1", isManager: false, role: "editor" });

    fireEvent.click(await screen.findByRole("button", { name: "receipt.jpg" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't open the attachment."));
    expect(screen.queryByTestId("bill-lightbox")).not.toBeInTheDocument();
  });

  // B2 — unsaved + invalid: Upload disabled, hint shown.
  it("disables upload and shows the hint on an unsaved invalid line", async () => {
    renderPanel({
      expenseId: null,
      canUpload: false,
      uploadHint: "Add a description and amount to attach",
    });

    expect(await screen.findByText("Add a description and amount to attach")).toBeInTheDocument();
    const uploadBtn = screen.getByRole("button", { name: /upload/i });
    expect(uploadBtn).toBeDisabled();
  });

  // B3 — unsaved + valid: picking a file auto-persists via onEnsurePersisted,
  // then uploads using the RETURNED id (not the null prop id).
  it("auto-persists then uploads using the returned id", async () => {
    mockListLineAttachments.mockResolvedValue({ items: [] });
    mockUploadLineAttachments.mockResolvedValue({ data: [{ id: "att-1", storageKey: "k" }] });
    const onEnsurePersisted = vi.fn(async () => "exp-new");

    const { container } = renderPanel({ expenseId: null, canUpload: true, onEnsurePersisted });

    // Unsaved → the list query is disabled and the empty state shows.
    await screen.findByText("No attachments yet.");
    pickFile(container, new File(["pdf"], "line-receipt.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(onEnsurePersisted).toHaveBeenCalledTimes(1));
    // Uploaded to the id onEnsurePersisted returned, NOT the null prop.
    expect(mockUploadLineAttachments).toHaveBeenCalledWith("exp-new", [expect.any(File)]);
  });

  // B4 — unsaved + valid but persist FAILS (resolves null): the guard aborts —
  // NO upload occurs. This is the mandated sabotage target (Step 4).
  it("does not upload when onEnsurePersisted returns null", async () => {
    mockListLineAttachments.mockResolvedValue({ items: [] });
    mockUploadLineAttachments.mockResolvedValue({ data: [] });
    const onEnsurePersisted = vi.fn(async () => null);

    const { container } = renderPanel({ expenseId: null, canUpload: true, onEnsurePersisted });

    await screen.findByText("No attachments yet.");
    pickFile(container, new File(["pdf"], "line-receipt.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(onEnsurePersisted).toHaveBeenCalledTimes(1));
    // The persist returned null → the upload MUST be aborted (fail-closed guard).
    expect(mockUploadLineAttachments).not.toHaveBeenCalled();
  });

  // B5 — fail-closed: a rejected upload adds no row and shows a per-file Retry.
  it("fail-closed: a rejected upload shows Retry and adds no row", async () => {
    mockListLineAttachments.mockResolvedValue({ items: [] });
    mockUploadLineAttachments.mockRejectedValue(new Error("Upload failed: 500"));

    const { container } = renderPanel({ expenseId: "exp-1" });

    await screen.findByText("No attachments yet.");
    pickFile(container, new File(["pdf"], "bad.pdf", { type: "application/pdf" }));

    expect(await screen.findByText("Upload failed — Retry")).toBeInTheDocument();
    // No row optimistically added — the empty state is still present.
    expect(screen.getByText("No attachments yet.")).toBeInTheDocument();
    expect(screen.queryByText("bad.pdf")).not.toBeInTheDocument();
  });

  // B6 — permission: the Delete control is ABSENT for an editor (isManager:false).
  it("editor cannot delete: the Delete control is absent", async () => {
    mockListLineAttachments.mockResolvedValue({ items: [item()] });

    renderPanel({ expenseId: "exp-1", isManager: false, role: "editor" });

    expect(await screen.findByText("line-receipt.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete line-receipt.pdf" })).not.toBeInTheDocument();
  });

  // B7 — unsaved: the list query is DISABLED (enabled: !!expenseId) — the client
  // list fn is never called for a null id.
  it("does not list when unsaved (query disabled)", async () => {
    mockListLineAttachments.mockResolvedValue({ items: [] });

    renderPanel({ expenseId: null, canUpload: true });

    await screen.findByText("No attachments yet.");
    expect(mockListLineAttachments).not.toHaveBeenCalled();
  });
});
