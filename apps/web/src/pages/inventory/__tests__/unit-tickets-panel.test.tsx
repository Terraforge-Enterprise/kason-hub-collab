import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Mocks (mirrors listing-media-panel / task-drawer test conventions) ───────

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(),
  getStoredUser: vi.fn(() => null),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import type { HistoryRow, TicketRow } from "@/api/tasks";
import type { UnitMiniStat } from "@kason/shared";
import { UnitTicketsPanel } from "../unit-tickets-panel";

// ── Phase-2 mini-stat flag + hook mocks (hoisted, default OFF) ────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIsPhase2FlagEnabled = vi.fn<any>(() => false);
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => mockIsPhase2FlagEnabled(flag),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUseUnitMiniStat = vi.fn<any>();
vi.mock("@/api/analytics", () => ({
  useUnitMiniStat: (unitId: string) => mockUseUnitMiniStat(unitId),
}));

const apiFetchMock = vi.mocked(apiFetch);
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

function setRole(role: string) {
  mockUseAuth.mockReturnValue({
    user: { id: "u-admin", fullName: "Ops Admin", email: "ops@example.com", role, orgId: "org-1" },
    isAuthenticated: true,
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const openTicket: TicketRow = {
  id: "t-1",
  unitId: "unit-1",
  title: "Leaking sink",
  description: null,
  category: "plumbing",
  status: "open",
  warrantyFlag: false,
  attachmentKeys: [],
  historyCount: 0,
  resolvedAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
};

const resolvedWarrantyTicket: TicketRow = {
  id: "t-2",
  unitId: "unit-1",
  title: "Oven warranty repair",
  description: null,
  category: "appliance",
  status: "resolved",
  warrantyFlag: true,
  attachmentKeys: [],
  historyCount: 1,
  resolvedAt: "2026-06-05T00:00:00.000Z",
  createdAt: "2026-05-20T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

const createdTicket: TicketRow = {
  ...openTicket,
  id: "t-new",
  title: "Broken hinge",
  category: null,
  warrantyFlag: true,
  updatedAt: "2026-06-11T00:00:00.000Z",
};

const historyRows: HistoryRow[] = [
  {
    id: "h-1",
    ticketId: "t-2",
    unitId: "unit-1",
    entry: "Replaced heating element",
    attachmentKeys: ["units/unit-1/history/h1.jpg"],
    actor: { id: "u-1", fullName: "Jane Doe" },
    ticket: { id: "t-2", title: "Oven warranty repair", status: "resolved" },
    occurredOn: "2026-06-05T00:00:00.000Z",
    createdAt: "2026-06-05T08:00:00.000Z",
  },
];

const historyAttachmentUrls = [
  {
    key: "units/unit-1/history/h1.jpg",
    url: "https://files.example/h1.jpg",
    thumbnail: "https://files.example/h1-thumb.jpg",
    kind: "image" as const,
  },
];

function stubApi() {
  apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    const ok = (data: unknown) => Promise.resolve({ data }) as ReturnType<typeof apiFetch>;
    if (path === "/units/unit-1/tickets" && method === "POST") return ok(createdTicket);
    if (path.startsWith("/units/unit-1/tickets")) {
      return ok([openTicket, resolvedWarrantyTicket]);
    }
    if (path === "/units/unit-1/history" && method === "POST") {
      return ok({ history: historyRows[0], ticketId: "t-quick" });
    }
    if (path.startsWith("/units/unit-1/history/attachments/download-urls")) {
      return ok(historyAttachmentUrls);
    }
    if (path.startsWith("/units/unit-1/history")) return ok(historyRows);
    if (path.includes("/resolve")) {
      return ok({ ticket: { ...openTicket, status: "resolved" }, history: historyRows[0] });
    }
    if (path.includes("/reopen")) {
      return ok({ ...resolvedWarrantyTicket, status: "open", updatedAt: "2026-06-11T00:00:00.000Z" });
    }
    if (path.includes("/void")) return ok({ ...openTicket, status: "void" });
    if (path.includes("/attachments/download-urls")) return ok([]);
    if (path.startsWith("/tickets/") && method === "PATCH") return ok(openTicket);
    return ok([]);
  });
}

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/** Z-ISO UTC midnight for today — matches the dialogs' default occurredOn. */
function todayUtcIso(): string {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).toISOString();
}

function postBody(path: string): Record<string, unknown> {
  const call = apiFetchMock.mock.calls.find(
    (c) => c[0] === path && (c[1] as RequestInit | undefined)?.method === "POST",
  )!;
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubApi();
  // Default: flag OFF, hook returns idle state
  mockIsPhase2FlagEnabled.mockReturnValue(false);
  mockUseUnitMiniStat.mockReturnValue({ data: undefined, isLoading: false });
});

