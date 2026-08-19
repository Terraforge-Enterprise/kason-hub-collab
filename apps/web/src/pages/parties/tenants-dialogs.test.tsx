import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { EditTenantDialog, CreateTenantDialog } from "./tenants-action-dialogs";
import { TenantTable } from "./tenants-table";
import type { TenantListItem } from "./tenants-table";
import { useTenantDetail } from "@/api/parties-detail";
import { apiFetch, ApiError } from "@/lib/api-client";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { listPickableReservations, getReservation } from "@/api/reservations";
import type { ReservationDto, PickableReservationDto } from "@/api/reservations";

// Mock apiFetch so mutations don't throw during menu-only interaction tests.
// ApiError is kept real (importOriginal) so onError handlers that do
// `err instanceof ApiError` / read `err.data.fieldErrors` work under test —
// a plain object literal here would silently fail `instanceof` checks.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn().mockResolvedValue({}) };
});

// Mock useTenantDetail so the EditTenantDialog's detail fetch is controlled in tests.
// Default: returns no data (loading finished, nothing returned) — existing tests are unaffected.
vi.mock("@/api/parties-detail", () => ({
  useTenantDetail: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

// Mock the reservation-gating flag. Default OFF (matches the unset test env), so
// every existing test is unaffected — the "from reservation" picker never renders.
// The prefill test flips it ON within its own scope.
vi.mock("@/lib/feature-flags", () => ({
  isPhase2FlagEnabled: vi.fn(() => false),
  isInvoiceAdjustmentsEnabled: vi.fn(() => false),
}));

// Mock the reservation API. importOriginal preserves the real types/other exports;
// only the two functions CreateTenantDialog calls are stubbed. Never called while
// the flag is OFF (the query is disabled), so existing tests stay unaffected.
vi.mock("@/api/reservations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/reservations")>();
  return { ...actual, listPickableReservations: vi.fn(), getReservation: vi.fn() };
});

// base-ui DropdownMenu uses a floating-ui positioner that has no layout in jsdom,
// so the popup never opens. Mock with inline-rendering counterparts so we can
// test the conditional menu-item logic directly.
vi.mock("@/components/ui/dropdown-menu", async () => {
  // Dynamic import (not a top-level one) because vi.mock factories are hoisted
  // above the import block — a top-level React binding is not initialised yet.
  const React = await import("react");
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "dropdown-menu" }, children),
    DropdownMenuTrigger: ({ children, "aria-label": ariaLabel, className }: {
      children: React.ReactNode;
      "aria-label"?: string;
      className?: string;
    }) =>
      React.createElement("button", { "aria-label": ariaLabel, className }, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { role: "menu" }, children),
    DropdownMenuItem: ({ children, onClick, variant }: {
      children: React.ReactNode;
      onClick?: () => void;
      variant?: string;
    }) =>
      React.createElement("button", { role: "menuitem", onClick, "data-variant": variant }, children),
  };
});

const tenant: TenantListItem = {
  id: "1", displayName: "Tan Wei Ming", legalName: null, primaryEmail: null,
  primaryPhone: "60123456789", formattedPhone: "+60 12-345 6789", occupation: "Software engineer",
  status: "active", isBlacklisted: false, createdAt: "",
  nationality: "MY", employerName: "Acme Studio", monthlyIncome: "5000",
  idType: null, idNumber: null, blacklistReason: null, deletable: true,
};

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe("EditTenantDialog prefill", () => {
  test("shows stored nationality, occupation, employer, income", () => {
    wrap(<EditTenantDialog tenant={tenant} open onOpenChange={() => {}} />);
    expect((screen.getByDisplayValue("Acme Studio") as HTMLInputElement)).toBeInTheDocument();
    expect((screen.getByDisplayValue("Software engineer") as HTMLInputElement)).toBeInTheDocument();
    expect((screen.getByDisplayValue("5000") as HTMLInputElement)).toBeInTheDocument();
    const nat = screen.getByLabelText("Nationality") as HTMLSelectElement;
    expect(nat.value).toBe("MY");
  });
});

// ── TenantRow actions menu per state ─────────────────────────────────────

