import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// The mock FPX bank page stands in for the external bank redirect target. It
// reads ?txn + ?amount, shows a deliberately-plain card, and POSTs the outcome
// to the PUBLIC /webhooks/fpx/mock-confirm webhook (NOT /portal-api → a bare
// fetch, never portalApiFetch), then returns the payer to /portal/payments.

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import PortalFpxMockPage from "../fpx-mock";

function renderPage(search = "?txn=TXN123&amount=150.00") {
  return render(
    <MemoryRouter initialEntries={[`/portal/fpx/mock${search}`]}>
      <PortalFpxMockPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PortalFpxMockPage", () => {
  it("renders the amount from the query", () => {
    renderPage();
    // getByText throws if absent → presence asserted without jest-dom matchers
    // (toBeInTheDocument is not wired up in the worktree vitest env).
    expect(screen.getByText("RM 150.00")).toBeTruthy();
  });

  it("Pay POSTs mock-confirm success then navigates ?fpx=success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Pay RM\s*150\.00/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/webhooks/fpx/mock-confirm");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      providerTxnId: "TXN123",
      outcome: "success",
    });

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/portal/payments?fpx=success"),
    );
  });

  it("Simulate failure POSTs mock-confirm failure then navigates ?fpx=failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Simulate failure/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/webhooks/fpx/mock-confirm");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      providerTxnId: "TXN123",
      outcome: "failure",
    });

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/portal/payments?fpx=failed"),
    );
  });

  // Regression: on split-origin deploys (web on CloudFront, API on Lightsail) a
  // bare same-origin fetch hits CloudFront and silently returns index.html, so
  // the settle never reaches the API. The URL must be prefixed with the public
  // API base when one is configured.
  it("prefixes VITE_PUBLIC_API_BASE so the settle reaches the API on split-origin deploys", async () => {
    vi.stubEnv("VITE_PUBLIC_API_BASE", "https://api.example.com");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("ok") });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Pay RM\s*150\.00/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/webhooks/fpx/mock-confirm");
  });
});