// ── Tickets tab ───────────────────────────────────────────────────────────────

describe("UnitTicketsPanel — tickets table + filters", () => {
  it("renders ticket rows and narrows server-side when exactly one status pill is selected", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));

    expect(await screen.findByRole("button", { name: "Leaking sink" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Oven warranty repair" })).toBeInTheDocument();

    const statusBar = screen.getByRole("group", { name: "Status filter" });
    fireEvent.click(within(statusBar).getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some((c) => c[0] === "/units/unit-1/tickets?status=open"),
      ).toBe(true);
    });
  });

  it("category filter narrows via the debounced category param", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    fireEvent.change(screen.getByLabelText("Category filter"), {
      target: { value: "plumbing" },
    });

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("category=plumbing"),
        ),
      ).toBe(true);
    });
  });

  it("renders the gold Warranty badge only on warranty rows and narrows via warrantyFlag=true", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));

    const warrantyRow = (
      await screen.findByRole("button", { name: "Oven warranty repair" })
    ).closest("tr")!;
    expect(within(warrantyRow).getByText("Warranty")).toBeInTheDocument();

    const plainRow = screen.getByRole("button", { name: "Leaking sink" }).closest("tr")!;
    expect(within(plainRow).queryByText("Warranty")).toBeNull();

    const warrantyFilter = screen.getByRole("radiogroup", { name: "Warranty filter" });
    fireEvent.click(within(warrantyFilter).getByRole("radio", { name: "Warranty only" }));

    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("warrantyFlag=true"),
        ),
      ).toBe(true);
    });
  });
});

// ── Create flow ───────────────────────────────────────────────────────────────

