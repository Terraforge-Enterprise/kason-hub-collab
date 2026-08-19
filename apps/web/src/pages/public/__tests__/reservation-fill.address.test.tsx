import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// --- Mock the public-reservations API ------------------------------------
// fetchPublicReservation resolves a DTO whose applicant fields are all null
// (fresh, never-filled link); fillPublicReservation resolves ok so the page
// advances to the signing step.
const fetchPublicReservation = vi.fn();
const fillPublicReservation = vi.fn();
const signPublicReservation = vi.fn();

vi.mock("@/api/public-reservations", () => ({
  fetchPublicReservation: (...args: unknown[]) => fetchPublicReservation(...args),
  fillPublicReservation: (...args: unknown[]) => fillPublicReservation(...args),
  signPublicReservation: (...args: unknown[]) => signPublicReservation(...args),
}));

// react-router: pin the token param + stub navigate.
const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ token: "AAAAAAAAAAAAAAAAAAAAAA" }),
  };
});

import ReservationFillPage from "../reservation-fill";

const DTO = {
  referenceCode: "RES-2026-0007",
  expiresAt: "2026-08-01T00:00:00.000Z",
  property: { name: "The Sky Residences" },
  unit: { unitCode: "A-101" },
  carPark: null,
  proposedMoveIn: "2026-09-01T00:00:00.000Z",
  proposedMoveOut: null,
  specialRemarks: null,
  charges: {
    reservationDeposit: "500.00",
    documentationFee: "100.00",
    rentalDeposit: "2400.00",
    utilityDeposit: "300.00",
    accessCardDeposit: "50.00",
  },
  applicant: {
    fullName: null,
    nric: null,
    contact: null,
    email: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    postcode: null,
    state: null,
    country: null,
    nationality: null,
    occupation: null,
    monthlyIncome: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    emergencyContactRelation: null,
  },
  // "Continue to signing" is gated on a COMPLETE ID document — both the front
  // and back of either the IC or Passport. This fixture pre-seeds a full IC
  // pair so the address-flow assertions below (unrelated to uploads) continue
  // to exercise the button-click -> advance-to-sign path unchanged.
  documents: [
    { kind: "ic_front", filename: "ic-front.jpg" },
    { kind: "ic_back", filename: "ic-back.jpg" },
  ],
  customTerms: [],
  brandLogoUrl: null,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/reserve/AAAAAAAAAAAAAAAAAAAAAA"]}>
      <ReservationFillPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchPublicReservation.mockReset();
  fillPublicReservation.mockReset();
  signPublicReservation.mockReset();
  navigate.mockReset();
  window.scrollTo = vi.fn();
  fetchPublicReservation.mockResolvedValue(DTO);
  fillPublicReservation.mockResolvedValue({ data: { id: "res-1" } });
});

describe("reservation-fill address", () => {
  it("renders the MY state select and defaults country to Malaysia", async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    // A State control (the MY-state <select>) is present.
    expect(screen.getByLabelText(/State/i)).toBeInTheDocument();
    // Country defaults to "Malaysia".
    expect((screen.getByLabelText(/Country/i) as HTMLInputElement).value).toBe("Malaysia");
    // The select carries the Malaysian options.
    expect(screen.getByRole("option", { name: "Selangor" })).toBeInTheDocument();
    // On a fresh form the select is NOT forced to "Other" — the disabled
    // placeholder is what's selected (unselected state renders cleanly).
    expect((screen.getByLabelText(/State/i) as HTMLSelectElement).value).toBe("");
  });

  it("shows the entered address read-only in the sign-step review block", async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    fireEvent.change(screen.getByLabelText(/Full name/i), {
      target: { value: "JOHN TAN" },
    });
    fireEvent.change(screen.getByLabelText(/Home address line 1/i), {
      target: { value: "12, Jalan Bukit Bintang" },
    });
    fireEvent.change(screen.getByLabelText(/City/i), {
      target: { value: "Kuala Lumpur" },
    });
    fireEvent.change(screen.getByLabelText(/Postcode/i), {
      target: { value: "55100" },
    });
    fireEvent.change(screen.getByLabelText(/State/i), {
      target: { value: "Selangor" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Continue to signing/i }));

    await waitFor(() => screen.getByText(/Review your details/i));
    // The frozen-at-signature address is shown read-only for review (spec R3).
    expect(screen.getByText(/12, Jalan Bukit Bintang/)).toBeInTheDocument();
    expect(screen.getByText(/Selangor/)).toBeInTheDocument();
    // With the "cannot be changed after signing" notice.
    expect(screen.getByText(/cannot be changed after signing/i)).toBeInTheDocument();
  });

  it("lets a foreign address use the free-text fallback and does not block it", async () => {
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    fireEvent.change(screen.getByLabelText(/Home address line 1/i), {
      target: { value: "742 Evergreen Terrace" },
    });
    fireEvent.change(screen.getByLabelText(/City/i), {
      target: { value: "Springfield" },
    });
    fireEvent.change(screen.getByLabelText(/Postcode/i), {
      target: { value: "62704" },
    });
    // Pick "Other / outside Malaysia" -> free-text input appears.
    fireEvent.change(screen.getByLabelText(/State/i), {
      target: { value: "__other__" },
    });
    const freeText = await screen.findByPlaceholderText(/Enter state \/ province/i);
    // The free-text fallback carries a programmatic accessible name for
    // screen readers, not just a placeholder (a11y fix).
    expect(screen.getByLabelText("State / province")).toBeInTheDocument();
    fireEvent.change(freeText, { target: { value: "Illinois" } });
    fireEvent.change(screen.getByLabelText(/Country/i), {
      target: { value: "United States" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Continue to signing/i }));

    // The foreign state/province is accepted and shown in the review block.
    await waitFor(() => screen.getByText(/Review your details/i));
    expect(screen.getByText(/Illinois/)).toBeInTheDocument();
    expect(screen.getByText(/United States/)).toBeInTheDocument();
  });
});
