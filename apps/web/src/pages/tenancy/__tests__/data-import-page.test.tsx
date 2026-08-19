// Data Import page (M9) — render smoke tests against a production-shaped fixture.
// Conventions: RTL + QueryClientProvider + MemoryRouter + AuthContext + fetch mock.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// Sonner — page surfaces dry-run success/error through toasts.
vi.mock("sonner", () => {
  const success = vi.fn();
  const error = vi.fn();
  const toastBase = vi.fn();
  (toastBase as { success?: typeof success }).success = success;
  (toastBase as { error?: typeof error }).error = error;
  return { toast: toastBase };
});

// Feature flags — all phase2 flags off except tenant-tracker (which gates this page).
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_TENANT_TRACKER",
}));

import { AuthContext, type User } from "@/lib/auth";
import DataImportPage from "../data-import-page";
import type { ImportRun } from "@/api/data-import";

// ── Fixtures (production-shaped) ──────────────────────────────────────────────

const RUN_DRY: ImportRun = {
  id: "run-1",
  dryRun: true,
  status: "completed",
  rowsParsed: 42,
  partiesCreated: 10,
  partiesMatched: 30,
  tenanciesCreated: 8,
  rowsSkipped: 2,
  conflicts: 1,
  sourceFile: "master-list-2026-06.xlsx",
  reportKey: "reports/run-1.xlsx",
  triggeredBy: "admin@kaen.my",
  createdAt: "2026-06-14T10:00:00.000Z",
};

const RUN_RUNNING: ImportRun = {
  id: "run-2",
  dryRun: false,
  status: "running",
  rowsParsed: 0,
  partiesCreated: 0,
  partiesMatched: 0,
  tenanciesCreated: 0,
  rowsSkipped: 0,
  conflicts: 0,
  sourceFile: null,
  reportKey: null,
  triggeredBy: "cli",
  createdAt: "2026-06-14T11:00:00.000Z",
};

const RUN_FAILED: ImportRun = {
  id: "run-3",
  dryRun: true,
  status: "failed",
  rowsParsed: 5,
  partiesCreated: 0,
  partiesMatched: 0,
  tenanciesCreated: 0,
  rowsSkipped: 0,
  conflicts: 0,
  sourceFile: "bad.xlsx",
  reportKey: null,
  triggeredBy: "admin@kaen.my",
  createdAt: "2026-06-14T09:00:00.000Z",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(runs: ImportRun[]) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/data-import/runs")) {
      return Promise.resolve(jsonResponse(runs));
    }
    return Promise.resolve(jsonResponse({ error: "unexpected request" }, 404));
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function renderPage(runs: ImportRun[] = [RUN_DRY, RUN_RUNNING, RUN_FAILED]) {
  installFetchMock(runs);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const user: User = {
    id: "u1",
    fullName: "Admin User",
    email: "admin@kaen.my",
    role: "admin",
    orgId: "org-1",
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider
        value={{ user, setAuth: () => {}, clearAuth: () => {}, isAuthenticated: true }}
      >
        <MemoryRouter initialEntries={["/tenancy/data-import"]}>
          <DataImportPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DataImportPage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders the page header and CLI-only callout", async () => {
    renderPage();
    // Page title
    expect(await screen.findByText("Data Import")).toBeInTheDocument();
    // Callout explains commit is via CLI
    expect(screen.getByText(/intentionally CLI-only/i)).toBeInTheDocument();
  });

  it("renders run rows with correct status badges from real fixture data", async () => {
    renderPage();

    // completed dry-run row
    expect(await screen.findByTestId("import-run-row-run-1")).toBeInTheDocument();
    // The row carries the mode badge ("Dry run") and status badge ("completed")
    const row1 = screen.getByTestId("import-run-row-run-1");
    expect(row1.textContent).toContain("Dry run");
    expect(row1.textContent).toContain("completed");

    // running commit row
    const row2 = screen.getByTestId("import-run-row-run-2");
    expect(row2.textContent).toContain("Commit");
    expect(row2.textContent).toContain("running");

    // failed dry-run row
    const row3 = screen.getByTestId("import-run-row-run-3");
    expect(row3.textContent).toContain("Dry run");
    expect(row3.textContent).toContain("failed");
  });

  it("completed status badge carries the emerald class", async () => {
    renderPage();
    await screen.findByTestId("import-run-row-run-1");

    // Find the status "completed" badge inside the row — it is a span with
    // the emerald Badge variant class applied.
    const row = screen.getByTestId("import-run-row-run-1");
    const completedBadge = Array.from(row.querySelectorAll("span")).find(
      (el) => el.textContent === "completed",
    );
    expect(completedBadge).toBeDefined();
    expect(completedBadge!.className).toContain("emerald");
  });

  it("running status badge carries the sky class", async () => {
    renderPage();
    await screen.findByTestId("import-run-row-run-2");
    const row = screen.getByTestId("import-run-row-run-2");
    const runningBadge = Array.from(row.querySelectorAll("span")).find(
      (el) => el.textContent === "running",
    );
    expect(runningBadge).toBeDefined();
    expect(runningBadge!.className).toContain("sky");
  });

  it("failed status badge carries the rose class", async () => {
    renderPage();
    await screen.findByTestId("import-run-row-run-3");
    const row = screen.getByTestId("import-run-row-run-3");
    const failedBadge = Array.from(row.querySelectorAll("span")).find(
      (el) => el.textContent === "failed",
    );
    expect(failedBadge).toBeDefined();
    expect(failedBadge!.className).toContain("rose");
  });

  it("shows the Run dry-run button", async () => {
    renderPage();
    await screen.findByText("Data Import");
    expect(screen.getByRole("button", { name: /run dry-run/i })).toBeInTheDocument();
  });

  it("shows the empty state when there are no runs", async () => {
    renderPage([]);
    expect(await screen.findByText("No import runs yet")).toBeInTheDocument();
    expect(screen.queryByTestId("import-run-row-run-1")).not.toBeInTheDocument();
  });

  it("shows compact counts summary in each row", async () => {
    renderPage();
    await screen.findByTestId("import-run-row-run-1");
    const row = screen.getByTestId("import-run-row-run-1");
    // RUN_DRY: parsed 42, created 10, matched 30, skipped 2, conflicts 1
    expect(row.textContent).toContain("parsed 42");
    expect(row.textContent).toContain("created 10");
    expect(row.textContent).toContain("matched 30");
    expect(row.textContent).toContain("skipped 2");
    expect(row.textContent).toContain("conflicts 1");
  });

  it("does not render a commit button anywhere on the page", async () => {
    renderPage();
    await screen.findByText("Data Import");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /commit/i })).not.toBeInTheDocument(),
    );
  });
});
