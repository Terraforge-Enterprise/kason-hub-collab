/**
 * CreateTenantDialog "from reservation" picker (T11/R2/R4), flag ON.
 *
 * Selecting a pickable reservation sets `selectedReservationId`, which fetches the
 * FULL record via `getReservation` (`/admin/reservations/:id`) and prefills
 * displayName/email/phone AND the UNMASKED IC the applicant already gave
 * (reservation-prefill rework, cf879c85). All fields stay editable; submit sends
 * `reservationId` in the POST body. The picker list itself carries only a masked
 * NRIC, so the detail fetch is what supplies the real IC — that is why the test
 * must mock BOTH `/admin/reservations/pickable` and `/admin/reservations/:id`.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => flag === "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
import type { ReservationDto } from "@/api/reservations";
import { CreateTenantDialog } from "../tenants-action-dialogs";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

// The picker list carries only fullName/nricMasked/contact/email.
const PICKABLE = {
  id: "res-1",
  referenceCode: "RES-00042",
  applicant: {
    fullName: "Ahmad Bin Ismail",
    nricMasked: "900101-**-1234",
    contact: "60123456789",
    email: "ahmad@example.com",
  },
  proposedMoveIn: "2026-09-01T00:00:00.000Z",
  proposedMoveOut: null,
  agreedMonthlyRent: "1800.00",
  unit: { label: "A-2-3" },
};

// The full record returned by getReservation — the ONLY source of the unmasked IC.
const DETAIL: ReservationDto = {
  id: "res-1",
  referenceCode: "RES-00042",
  status: "signed",
  issuedAt: "2026-07-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:00:00.000Z",
  property: { id: "p1", name: "Prop One" },
  unit: { id: "u1", unitCode: "A-2-3" },
  carPark: null,
  proposedMoveIn: "2026-09-01T00:00:00.000Z",
  proposedMoveOut: null,
  specialRemarks: null,
  charges: {
    reservationDeposit: "500",
    documentationFee: "0",
    rentalDeposit: "3600",
    utilityDeposit: "0",
    accessCardDeposit: "0",
  },
  agreedMonthlyRent: "1800.00",
  applicant: {
    fullName: "Ahmad Bin Ismail",
    nric: "900101-10-9999",
    contact: "60123456789",
    email: "ahmad@example.com",
    addressLine1: null,
    addressLine2: null,
    city: null,
    postcode: null,
    state: null,
    country: null,
    nationality: "MY",
    occupation: "Engineer",
    monthlyIncome: "5000",
    emergencyContactName: "Siti Binti Ali",
    emergencyContactPhone: "0191112222",
    emergencyContactRelation: "Spouse",
  },
  documents: [],
  signedAt: "2026-07-02T00:00:00.000Z",
  signedPdfDownloadUrl: null,
  customTerms: [],
  approvalNote: null,
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateTenantDialog trigger={<button>New Tenant</button>} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path === "/admin/reservations/pickable") {
      return Promise.resolve({ data: [PICKABLE] });
    }
    if (path === `/admin/reservations/${PICKABLE.id}`) {
      return Promise.resolve({ data: DETAIL });
    }
    return Promise.resolve({ data: { id: "party-1" } });
  });
});

test("selecting a pickable reservation prefills displayName/email/phone AND the unmasked IC (all editable)", async () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "New Tenant" }));

  const picker = await screen.findByLabelText("From reservation");
  await userEvent.selectOptions(picker, PICKABLE.id);

  // Selecting fires getReservation(id); the full record resolves and the prefillable
  // fields re-mount with its data (they are gated behind !detailPending).
  const displayName = (await screen.findByDisplayValue("Ahmad Bin Ismail")) as HTMLInputElement;
  expect(displayName.readOnly).toBe(false); // still editable

  const email = screen.getByPlaceholderText("daniel@example.com") as HTMLInputElement;
  expect(email.value).toBe("ahmad@example.com");

  const hiddenPhone = document.querySelector('input[name="primaryPhone"]') as HTMLInputElement;
  expect(hiddenPhone.value).toBe("60123456789");

  // Reservation-prefill rework: the UNMASKED IC (only on the full record, never on the
  // picker) IS now prefilled into the real IC field.
  const idNumber = screen.getByPlaceholderText("900101-10-1234") as HTMLInputElement;
  expect(idNumber.value).toBe("900101-10-9999");
});

test("submitting with a reservation selected sends reservationId in the POST body", async () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "New Tenant" }));

  const picker = await screen.findByLabelText("From reservation");
  await userEvent.selectOptions(picker, PICKABLE.id);

  // Wait for the full record to resolve + prefill before submitting.
  await screen.findByDisplayValue("Ahmad Bin Ismail");

  fireEvent.click(screen.getByRole("button", { name: /Create tenant/i }));

  await waitFor(() => {
    const call = apiFetchMock.mock.calls.find(([p]) => p === "/parties/tenants");
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.reservationId).toBe(PICKABLE.id);
    expect(body.displayName).toBe("Ahmad Bin Ismail");
  });
});

test("without selecting a reservation, submission omits reservationId", async () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "New Tenant" }));

  await screen.findByLabelText("From reservation");
  fireEvent.change(screen.getByPlaceholderText("Daniel Tan"), { target: { value: "Manual Tenant" } });

  fireEvent.click(screen.getByRole("button", { name: /Create tenant/i }));

  await waitFor(() => {
    const call = apiFetchMock.mock.calls.find(([p]) => p === "/parties/tenants");
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.reservationId).toBeUndefined();
  });
});
