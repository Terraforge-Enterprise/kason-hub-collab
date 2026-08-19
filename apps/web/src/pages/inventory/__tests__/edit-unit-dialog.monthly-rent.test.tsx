/**
 * Fix 1 (go-live blocker, final-review): flag-ON coverage for the
 * EditUnitForm/unitFormToApiPayload half of the occupancy monthlyRent fix.
 * See occupancy-fields.monthly-rent.test.tsx for the <OccupancyFields>
 * rendering half, and edit-unit-dialog.test.tsx (unmocked, flag off) for
 * flag-off parity assertions.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn((url: string) => {
    if (typeof url === "string" && url.startsWith("/inventory/amenities")) {
      return Promise.resolve({ data: [] });
    }
    if (typeof url === "string" && url.startsWith("/parties/tenants/search")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ id: "u1" });
  }),
}));

import { apiFetch } from "@/lib/api-client";
import { EditUnitForm, detailToFormState, type FetchedUnitDetail } from "../edit-unit-dialog";
import { unitFormToApiPayload, blankUnitFormState } from "../unit-form-fields";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiFetchMock.mockClear();
});

function makeDetail(overrides: Partial<FetchedUnitDetail> = {}): FetchedUnitDetail {
  return {
    id: "u1",
    unitCode: "A-18-06",
    unitType: "penthouse",
    bedrooms: 3,
    bathrooms: 2,
    floorArea: 1200,
    rentalRate: 4500,
    currency: "MYR",
    occupancyStatus: "occupied",
    listingStatus: "active",
    depositMonths: 2,
    utilitiesDepositMonths: 0.5,
    amenities: [],
    description: "Sunny corner unit.",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    hiddenFromAgentNames: [],
    grantedPartyIds: [],
    grantedAgentNames: [],
    sourceFlag: "COMPANY",
    inChargePartyId: null,
    inChargeName: null,
    sourcingAgentId: null,
    sourcingAgentName: null,
    property: {
      id: "p1",
      name: "The Sky Residences",
      propertyCode: "SKY",
      city: "Kuala Lumpur",
      hasPaxDeduction: false,
      paxDeductionAmount: null,
    },
    activeTenancy: {
      id: "ten1",
      tenantPartyId: "t1",
      tenantName: "NURUL IZZAH",
      tenantIdType: "nric",
      tenantIdNumberMasked: "••••5678",
      tenantPhone: "+60 12-345 6789",
      startDate: "2026-04-25",
      endDate: "2026-05-20",
      // Negotiated rent (RM3,200), deliberately != the unit's asking rentalRate
      // (4500) so the tests prove the dialog shows the TENANCY's rent, not the
      // asking rate (the reported wrong-rent bug).
      monthlyRentAmount: 3200,
    },
    ...overrides,
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("detailToFormState — monthlyRent prefill (flag on)", () => {
  // B2 — the delta: an occupied unit prefills the TENANCY's negotiated rent.
  it("prefills monthlyRent from the active tenancy's negotiated rent, not the asking rate", () => {
    const f = detailToFormState(makeDetail({ rentalRate: 4500 })); // tenancy rent = 3200
    expect(f.monthlyRent).toBe("3200");
  });

  // B3 — boundary: no active tenancy (create/vacant) falls back to rentalRate.
  it("falls back to the unit's rentalRate when there is no active tenancy", () => {
    const f = detailToFormState(makeDetail({ rentalRate: 4500, activeTenancy: null }));
    expect(f.monthlyRent).toBe("4500");
  });

  // B4 — error/tolerance: an older API that omits the tenancy rent falls back
  // to rentalRate rather than rendering "undefined".
  it("falls back to rentalRate when the active tenancy omits monthlyRentAmount (older API)", () => {
    const base = makeDetail({ rentalRate: 4500 });
    const tenancyWithoutRent = { ...base.activeTenancy! };
    delete (tenancyWithoutRent as { monthlyRentAmount?: number }).monthlyRentAmount;
    const f = detailToFormState({ ...base, activeTenancy: tenancyWithoutRent });
    expect(f.monthlyRent).toBe("4500");
  });

  // B5 — edge: a fractional negotiated rent surfaces faithfully.
  it("prefills a fractional negotiated rent", () => {
    const base = makeDetail({ rentalRate: 4500 });
    const f = detailToFormState({
      ...base,
      activeTenancy: { ...base.activeTenancy!, monthlyRentAmount: 1234.5 },
    });
    expect(f.monthlyRent).toBe("1234.5");
  });

  // B12 — a legitimately zero rent (present, not absent) shows "0", never the
  // asking-rate fallback. Guards a truthiness (`||`) regression that would hide a
  // free/comped unit's real rent and re-create the wrong-rent bug.
  it('prefills "0" for a zero-rent tenancy, not the asking rate', () => {
    const base = makeDetail({ rentalRate: 4500 });
    const f = detailToFormState({
      ...base,
      activeTenancy: { ...base.activeTenancy!, monthlyRentAmount: 0 },
    });
    expect(f.monthlyRent).toBe("0");
  });
});

describe("unitFormToApiPayload — monthlyRent on the wire (flag on)", () => {
  it("includes monthlyRent when occupied and the flag is on", () => {
    const state = {
      ...blankUnitFormState(),
      occupancyStatus: "occupied",
      tenantPartyId: "t1",
      moveInDate: "2026-04-25",
      moveOutDate: "2026-05-20",
      monthlyRent: "4500",
    };
    const payload = unitFormToApiPayload(state) as Record<string, unknown>;
    expect(payload.monthlyRent).toBe(4500);
  });
});

describe("EditUnitForm — monthlyRent validation + submit (flag on)", () => {
  it("renders the monthly-rent input prefilled from the active tenancy's rent", () => {
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ rentalRate: 4500 })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveValue(3200);
  });

  it("includes the tenancy's monthlyRent in the PUT body on save", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ rentalRate: 4500 })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/inventory/units/u1",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"monthlyRent":3200'),
      }),
    );
  });

  // B11 — Change tenant must NOT carry the outgoing tenant's negotiated rent into
  // the new tenancy: clearing the tenant resets the rent field to the asking rate.
  it("resets monthlyRent to the asking rate when the tenant is changed", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ rentalRate: 4500 })} // tenancy rent = 3200
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Same tenant on open → shows the tenancy's rent (3200), read-only.
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveValue(3200);
    await user.click(screen.getByRole("button", { name: /change tenant/i }));
    // Tenant cleared → field is editable and reset to the asking rate (4500),
    // NOT left at the previous tenant's 3200.
    const rent = screen.getByLabelText(/tenancy monthly rent/i);
    expect(rent).toHaveValue(4500);
    expect(rent).not.toHaveAttribute("readonly");
  });

  // R1 — re-picking the SAME tenant after "Change tenant" (an undo) restores the
  // tenancy's real rent, read-only again — not the asking rate the clear reset to.
  it("restores the tenancy's rent (read-only) when the same tenant is re-picked after Change tenant", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/parties/tenants/search")) {
        return Promise.resolve({
          data: [
            {
              id: "t1",
              displayName: "NURUL IZZAH",
              idType: "nric",
              idNumberMasked: "••••5678",
              primaryPhone: "60123456789",
              formattedPhone: "+60 12-345 6789",
            },
          ],
        });
      }
      if (String(url).startsWith("/inventory/amenities")) return Promise.resolve({ data: [] });
      return Promise.resolve({ id: "u1" });
    });
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ rentalRate: 4500 })} // tenancy rent 3200, tenant t1
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Same tenant on open → the tenancy's rent (3200), read-only.
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveValue(3200);
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveAttribute("readonly");
    // Change tenant → editable, reset to the asking rate (4500).
    await user.click(screen.getByRole("button", { name: /change tenant/i }));
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveValue(4500);
    // Re-pick the SAME tenant (the undo).
    await user.type(screen.getByPlaceholderText(/search existing tenants/i), "nur");
    await user.click(await screen.findByText("NURUL IZZAH"));
    // Rent restored to the tenancy's real rent (3200), read-only again.
    const rentAfter = screen.getByLabelText(/tenancy monthly rent/i);
    expect(rentAfter).toHaveValue(3200);
    expect(rentAfter).toHaveAttribute("readonly");
  });

  // B10 — a same-tenant edit takes occupancy-sync case-2 (rent never written), so
  // a legacy 0-rent tenancy must NOT soft-lock the save with "rent required".
  it("allows saving a same-tenant edit when the tenancy rent is 0", async () => {
    const user = userEvent.setup();
    const base = makeDetail({ rentalRate: 4500 });
    render(
      wrap(
        <EditUnitForm
          detail={{ ...base, activeTenancy: { ...base.activeTenancy!, monthlyRentAmount: 0 } }}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Zero rent is prefilled as "0" (B12) and shown read-only.
    expect(screen.getByLabelText(/tenancy monthly rent/i)).toHaveValue(0);
    await user.click(screen.getByRole("button", { name: /update unit/i }));
    // Not blocked by the rent-required rule; the PUT fires.
    expect(screen.queryByText(/enter the monthly rent/i)).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/inventory/units/u1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  // The rent-required rule still applies where a NEW tenancy is materialised:
  // after changing the tenant the field is editable, and clearing it blocks the
  // save with the inline rent error. (On the same-tenant path rent is read-only
  // and NOT required — see the 0-rent test above, occupancy-sync case-2.)
  it("blocks submit with a rent error when rent is cleared on the changed-tenant path", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <EditUnitForm
          detail={makeDetail({ rentalRate: 4500 })}
          unitId="u1"
          propertyName="The Sky Residences"
          onClose={() => {}}
        />,
      ),
    );
    // Change tenant → the field becomes editable (and resets to the asking rate).
    await user.click(screen.getByRole("button", { name: /change tenant/i }));
    const rentInput = screen.getByLabelText(/tenancy monthly rent/i);
    await user.clear(rentInput);
    await user.click(screen.getByRole("button", { name: /update unit/i }));

    expect(
      await screen.findByText(/enter the monthly rent before marking this unit occupied/i),
    ).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/inventory\/units\//),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});
