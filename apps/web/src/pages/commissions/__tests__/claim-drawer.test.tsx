import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClaimDrawer, type ClaimForDrawer } from "../claim-drawer";

const claim: ClaimForDrawer = {
  id: "claim-uuid-1",
  claimNumber: "CLM-2026-0009",
  status: "submitted",
  agentName: "Noelle",
  totalNettPayout: 542,
  claimDate: "2026-05-22T00:00:00.000Z",
};

function renderDrawer(extra: { hideDetailLink?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClaimDrawer
          claim={claim}
          mode="pay-due"
          onClose={() => {}}
          {...extra}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ClaimDrawer view-full-details link", () => {
  it("renders the link by default (list-page use case)", () => {
    renderDrawer();
    expect(screen.getByRole("link", { name: /view full details/i })).toBeInTheDocument();
  });

  it("hides the link when hideDetailLink=true (detail-page use case — avoid same-URL no-op)", () => {
    renderDrawer({ hideDetailLink: true });
    expect(screen.queryByRole("link", { name: /view full details/i })).not.toBeInTheDocument();
  });
});
