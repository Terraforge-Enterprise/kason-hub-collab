// P4 Task 8: EntryFormDrawer initialContext — inverted unit-first cascade seed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { apiFetch } from "@/lib/api-client";
import { EntryFormDrawer } from "../entry-form-drawer";

const apiFetchMock = vi.mocked(apiFetch);

const OWNER_TREE = {
  properties: [
    {
      id: "prop-1",
      name: "Areca Residences",
      units: [
        {
          apartmentId: "apt-1",
          unitCode: "A-10-04",
          listingMode: "WHOLE",
          rooms: [
            { listingId: "list-1", listingType: "unit", occupancyStatus: "occupied", tenancy: { tenancyId: "ten-1", tenantDisplayName: "Aisyah" } },
          ],
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith("/owner-ledger/owner-tree")) {
      return Promise.resolve({ data: OWNER_TREE }) as ReturnType<typeof apiFetch>;
    }
    return Promise.resolve({ data: {} }) as ReturnType<typeof apiFetch>;
  });
});

function renderDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EntryFormDrawer
        open
        onClose={() => {}}
        mode="create"
        owners={[{ id: "owner-1", displayName: "Dato' Razak" }]}
        initialContext={{ ownerPartyId: "owner-1", propertyId: "prop-1", apartmentId: "apt-1" }}
      />
    </QueryClientProvider>,
  );
}

describe("EntryFormDrawer — initialContext (P4)", () => {
  it("pre-selects owner, property and unit from the apartment context", async () => {
    renderDrawer();
    // Owner select seeded immediately.
    expect(screen.getByLabelText("Owner")).toHaveValue("owner-1");
    // Property + Unit selects resolve once the owner-tree loads.
    await waitFor(() => {
      expect(screen.getByLabelText("Property")).toHaveValue("prop-1");
      expect(screen.getByLabelText("Unit")).toHaveValue("apt-1");
    });
  });

  it("fetched the owner tree for the seeded owner", async () => {
    renderDrawer();
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/owner-ledger/owner-tree?ownerPartyId=owner-1");
    });
  });
});