const blacklistedTenant: TenantListItem = {
  id: "bl-1", displayName: "Blacklisted User", legalName: null, primaryEmail: null,
  primaryPhone: null, formattedPhone: null, occupation: null,
  status: "inactive", isBlacklisted: true, createdAt: "",
  nationality: null, employerName: null, monthlyIncome: null,
  idType: null, idNumber: null, blacklistReason: "Fraud", deletable: false,
};

const activeDeletableTenant: TenantListItem = {
  id: "ad-1", displayName: "Active Deletable", legalName: null, primaryEmail: null,
  primaryPhone: null, formattedPhone: null, occupation: null,
  status: "active", isBlacklisted: false, createdAt: "",
  nationality: null, employerName: null, monthlyIncome: null,
  idType: null, idNumber: null, blacklistReason: null, deletable: true,
};

// The mock renders DropdownMenuContent inline (no portal/open state needed).
// We scope per-row via the Actions cell to avoid cross-row false positives.
function wrapTable(tenants: TenantListItem[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TenantTable tenants={tenants} />
    </QueryClientProvider>
  );
}

function getMenuForTenant(displayName: string) {
  // The Actions trigger button is the last button in the row. Locate it via
  // aria-label, then walk up to the <td> to scope menu queries inside the row.
  const trigger = screen.getByRole("button", { name: `Actions for ${displayName}` });
  // The menu (role="menu") is a sibling container in the same <td>
  return trigger.closest("td") ?? trigger.parentElement!;
}

describe("TenantRow actions menu — blacklisted row", () => {
  test("shows 'Resolve blacklist' and hides Blacklist + Deactivate", () => {
    wrapTable([blacklistedTenant]);
    const cell = getMenuForTenant("Blacklisted User");
    expect(within(cell).getByText("Resolve blacklist")).toBeInTheDocument();
    expect(within(cell).queryByText("Blacklist")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Deactivate")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Delete")).not.toBeInTheDocument();
  });
});

describe("TenantRow actions menu — active deletable row", () => {
  test("shows Deactivate, Blacklist, and Delete", () => {
    wrapTable([activeDeletableTenant]);
    const cell = getMenuForTenant("Active Deletable");
    expect(within(cell).getByText("Deactivate")).toBeInTheDocument();
    expect(within(cell).getByText("Blacklist")).toBeInTheDocument();
    expect(within(cell).getByText("Delete")).toBeInTheDocument();
    expect(within(cell).queryByText("Resolve blacklist")).not.toBeInTheDocument();
  });
});

const inactiveTenant: TenantListItem = {
  id: "in-1", displayName: "Inactive User", legalName: null, primaryEmail: null,
  primaryPhone: null, formattedPhone: null, occupation: null,
  status: "inactive", isBlacklisted: false, createdAt: "",
  nationality: null, employerName: null, monthlyIncome: null,
  idType: null, idNumber: null, blacklistReason: null, deletable: false,
};

describe("TenantRow actions menu — inactive non-blacklisted row", () => {
  test("shows Activate and Edit; hides Deactivate, Resolve blacklist, Delete", () => {
    wrapTable([inactiveTenant]);
    const cell = getMenuForTenant("Inactive User");
    // The Activate branch (status !== "active") must be rendered
    expect(within(cell).getByText("Activate")).toBeInTheDocument();
    // Edit is always shown
    expect(within(cell).getByText("Edit")).toBeInTheDocument();
    // Deactivate must NOT appear (it only appears when status === "active")
    expect(within(cell).queryByText("Deactivate")).not.toBeInTheDocument();
    // Resolve blacklist must NOT appear (only shown when isBlacklisted)
    expect(within(cell).queryByText("Resolve blacklist")).not.toBeInTheDocument();
    // Delete must NOT appear (deletable: false)
    expect(within(cell).queryByText("Delete")).not.toBeInTheDocument();
  });
});