describe("UnitTicketsPanel — create ticket", () => {
  it("POSTs /units/:id/tickets with warrantyFlag:true, then stays open in attach-evidence state", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    fireEvent.click(screen.getByRole("button", { name: "New Ticket" }));
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Broken hinge" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /warranty item/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));

    // STAYS OPEN — flips to the edit view with the attach-evidence Callout.
    expect(
      await screen.findByText("Ticket created — attach evidence below."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();

    expect(postBody("/units/unit-1/tickets")).toEqual({
      title: "Broken hinge",
      warrantyFlag: true,
      // Task-seed defaults (parity with the New task form): unset controls
      // still post explicit medium/unassigned/no-due-date.
      priority: "medium",
      assigneeUserId: null,
      dueOn: null,
    });
  });
});

// ── Resolve flow ──────────────────────────────────────────────────────────────

describe("UnitTicketsPanel — resolve ticket", () => {
  it("POSTs /tickets/:id/resolve with entry, occurredOn, attachmentKeys, updatedAt", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));

    fireEvent.click(await screen.findByRole("button", { name: "Leaking sink" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));

    fireEvent.change(await screen.findByLabelText("Entry"), {
      target: { value: "Fixed the trap seal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve ticket" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tickets/t-1/resolve",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(postBody("/tickets/t-1/resolve")).toEqual({
      updatedAt: openTicket.updatedAt,
      entry: "Fixed the trap seal",
      occurredOn: todayUtcIso(),
      attachmentKeys: [],
    });
    expect(toastSuccess).toHaveBeenCalledWith("Resolved — history entry added");
  });

  it("reseeds the concurrency token after a resolve 409 so retry sends the FRESH updatedAt", async () => {
    setRole("editor");
    const freshTicket: TicketRow = {
      ...openTicket,
      // Distinct title makes the reseed observable in the DOM (drawer/dialog
      // descriptions) so the retry click deterministically follows it.
      title: "Leaking sink (edited elsewhere)",
      updatedAt: "2026-06-11T05:00:00.000Z",
    };
    let resolveAttempts = 0;
    apiFetchMock.mockImplementation((path: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      const ok = (data: unknown) => Promise.resolve({ data }) as ReturnType<typeof apiFetch>;
      if (path === "/tickets/t-1/resolve" && method === "POST") {
        resolveAttempts += 1;
        if (resolveAttempts === 1) {
          return Promise.reject(
            Object.assign(new Error("Conflict — ticket was updated elsewhere"), { status: 409 }),
          ) as ReturnType<typeof apiFetch>;
        }
        return ok({ ticket: { ...freshTicket, status: "resolved" }, history: historyRows[0] });
      }
      // Drawer conflict-recovery reseed.
      if (path === "/tickets/t-1" && method === "GET") return ok(freshTicket);
      if (path.startsWith("/units/unit-1/tickets")) {
        return ok([openTicket, resolvedWarrantyTicket]);
      }
      if (path.includes("/attachments/download-urls")) return ok([]);
      return ok([]);
    });

    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    fireEvent.click(await screen.findByRole("button", { name: "Leaking sink" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    fireEvent.change(await screen.findByLabelText("Entry"), {
      target: { value: "Fixed it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve ticket" }));

    // 409 surfaced + drawer reseeded its snapshot via GET /tickets/t-1.
    await waitFor(() => {
      expect(
        apiFetchMock.mock.calls.some(
          (c) =>
            c[0] === "/tickets/t-1" &&
            ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET",
        ),
      ).toBe(true);
    });
    expect(toastError).toHaveBeenCalled();
    // Reseed has rendered (fresh title flows into the drawer/dialog).
    expect((await screen.findAllByText("Leaking sink (edited elsewhere)")).length).toBeGreaterThan(0);

    // Retry from the SAME dialog (entry retained) — must carry the fresh token.
    fireEvent.click(screen.getByRole("button", { name: "Resolve ticket" }));
    await waitFor(() => expect(resolveAttempts).toBe(2));

    const resolveCalls = apiFetchMock.mock.calls.filter((c) => c[0] === "/tickets/t-1/resolve");
    const secondBody = JSON.parse(
      (resolveCalls[1][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(secondBody.updatedAt).toBe(freshTicket.updatedAt);
    expect(secondBody.entry).toBe("Fixed it");
  });
});

// ── History tab ───────────────────────────────────────────────────────────────

describe("UnitTicketsPanel — history timeline", () => {
  it("renders immutable entries with NO edit/delete controls", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    const tabs = screen.getByRole("radiogroup", { name: "Tickets & history view" });
    fireEvent.click(within(tabs).getByRole("radio", { name: "History" }));

    expect(await screen.findByText("Replaced heating element")).toBeInTheDocument();

    const timeline = screen.getByTestId("history-timeline");
    expect(within(timeline).getByText("2026-06-05")).toBeInTheDocument();
    expect(within(timeline).getByText("by Jane Doe")).toBeInTheDocument();
    // Source-ticket chip: title + status pill.
    expect(within(timeline).getByText("Oven warranty repair")).toBeInTheDocument();
    expect(within(timeline).getByText("Resolved")).toBeInTheDocument();
    // STRICTLY ZERO edit/delete affordances on the immutable log.
    expect(within(timeline).queryByRole("button", { name: /edit|delete/i })).toBeNull();
  });
});

// ── Lifecycle gating ──────────────────────────────────────────────────────────

describe("UnitTicketsPanel — void/reopen gating", () => {
  it("hides Void from editors but shows it to managers", async () => {
    setRole("editor");
    const first = render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    fireEvent.click(await screen.findByRole("button", { name: "Leaking sink" }));
    expect(await screen.findByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void" })).toBeNull();
    first.unmount();

    setRole("manager");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    fireEvent.click(await screen.findByRole("button", { name: "Leaking sink" }));
    expect(await screen.findByRole("button", { name: "Void" })).toBeInTheDocument();
  });

  it("Reopen on a resolved ticket fires POST /tickets/:id/reopen with the concurrency token", async () => {
    setRole("manager");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));

    fireEvent.click(await screen.findByRole("button", { name: "Oven warranty repair" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/tickets/t-2/reopen",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(postBody("/tickets/t-2/reopen")).toEqual({
      updatedAt: resolvedWarrantyTicket.updatedAt,
    });
  });
});

// ── Quick log ─────────────────────────────────────────────────────────────────

describe("UnitTicketsPanel — quick log", () => {
  it("POSTs /units/:id/history with the full payload", async () => {
    setRole("editor");
    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    const tabs = screen.getByRole("radiogroup", { name: "Tickets & history view" });
    fireEvent.click(within(tabs).getByRole("radio", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Entry" }));

    fireEvent.change(await screen.findByLabelText("Entry"), {
      target: { value: "Quarterly aircond service" },
    });
    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: "Aircond service" },
    });
    // CategoryCombobox: select "Other" to reveal the free-text input, then type the custom value.
    fireEvent.change(screen.getByLabelText(/^Category/), {
      target: { value: "Other" },
    });
    fireEvent.change(screen.getByPlaceholderText(/specify the category/i), {
      target: { value: "aircond" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /warranty item/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add entry" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/units/unit-1/history",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(postBody("/units/unit-1/history")).toEqual({
      entry: "Quarterly aircond service",
      occurredOn: todayUtcIso(),
      attachmentKeys: [],
      warrantyFlag: true,
      title: "Aircond service",
      category: "aircond",
    });
    expect(toastSuccess).toHaveBeenCalledWith("History entry added.");
  });
});

// ── Phase-2 mini-stat block ───────────────────────────────────────────────────

const miniStatData: UnitMiniStat = {
  unitId: "unit-1",
  total: 8,
  open: 1,
  windowTotal: 6,
  byCategory: [
    { canonical: "plumbing", count: 4, isMapped: true, recurring: true },
    { canonical: "electrical", count: 2, isMapped: true, recurring: false },
  ],
  recurringCategories: ["plumbing"],
  tickets: [],
};

describe("UnitTicketsPanel — mini-stat block (Phase-2 gated)", () => {
  it("flag ON + data → renders counts and recurring badge", async () => {
    setRole("editor");
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseUnitMiniStat.mockReturnValue({
      data: { data: miniStatData },
      isLoading: false,
    });

    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    const block = await screen.findByTestId("unit-mini-stat");
    expect(block).toBeInTheDocument();
    expect(block).toHaveTextContent("8 problems");
    expect(block).toHaveTextContent("1 open");

    const badge = screen.getByTestId("recurring-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("plumbing recurring (×4)");
  });

  it("flag ON + total=0 → renders 'No problems logged' placeholder", async () => {
    setRole("editor");
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseUnitMiniStat.mockReturnValue({
      data: {
        data: {
          ...miniStatData,
          total: 0,
          open: 0,
          windowTotal: 0,
          byCategory: [],
          recurringCategories: [],
        } satisfies UnitMiniStat,
      },
      isLoading: false,
    });

    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    const block = await screen.findByTestId("unit-mini-stat");
    expect(block).toHaveTextContent("No problems logged");
    expect(screen.queryByTestId("recurring-badge")).toBeNull();
  });

  it("flag ON + loading → mini-stat block absent (no skeleton flicker)", async () => {
    setRole("editor");
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockUseUnitMiniStat.mockReturnValue({ data: undefined, isLoading: true });

    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    expect(screen.queryByTestId("unit-mini-stat")).toBeNull();
  });

  it("flag OFF → mini-stat block absent and useUnitMiniStat never called", async () => {
    setRole("editor");
    // flag stays OFF (default in beforeEach)

    render(withQuery(<UnitTicketsPanel unitId="unit-1" />));
    await screen.findByRole("button", { name: "Leaking sink" });

    expect(screen.queryByTestId("unit-mini-stat")).toBeNull();
    expect(mockUseUnitMiniStat).not.toHaveBeenCalled();
  });
});
