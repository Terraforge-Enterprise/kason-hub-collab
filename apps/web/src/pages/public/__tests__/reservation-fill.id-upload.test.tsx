import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// --- Mock the public-reservations API ------------------------------------
const fetchPublicReservation = vi.fn();
const fillPublicReservation = vi.fn();
const signPublicReservation = vi.fn();
const requestReservationUploadUrl = vi.fn();
const uploadReservationFile = vi.fn();
const markReservationDoc = vi.fn();
const deleteReservationDoc = vi.fn();

vi.mock("@/api/public-reservations", () => ({
  fetchPublicReservation: (...args: unknown[]) => fetchPublicReservation(...args),
  fillPublicReservation: (...args: unknown[]) => fillPublicReservation(...args),
  signPublicReservation: (...args: unknown[]) => signPublicReservation(...args),
  requestReservationUploadUrl: (...args: unknown[]) => requestReservationUploadUrl(...args),
  uploadReservationFile: (...args: unknown[]) => uploadReservationFile(...args),
  markReservationDoc: (...args: unknown[]) => markReservationDoc(...args),
  deleteReservationDoc: (...args: unknown[]) => deleteReservationDoc(...args),
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

function makeDto(documents: { kind: string; filename: string }[]) {
  return {
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
    documents,
    customTerms: [],
    brandLogoUrl: null,
  };
}

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
  requestReservationUploadUrl.mockReset();
  uploadReservationFile.mockReset();
  markReservationDoc.mockReset();
  deleteReservationDoc.mockReset();
  navigate.mockReset();
  window.scrollTo = vi.fn();
  fillPublicReservation.mockResolvedValue({ data: { id: "res-1" } });
});

describe("reservation-fill id upload", () => {
  it("continue disabled without id", async () => {
    fetchPublicReservation.mockResolvedValue(makeDto([]));
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    expect(screen.getByRole("button", { name: /Continue to signing/i })).toBeDisabled();
    expect(
      screen.getByText(/Upload both the front and back .* to continue/i),
    ).toBeInTheDocument();
  });

  it("continue disabled with only the front of a document", async () => {
    fetchPublicReservation.mockResolvedValue(
      makeDto([{ kind: "ic_front", filename: "ic-front.jpg" }]),
    );
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    // Front-only must NOT be enough — both sides are required.
    expect(screen.getByRole("button", { name: /Continue to signing/i })).toBeDisabled();
  });

  it("continue enabled once both front and back are present", async () => {
    fetchPublicReservation.mockResolvedValue(
      makeDto([
        { kind: "ic_front", filename: "ic-front.jpg" },
        { kind: "ic_back", filename: "ic-back.jpg" },
      ]),
    );
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    expect(screen.getByRole("button", { name: /Continue to signing/i })).not.toBeDisabled();
  });

  it("requires nationality", async () => {
    fetchPublicReservation.mockResolvedValue(makeDto([{ kind: "ic_front", filename: "ic.jpg" }]));
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    const nationalitySelect = screen.getByLabelText(/Nationality/i) as HTMLSelectElement;
    expect(nationalitySelect).toBeRequired();
    // Nationality defaults to "Malaysian" and is a <select>, so it can't be
    // "left empty" via the UI — assert the required attribute enforces
    // browser-native validation would block an empty value.
    expect(nationalitySelect.value).toBe("Malaysian");
  });

  it("humanizes id-required", async () => {
    fetchPublicReservation.mockResolvedValue(
      makeDto([
        { kind: "ic_front", filename: "ic-front.jpg" },
        { kind: "ic_back", filename: "ic-back.jpg" },
      ]),
    );
    signPublicReservation.mockRejectedValue(new Error("ID_DOCUMENT_REQUIRED"));
    renderPage();
    await waitFor(() => screen.getByText(/Section B/i));

    fireEvent.change(screen.getByLabelText(/Full name/i), { target: { value: "JOHN TAN" } });
    fireEvent.change(screen.getByLabelText(/NRIC \/ Passport number/i), {
      target: { value: "891231-14-5678" },
    });
    fireEvent.change(screen.getByLabelText(/Contact number/i), {
      target: { value: "+60123456789" },
    });
    fireEvent.change(screen.getByLabelText(/Email/i), {
      target: { value: "john@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Home address line 1/i), {
      target: { value: "12, Jalan Bukit Bintang" },
    });
    fireEvent.change(screen.getByLabelText(/City/i), { target: { value: "Kuala Lumpur" } });
    fireEvent.change(screen.getByLabelText(/Postcode/i), { target: { value: "55100" } });
    fireEvent.change(screen.getByLabelText(/State/i), { target: { value: "Selangor" } });
    fireEvent.change(screen.getByLabelText(/Emergency contact name/i), {
      target: { value: "Jane Tan" },
    });
    fireEvent.change(screen.getByLabelText(/Emergency contact phone/i), {
      target: { value: "+60123456780" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Continue to signing/i }));
    await waitFor(() => screen.getByText(/Review your details/i));

    // Open T&Cs, simulate scroll-to-bottom (jsdom reports 0 for scroll
    // measurements by default; stub them the same way tnc-modal.test.tsx
    // does), then close to enable the agreement checkbox.
    fireEvent.click(screen.getByRole("button", { name: /Terms & Conditions/i }));
    const ol = await screen.findByRole("list");
    const scrollable = ol.parentElement!;
    Object.defineProperty(scrollable, "scrollTop", { value: 1000, configurable: true });
    Object.defineProperty(scrollable, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(scrollable, "scrollHeight", { value: 1000, configurable: true });
    fireEvent.scroll(scrollable);
    const closeButtons = screen.getAllByRole("button", { name: /^close$/i });
    fireEvent.click(closeButtons.at(-1)!);

    fireEvent.click(screen.getByRole("checkbox"));

    // Draw a signature (SignatureCanvas.isEmpty() tracks a `touched` flag set
    // by onPointerDown).
    const canvas = document.querySelector("canvas")!;
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });

    fireEvent.change(screen.getByLabelText(/Type your full name to confirm/i), {
      target: { value: "JOHN TAN" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Sign & submit/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/Please upload at least one identity document/i),
      ).toBeInTheDocument(),
    );
  });
});
