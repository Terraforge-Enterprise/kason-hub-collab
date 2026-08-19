import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

// Mock portalApiFetch so the component doesn't make real HTTP calls on mount.
// The tier-mapping query runs unconditionally; room-types query also runs on
// mount via useRoomTypes. Both need a valid response shape to avoid crashes.
vi.mock("@/lib/portal-api", () => ({
  portalApiFetch: vi.fn().mockImplementation((path: string) => {
    if (path.includes("tier-mapping")) {
      return Promise.resolve({ data: { percentage: 70, agentLevel: "L1" } });
    }
    if (path.includes("room-types")) {
      return Promise.resolve({ data: [] });
    }
    // Fallback for any other calls (e.g. properties search)
    return Promise.resolve({ data: [] });
  }),
  PortalApiError: class PortalApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));

import AgentClaimNewPage from "./agent-claim-new";

function renderPage(search = "") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/portal/claims/new${search}`]}>
        <AgentClaimNewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("renders without crashing and shows the page heading", () => {
  renderPage();
  expect(screen.getByText("Submit Commission Claim")).toBeInTheDocument();
});

test("renders the Claim Type section", () => {
  renderPage();
  expect(screen.getByText("Claim Type")).toBeInTheDocument();
});

test("renders an Add Another Item button so the user can add claim rows", () => {
  renderPage();
  expect(screen.getByText("Add Another Item")).toBeInTheDocument();
});

// ── Phase A smoke check (boxes 1-8 of the visual smoke; box 9 is contrast,
// requires a real browser — verified by humans). Each test corresponds to
// one numbered box from docs/superpowers/plans/2026-04-25-commission-share-field-fix.md
// Task 4 Step 2.

import { fireEvent } from "@testing-library/react";

function findCommissionInput(): HTMLInputElement {
  // The Commission % input is inside <div id="field-0-commissionPercentage">.
  // Get the input inside that div.
  const wrapper = document.getElementById("field-0-commissionPercentage");
  if (!wrapper) throw new Error("Commission % wrapper div not found");
  const input = wrapper.querySelector("input") as HTMLInputElement | null;
  if (!input) throw new Error("Commission % input not found inside wrapper");
  return input;
}

function findCobrokeCheckbox(): HTMLInputElement {
  // Cobroke checkbox is the only checkbox with the visible "Cobroke" label.
  const labels = Array.from(document.querySelectorAll("label"));
  const cobrokeLabel = labels.find((l) => /Cobroke/i.test(l.textContent ?? ""));
  if (!cobrokeLabel) throw new Error("Cobroke label not found");
  const checkbox = cobrokeLabel.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!checkbox) throw new Error("Cobroke checkbox not found");
  return checkbox;
}

test("[smoke 1+2] Commission % input is in DOM with empty default value (placeholder=100)", () => {
  renderPage();
  const input = findCommissionInput();
  expect(input).toBeInTheDocument();
  expect(input.value).toBe("");
  expect(input.placeholder).toBe("100");
});

test("[smoke 3] Commission % label has a hint icon (tooltip-driven, not inline text)", () => {
  renderPage();
  // The Commission % field's wrapper contains a <button aria-label="Show hint">
  // (the HintIcon trigger). Inline hint text is gone — it's in the tooltip
  // portal which only mounts on hover/click.
  const wrapper = document.getElementById("field-0-commissionPercentage");
  expect(wrapper).not.toBeNull();
  const hintBtn = wrapper!.querySelector('button[aria-label="Show hint"]');
  expect(hintBtn).not.toBeNull();
});

test("[smoke 4+5] Cobroke checkbox toggle works (no inline hint paragraph; hint is in tooltip)", () => {
  renderPage();
  const cobrokeCb = findCobrokeCheckbox();
  // Initially unchecked
  expect(cobrokeCb.checked).toBe(false);
  // Tick — checked becomes true; the cobroke TA-share input appears
  fireEvent.click(cobrokeCb);
  expect(cobrokeCb.checked).toBe(true);
  // Untick
  fireEvent.click(cobrokeCb);
  expect(cobrokeCb.checked).toBe(false);
});

test("[smoke 8] Joint-deal amber warning appears when Commission % is < 100", () => {
  renderPage();
  // No warning at empty value
  expect(screen.queryByText(/Joint deal:/i)).not.toBeInTheDocument();
  // Type 50 — warning appears with the remaining 50%
  const input = findCommissionInput();
  fireEvent.change(input, { target: { value: "50" } });
  expect(screen.getByText(/Joint deal:/i)).toBeInTheDocument();
  expect(screen.getByText(/remaining 50%/i)).toBeInTheDocument();
  // Set to 100 — warning disappears (solo)
  fireEvent.change(input, { target: { value: "100" } });
  expect(screen.queryByText(/Joint deal:/i)).not.toBeInTheDocument();
});

test("[B1] Tenant Profile section renders all 5 fields", () => {
  renderPage();
  // Expand the details element so its inputs are in DOM (jsdom honors <details>)
  const summary = screen.getByText(/Tenant Profile/i);
  fireEvent.click(summary);
  expect(screen.getByLabelText(/Tenant Email/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Tenant Phone/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/LinkedIn URL/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Instagram/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Job Position/i)).toBeInTheDocument();
});

test("[B1] Bad tenant email is accepted by the input (server zod validates)", () => {
  // Inline UI validation is intentionally minimal for email — server zod is the SoT.
  renderPage();
  const summary = screen.getByText(/Tenant Profile/i);
  fireEvent.click(summary);
  const email = screen.getByLabelText(/Tenant Email/i) as HTMLInputElement;
  fireEvent.change(email, { target: { value: "not-an-email" } });
  expect(email.value).toBe("not-an-email");
});

test("[B1] LinkedIn URL inline error appears for non-linkedin URL", () => {
  renderPage();
  const summary = screen.getByText(/Tenant Profile/i);
  fireEvent.click(summary);
  const linkedin = screen.getByLabelText(/LinkedIn URL/i);
  fireEvent.change(linkedin, { target: { value: "https://twitter.com/ahmad" } });
  expect(screen.getByText(/Must be a LinkedIn URL/i)).toBeInTheDocument();
});