describe("Phone validity — blocks invalid submit", () => {
  test("shows inline error and stays open when phone is invalid", async () => {
    const user = userEvent.setup();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);

    // Open the dialog
    await user.click(screen.getByRole("button", { name: "Open" }));

    // Fill in the required display name to pass HTML validation
    await user.type(screen.getByPlaceholderText("Daniel Tan"), "Test User");

    // Type an invalid phone number into the phone input (just digits, no valid MY format)
    const phoneInput = screen.getByPlaceholderText("12-345 6789");
    await user.type(phoneInput, "123"); // too short to be valid
    await user.tab(); // blur triggers onValidityChange("invalid")

    // Click submit
    await user.click(screen.getByRole("button", { name: "Create tenant" }));

    // Error should appear and dialog stays open
    expect(screen.getByText("Enter a valid Malaysian mobile number")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create tenant" })).toBeInTheDocument();
  });
});

describe("Phone validity — resets on dialog close (regression)", () => {
  test("phone error is cleared after closing and reopening the Create dialog", async () => {
    const user = userEvent.setup();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);

    // Open dialog
    await user.click(screen.getByRole("button", { name: "Open" }));

    // Type an invalid phone to set phoneError + phoneValidityRef = "invalid"
    const phoneInput = screen.getByPlaceholderText("12-345 6789");
    await user.type(phoneInput, "123");
    await user.tab(); // onValidityChange("invalid") fires

    // Confirm the error is visible
    expect(screen.getByText("Enter a valid Malaysian mobile number")).toBeInTheDocument();

    // Close via Cancel
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Reopen via the trigger
    await user.click(screen.getByRole("button", { name: "Open" }));

    // After fix: phoneError + phoneValidityRef must be reset — no error on reopen
    expect(screen.queryByText("Enter a valid Malaysian mobile number")).toBeNull();
  });
});

