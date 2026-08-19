import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/lib/feature-flags", () => ({ isPhase2FlagEnabled: () => true }));
vi.mock("@/components/void-charge-dialog", () => ({
  VoidChargeDialog: ({ charge }: { charge: { chargeNumber: string } | null }) =>
    charge ? <div data-testid="void-dialog">{charge.chargeNumber}</div> : null,
}));

import { ChargeRowMenu } from "../charge-row-menu";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);

const draftRow = {
  id: "c1", chargeNumber: "CHG-20260704-XXXX", status: "draft", displayStatus: "draft",
  amount: 100, currency: "MYR", documentId: null, documentNumber: null,
};

beforeEach(() => apiFetchMock.mockReset().mockResolvedValue({ id: "c1" }));

describe("ChargeRowMenu", () => {
  it("draft row: Post opens an AlertDialog naming charge + amount; confirm POSTs", async () => {
    wrap(<ChargeRowMenu charge={draftRow} />);
    await userEvent.click(screen.getByRole("button", { name: /charge actions/i }));
    // Base UI's Menu popup mounts asynchronously (floating-ui positioning) —
    // findByRole polls for it rather than assuming it's present the instant
    // the trigger click() promise resolves.
    await userEvent.click(await screen.findByRole("menuitem", { name: /post/i }));
    expect(screen.getByText(/CHG-20260704-XXXX/)).toBeTruthy();
    expect(screen.getByText(/100/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^post charge$/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/billing/charges/c1/post", expect.objectContaining({ method: "POST" })),
    );
  });

  it("posted row: offers Void & credit note, opens VoidChargeDialog", async () => {
    wrap(<ChargeRowMenu charge={{ ...draftRow, status: "posted", displayStatus: "posted" }} />);
    await userEvent.click(screen.getByRole("button", { name: /charge actions/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /void/i }));
    expect(screen.getByTestId("void-dialog")).toBeTruthy();
  });

  it("row without document: no Open PDF item (failure path)", async () => {
    wrap(<ChargeRowMenu charge={draftRow} />);
    await userEvent.click(screen.getByRole("button", { name: /charge actions/i }));
    // Confirm the menu is actually open (via an item known to exist) before
    // asserting on the absence of "Open PDF" — otherwise a not-yet-open menu
    // would make this assertion pass for the wrong reason.
    await screen.findByRole("menuitem", { name: /post/i });
    expect(screen.queryByRole("menuitem", { name: /open pdf/i })).toBeNull();
  });
});