describe("EditTenantDialog — full-parity fields (IC, gender, DOB, WhatsApp, emergency contact)", () => {
  test("renders gender/DOB/WhatsApp/emergency prefilled from detail; IC blank stays unsent on submit", async () => {
    // Arrange: mock useTenantDetail to return full tenant detail with the new fields
    vi.mocked(useTenantDetail).mockReturnValue({
      data: {
        id: "1",
        displayName: "Tan Wei Ming",
        legalName: null,
        primaryEmail: null,
        primaryPhone: "60123456789",
        formattedPhone: "+60 12-345 6789",
        whatsappPhone: "+60129876543",
        idType: "NRIC",
        idNumberMasked: "••••5678",
        nationality: "MY",
        gender: "male",
        dateOfBirth: "1990-03-20T00:00:00.000Z",
        occupation: "Software engineer",
        employerName: "Acme Studio",
        employerAddress: null,
        monthlyIncome: "5000",
        emergencyContactName: "Tan Ah Kow",
        emergencyContactPhone: "+60112223333",
        emergencyContactRelation: "Father",
        isBlacklisted: false,
        blacklistReason: null,
        status: "active",
        createdAt: "",
        hasActiveTenancy: true,
        portalUser: null,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useTenantDetail>);

    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    wrap(<EditTenantDialog tenant={tenant} open onOpenChange={() => {}} />);

    // Assert: gender select prefills with "male"
    const genderSelect = screen.getByLabelText("Gender") as HTMLSelectElement;
    expect(genderSelect.value).toBe("male");

    // Assert: DOB input prefills with "1990-03-20" (ISO date truncated from full timestamp)
    const dobInput = screen.getByLabelText("Date of birth") as HTMLInputElement;
    expect(dobInput.value).toBe("1990-03-20");

    // Assert: WhatsApp input prefills with detail value
    const whatsappInput = screen.getByDisplayValue("+60129876543") as HTMLInputElement;
    expect(whatsappInput).toBeInTheDocument();

    // Assert: emergency contact fields prefill from detail
    expect(screen.getByDisplayValue("Tan Ah Kow")).toBeInTheDocument();
    expect(screen.getByDisplayValue("+60112223333")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Father")).toBeInTheDocument();

    // Assert: IC number input is empty (blank-to-keep behaviour)
    const icInput = screen.getByPlaceholderText(/Enter new IC to replace/i) as HTMLInputElement;
    expect(icInput.value).toBe("");

    // Act: submit the form without entering an IC
    await user.click(screen.getByRole("button", { name: "Update tenant" }));

    // Assert: apiFetch was called for the PUT
    expect(mockApiFetch).toHaveBeenCalled();
    const [, opts] = mockApiFetch.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, string>;

    // New fields present in body
    expect(body.gender).toBe("male");
    expect(body.idType).toBe("NRIC");
    expect(body.dateOfBirth).toBe("1990-03-20");
    expect(body.whatsappPhone).toBe("+60129876543");
    expect(body.emergencyContactName).toBe("Tan Ah Kow");
    expect(body.emergencyContactPhone).toBe("+60112223333");
    expect(body.emergencyContactRelation).toBe("Father");

    // IC left blank → getFormData drops it → not in PUT body
    expect(body).not.toHaveProperty("idNumber");
  });

  test("clearing a prefilled field sends it as '' (blank = blank), but a blank IC is never sent", async () => {
    vi.mocked(useTenantDetail).mockReturnValue({
      data: {
        id: "1",
        displayName: "Tan Wei Ming",
        legalName: null,
        primaryEmail: null,
        primaryPhone: "60123456789",
        formattedPhone: "+60 12-345 6789",
        whatsappPhone: null,
        idType: "NRIC",
        idNumberMasked: "••••5678",
        nationality: "MY",
        gender: null,
        dateOfBirth: null,
        occupation: "Software engineer",
        employerName: null,
        employerAddress: null,
        monthlyIncome: "5000",
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelation: null,
        isBlacklisted: false,
        blacklistReason: null,
        status: "active",
        createdAt: "",
        hasActiveTenancy: true,
        portalUser: null,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useTenantDetail>);

    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    wrap(<EditTenantDialog tenant={tenant} open onOpenChange={() => {}} />);

    // Clear the prefilled Occupation + Monthly income to blank.
    await user.clear(screen.getByDisplayValue("Software engineer"));
    await user.clear(screen.getByDisplayValue("5000"));
    await user.click(screen.getByRole("button", { name: "Update tenant" }));

    const [, opts] = mockApiFetch.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, string>;
    // blank = blank: cleared fields are SENT as "" so the backend nulls them.
    expect(body.occupation).toBe("");
    expect(body.monthlyIncome).toBe("");
    // ...but a blank IC is still never sent — identity data is never wiped on blank.
    expect(body).not.toHaveProperty("idNumber");
  });
});

describe("CreateTenantDialog — full parity fields (gender, DOB, WhatsApp, employer address, emergency contact)", () => {
  test("create tenant full parity: renders and submits new fields in POST body", async () => {
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    const rendered = wrap(<CreateTenantDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    fireEvent.change(screen.getByPlaceholderText("Daniel Tan"), { target: { value: "New Tenant" } });

    // Fill all 7 new fields.
    // NOTE: these are uncontrolled inputs (name=-based, read via getFormData(new
    // FormData(form)) at submit) so fireEvent.change (one-shot) is equivalent to
    // user.type (character-by-character) here but far faster — same pattern as
    // the Date-of-birth line above. Keeps this test fast under full-suite CPU
    // contention, where userEvent's per-keystroke pipeline across ~7 fields was
    // pushing this test past the default 5s testTimeout intermittently.
    await user.selectOptions(screen.getByLabelText("Gender"), "female");
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1995-06-15" } });
    fireEvent.change(screen.getByLabelText("WhatsApp"), { target: { value: "+60129998888" } });
    fireEvent.change(screen.getByLabelText("Employer address"), { target: { value: "1 Jalan Test" } });
    fireEvent.change(screen.getByLabelText("Emergency contact name"), { target: { value: "Lim Ah Kow" } });
    fireEvent.change(screen.getByLabelText("Emergency contact phone"), { target: { value: "+60111234567" } });
    fireEvent.change(screen.getByLabelText("Emergency contact relation"), { target: { value: "Mother" } });

    await user.click(screen.getByRole("button", { name: "Create tenant" }));

    expect(mockApiFetch).toHaveBeenCalled();
    const [, filledOpts] = mockApiFetch.mock.calls[0];
    const filledBody = JSON.parse((filledOpts as RequestInit).body as string) as Record<string, string>;

    expect(filledBody.gender).toBe("female");
    expect(filledBody.dateOfBirth).toBe("1995-06-15");
    expect(filledBody.whatsappPhone).toBe("+60129998888");
    expect(filledBody.employerAddress).toBe("1 Jalan Test");
    expect(filledBody.emergencyContactName).toBe("Lim Ah Kow");
    expect(filledBody.emergencyContactPhone).toBe("+60111234567");
    expect(filledBody.emergencyContactRelation).toBe("Mother");

    // Edge: leaving the same optional fields blank on a fresh dialog omits them
    // from the POST body (shared getFormData drop-empty behaviour). Unmount the
    // first dialog explicitly so its "Daniel Tan"-placeholder input can't collide
    // with the second instance regardless of the first mutation's async close timing.
    rendered.unmount();
    mockApiFetch.mockClear();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.change(screen.getByPlaceholderText("Daniel Tan"), { target: { value: "Blank Tenant" } });
    await user.click(screen.getByRole("button", { name: "Create tenant" }));

    expect(mockApiFetch).toHaveBeenCalled();
    const [, blankOpts] = mockApiFetch.mock.calls[0];
    const blankBody = JSON.parse((blankOpts as RequestInit).body as string) as Record<string, string>;

    expect(blankBody).not.toHaveProperty("gender");
    expect(blankBody).not.toHaveProperty("dateOfBirth");
    expect(blankBody).not.toHaveProperty("whatsappPhone");
    expect(blankBody).not.toHaveProperty("employerAddress");
    expect(blankBody).not.toHaveProperty("emergencyContactName");
    expect(blankBody).not.toHaveProperty("emergencyContactPhone");
    expect(blankBody).not.toHaveProperty("emergencyContactRelation");
  });
});

// ── Server-side field errors (#3.2) ─────────────────────────────────────────
//
// Backend validation failures return { error, fieldErrors } via formatZodError
// (apps/api/src/lib/zod-error-mapper.ts), carried on ApiError.data. Before this
// fix, onError only toast.error(err.message) and never read err.data.fieldErrors,
// so "Check the highlighted N fields" highlighted nothing.

describe("CreateTenantDialog — server-side field errors", () => {
  test("renders field-level error inline when the API rejects with fieldErrors", async () => {
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError("Check the highlighted 1 fields and try again.", 400, undefined, {
        error: "Check the highlighted 1 fields and try again.",
        fieldErrors: { primaryEmail: "Email is required." },
      }),
    );

    const user = userEvent.setup();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    fireEvent.change(screen.getByPlaceholderText("Daniel Tan"), { target: { value: "Test User" } });
    await user.click(screen.getByRole("button", { name: "Create tenant" }));

    // Inline field error (not just the toast) is what this task adds.
    expect(await screen.findByText("Email is required.")).toBeInTheDocument();
  });

  // Regression (duplicate-on-create): a 409 conflict now carries the same
  // { error, fieldErrors } contract as a 400, so the offending input reddens
  // instead of only surfacing a toast that doesn't say which field is the dup.
  // Characterizes the client half; the 409 fieldErrors emission is TDD'd on the
  // API side (parties.routes / parties.uniqueness / parties.dup-field tests).
  test("reddens the field inline when a DUPLICATE (409) carries fieldErrors", async () => {
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError("This email is already used by Daniel Tan.", 409, undefined, {
        error: "This email is already used by Daniel Tan.",
        fieldErrors: { primaryEmail: "Already used by Daniel Tan" },
      }),
    );

    const user = userEvent.setup();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    fireEvent.change(screen.getByPlaceholderText("Daniel Tan"), { target: { value: "Daniel Tan" } });
    await user.click(screen.getByRole("button", { name: "Create tenant" }));

    expect(await screen.findByText("Already used by Daniel Tan")).toBeInTheDocument();
  });

  test("clears stale field errors on a fresh submit attempt", async () => {
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError("Check the highlighted 1 fields and try again.", 400, undefined, {
        error: "Check the highlighted 1 fields and try again.",
        fieldErrors: { primaryEmail: "Email is required." },
      }),
    );
    mockApiFetch.mockResolvedValueOnce({});

    const user = userEvent.setup();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.change(screen.getByPlaceholderText("Daniel Tan"), { target: { value: "Test User" } });

    // First submit rejects — inline error appears.
    await user.click(screen.getByRole("button", { name: "Create tenant" }));
    expect(await screen.findByText("Email is required.")).toBeInTheDocument();

    // Second submit succeeds — the stale field error must not linger.
    await user.click(screen.getByRole("button", { name: "Create tenant" }));
    await waitFor(() => expect(screen.queryByText("Email is required.")).not.toBeInTheDocument());
  });
});

// ── Reservation prefill from the FULL record (Part A) ───────────────────────
//
// The picker only carries fullName/nricMasked/contact/email; selecting a
// reservation now fetches the full record (getReservation) and prefills the
// rest — including the UNMASKED IC and occupation the applicant already gave.

const pickable: PickableReservationDto = {
  id: "res-1",
  referenceCode: "RSV-001",
  applicant: {
    fullName: "Nurul Izzah",
    nricMasked: "••••5678",
    contact: "+60129990001",
    email: "nurul@example.com",
  },
  proposedMoveIn: "2026-08-01",
  proposedMoveOut: null,
  agreedMonthlyRent: "1500",
  unit: { label: "A-1-1" },
};

const fullReservation: ReservationDto = {
  id: "res-1",
  referenceCode: "RSV-001",
  status: "signed",
  issuedAt: "2026-07-01T00:00:00.000Z",
  expiresAt: "2026-08-01T00:00:00.000Z",
  property: { id: "p1", name: "Test Property" },
  unit: { id: "u1", unitCode: "A-1-1" },
  carPark: null,
  proposedMoveIn: "2026-08-01",
  proposedMoveOut: null,
  specialRemarks: null,
  charges: {
    reservationDeposit: "500",
    documentationFee: "0",
    rentalDeposit: "3000",
    utilityDeposit: "0",
    accessCardDeposit: "0",
  },
  agreedMonthlyRent: "1500",
  applicant: {
    fullName: "Nurul Izzah",
    nric: "900101-10-5678",
    contact: "+60129990001",
    email: "nurul@example.com",
    addressLine1: null,
    addressLine2: null,
    city: null,
    postcode: null,
    state: null,
    country: null,
    nationality: "MY",
    occupation: "Accountant",
    monthlyIncome: "4200",
    emergencyContactName: "Ali Bin Abu",
    emergencyContactPhone: "+60111112222",
    emergencyContactRelation: "Spouse",
  },
  documents: [],
  signedAt: "2026-07-02T00:00:00.000Z",
  signedPdfDownloadUrl: null,
  customTerms: [],
  approvalNote: null,
};

describe("CreateTenantDialog — reservation prefill (full record)", () => {
  beforeEach(() => {
    vi.mocked(isPhase2FlagEnabled).mockReturnValue(true);
    vi.mocked(listPickableReservations).mockResolvedValue([pickable]);
    vi.mocked(getReservation).mockResolvedValue(fullReservation);
  });
  afterEach(() => {
    // Restore the OFF default so the remaining suite is unaffected by ordering.
    vi.mocked(isPhase2FlagEnabled).mockReturnValue(false);
  });

  test("selecting a reservation prefills the unmasked IC and occupation from the full record", async () => {
    const user = userEvent.setup();
    wrap(<CreateTenantDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    // The picker appears once the pickable list resolves.
    const picker = await screen.findByLabelText("From reservation");
    await user.selectOptions(picker, "res-1");

    // Full record resolves → prefilled fields mount with the reservation data.
    // The unmasked IC (not available on the picker) is the crux of the fix.
    expect(await screen.findByDisplayValue("900101-10-5678")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Accountant")).toBeInTheDocument();
    // idType auto-picks NRIC for a Malaysian applicant with an IC on file.
    expect((screen.getByLabelText("ID type") as HTMLSelectElement).value).toBe("NRIC");
  });
});
