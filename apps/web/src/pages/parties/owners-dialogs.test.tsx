import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { EditOwnerDialog, CreateOwnerDialog } from "./owners-action-dialogs";
import { OwnerTable } from "./owners-table";
import type { OwnerListItem } from "./owners-table";
import { OwnerDetailPanel } from "./owner-detail-panel";
import { useOwnerDetail } from "@/api/parties-detail";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatRM } from "@/components/format";

// Mock apiFetch so mutations don't throw during menu-only interaction tests.
// ApiError is kept real (importOriginal) so onError handlers that do
// `err instanceof ApiError` / read `err.data.fieldErrors` work under test —
// a plain object literal here would silently fail `instanceof` checks.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn().mockResolvedValue({}) };
});

// Mock useOwnerDetail so the EditOwnerDialog's detail fetch is controlled in tests.
// Default: returns no data (loading finished, nothing returned) — existing tests are unaffected.
// useRevealPartyIc is stubbed too — OwnerDetailPanel's IcRevealField calls it
// unconditionally on mount (only OwnerDetailPanel tests render that far).
vi.mock("@/api/parties-detail", () => ({
  useOwnerDetail: vi.fn(() => ({ data: undefined, isLoading: false })),
  useRevealPartyIc: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

// PortalAccessSection renders RoleGate, which calls useAuth() — real usage needs
// an AuthProvider we don't set up here. Mirrors the existing dedicated
// __tests__/owner-detail-panel.test.tsx precedent: stub the section out entirely
// (only OwnerDetailPanel tests render this deep).
vi.mock("./portal-access-section", () => ({
  PortalAccessSection: () => null,
}));

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

const owner: OwnerListItem = {
  id: "1", displayName: "Dato Razak", legalName: null, primaryEmail: null,
  primaryPhone: "60123456789", formattedPhone: "+60 12-345 6789",
  status: "active", isBlacklisted: false, createdAt: "",
  nationality: "MY", bankName: "Maybank", bankAccountHolder: "Dato Razak Bin Ali",
  bankAccountNumber: "1234567890", idType: null, idNumber: null,
  blacklistReason: null, deletable: true,
};

const wrap = (ui: React.ReactNode) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );

describe("EditOwnerDialog prefill", () => {
  test("shows stored nationality and bank fields", () => {
    wrap(<EditOwnerDialog owner={owner} open onOpenChange={() => {}} />);
    const nat = screen.getByLabelText("Nationality") as HTMLSelectElement;
    expect(nat.value).toBe("MY");
    expect(screen.getByDisplayValue("Maybank")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Dato Razak Bin Ali")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1234567890")).toBeInTheDocument();
  });
});

// ── OwnerRow actions menu per state ──────────────────────────────────────────

const blacklistedOwner: OwnerListItem = {
  id: "bl-1", displayName: "Blacklisted Owner", legalName: null, primaryEmail: null,
  primaryPhone: null, formattedPhone: null,
  status: "inactive", isBlacklisted: true, createdAt: "",
  nationality: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null,
  idType: null, idNumber: null, blacklistReason: "Fraud", deletable: false,
};

const activeDeletableOwner: OwnerListItem = {
  id: "ad-1", displayName: "Active Deletable Owner", legalName: null, primaryEmail: null,
  primaryPhone: null, formattedPhone: null,
  status: "active", isBlacklisted: false, createdAt: "",
  nationality: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null,
  idType: null, idNumber: null, blacklistReason: null, deletable: true,
};

const inactiveOwner: OwnerListItem = {
  id: "in-1", displayName: "Inactive Owner", legalName: null, primaryEmail: null,
  primaryPhone: null, formattedPhone: null,
  status: "inactive", isBlacklisted: false, createdAt: "",
  nationality: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null,
  idType: null, idNumber: null, blacklistReason: null, deletable: false,
};

// The mock renders DropdownMenuContent inline (no portal/open state needed).
// We scope per-row via the Actions cell to avoid cross-row false positives.
function wrapTable(owners: OwnerListItem[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OwnerTable owners={owners} />
    </QueryClientProvider>
  );
}

function getMenuForOwner(displayName: string) {
  const trigger = screen.getByRole("button", { name: `Actions for ${displayName}` });
  return trigger.closest("td") ?? trigger.parentElement!;
}

describe("OwnerRow actions menu — blacklisted row", () => {
  test("shows 'Resolve blacklist' and hides Blacklist + Deactivate", () => {
    wrapTable([blacklistedOwner]);
    const cell = getMenuForOwner("Blacklisted Owner");
    expect(within(cell).getByText("Resolve blacklist")).toBeInTheDocument();
    expect(within(cell).queryByText("Blacklist")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Deactivate")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Delete")).not.toBeInTheDocument();
  });
});

describe("OwnerRow actions menu — active deletable row", () => {
  test("shows Deactivate, Blacklist, and Delete", () => {
    wrapTable([activeDeletableOwner]);
    const cell = getMenuForOwner("Active Deletable Owner");
    expect(within(cell).getByText("Deactivate")).toBeInTheDocument();
    expect(within(cell).getByText("Blacklist")).toBeInTheDocument();
    expect(within(cell).getByText("Delete")).toBeInTheDocument();
    expect(within(cell).queryByText("Resolve blacklist")).not.toBeInTheDocument();
  });
});

describe("OwnerRow actions menu — inactive non-blacklisted row", () => {
  test("shows Activate and Edit; hides Deactivate, Resolve blacklist, Delete", () => {
    wrapTable([inactiveOwner]);
    const cell = getMenuForOwner("Inactive Owner");
    expect(within(cell).getByText("Activate")).toBeInTheDocument();
    expect(within(cell).getByText("Edit")).toBeInTheDocument();
    expect(within(cell).queryByText("Deactivate")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Resolve blacklist")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Delete")).not.toBeInTheDocument();
  });
});

describe("Phone validity — blocks invalid submit", () => {
  test("shows inline error and stays open when phone is invalid", async () => {
    const user = userEvent.setup();
    wrap(<CreateOwnerDialog trigger={<button>Open</button>} />);

    // Open the dialog
    await user.click(screen.getByRole("button", { name: "Open" }));

    // Fill in the required display name to pass HTML validation
    await user.type(screen.getByPlaceholderText("Apex Holdings"), "Test Owner");

    // Type an invalid phone number into the phone input (just digits, no valid MY format)
    const phoneInput = screen.getByPlaceholderText("12-345 6789");
    await user.type(phoneInput, "123"); // too short to be valid
    await user.tab(); // blur triggers onValidityChange("invalid")

    // Click submit
    await user.click(screen.getByRole("button", { name: "Create owner" }));

    // Error should appear and dialog stays open
    expect(screen.getByText("Enter a valid Malaysian mobile number")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create owner" })).toBeInTheDocument();
  });
});

describe("Phone validity — resets on dialog close (regression)", () => {
  test("phone error is cleared after closing and reopening the Create dialog", async () => {
    const user = userEvent.setup();
    wrap(<CreateOwnerDialog trigger={<button>Open</button>} />);

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

describe("EditOwnerDialog — full-parity fields (IC, gender, DOB, WhatsApp)", () => {
  test("renders gender/DOB/WhatsApp prefilled from detail; IC blank stays unsent on submit", async () => {
    // Arrange: mock useOwnerDetail to return full owner detail with the new fields
    vi.mocked(useOwnerDetail).mockReturnValue({
      data: {
        id: "1",
        displayName: "Dato Razak",
        legalName: null,
        primaryEmail: null,
        primaryPhone: "60123456789",
        formattedPhone: "+60 12-345 6789",
        whatsappPhone: "+60129876543",
        idType: "NRIC",
        idNumberMasked: "••••1234",
        nationality: "MY",
        gender: "male",
        dateOfBirth: "1970-05-15T00:00:00.000Z",
        isBlacklisted: false,
        blacklistReason: null,
        status: "active",
        bank: { name: "Maybank", accountHolder: "Dato Razak Bin Ali", accountNumber: "1234567890" },
        unitsOwned: [],
        createdAt: "",
        portalUser: null,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useOwnerDetail>);

    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    wrap(<EditOwnerDialog owner={owner} open onOpenChange={() => {}} />);

    // Assert: gender select prefills with "male"
    const genderSelect = screen.getByLabelText("Gender") as HTMLSelectElement;
    expect(genderSelect.value).toBe("male");

    // Assert: DOB input prefills with "1970-05-15" (ISO date truncated from full timestamp)
    const dobInput = screen.getByLabelText("Date of birth") as HTMLInputElement;
    expect(dobInput.value).toBe("1970-05-15");

    // Assert: WhatsApp input prefills with detail value
    const whatsappInput = screen.getByDisplayValue("+60129876543") as HTMLInputElement;
    expect(whatsappInput).toBeInTheDocument();

    // Assert: IC number input is empty (blank-to-keep behaviour)
    const icInput = screen.getByPlaceholderText(/Enter new IC to replace/i) as HTMLInputElement;
    expect(icInput.value).toBe("");

    // Act: submit the form without entering an IC
    await user.click(screen.getByRole("button", { name: "Update owner" }));

    // Assert: apiFetch was called for the PUT
    expect(mockApiFetch).toHaveBeenCalled();
    const [, opts] = mockApiFetch.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, string>;

    // New fields present in body
    expect(body.gender).toBe("male");
    expect(body.dateOfBirth).toBe("1970-05-15");
    expect(body.whatsappPhone).toBe("+60129876543");

    // IC left blank → getFormData drops it → not in PUT body
    expect(body).not.toHaveProperty("idNumber");
  });
});

describe("CreateOwnerDialog — owner profile fields (WhatsApp, gender, DOB, employment, emergency contact)", () => {
  test("owner profile fields: create dialog renders and submits new fields", async () => {
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    wrap(<CreateOwnerDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    fireEvent.change(screen.getByPlaceholderText("Apex Holdings"), { target: { value: "New Owner Sdn Bhd" } });

    // Fill all 10 new fields.
    // NOTE: these are uncontrolled inputs (name=-based, read via getFormData(new
    // FormData(form)) at submit) so fireEvent.change (one-shot) is equivalent to
    // user.type (character-by-character) here but far faster — same pattern as
    // the Date-of-birth line above. Keeps this test fast under full-suite CPU
    // contention, where userEvent's per-keystroke pipeline across ~10 fields was
    // pushing this test past the default 5s testTimeout intermittently.
    await user.selectOptions(screen.getByLabelText("Gender"), "male");
    fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1970-05-15" } });
    fireEvent.change(screen.getByLabelText("WhatsApp"), { target: { value: "+60129998888" } });
    fireEvent.change(screen.getByLabelText("Occupation"), { target: { value: "Property investor" } });
    fireEvent.change(screen.getByLabelText("Employer name"), { target: { value: "Own business" } });
    fireEvent.change(screen.getByLabelText("Employer address"), { target: { value: "1 Jalan Test" } });
    fireEvent.change(screen.getByLabelText("Monthly income"), { target: { value: "12000" } });
    fireEvent.change(screen.getByLabelText("Emergency contact name"), { target: { value: "Lim Ah Kow" } });
    fireEvent.change(screen.getByLabelText("Emergency contact phone"), { target: { value: "+60111234567" } });
    fireEvent.change(screen.getByLabelText("Emergency contact relation"), { target: { value: "Spouse" } });

    // Regression guard (checked while the dialog is still open — it unmounts
    // on submit success): "Company name" is the EXISTING legalName field, not a
    // new one, and there is exactly one legalName input, no companyName input.
    expect(document.querySelector('input[name="companyName"]')).toBeNull();
    expect(document.querySelectorAll('input[name="legalName"]')).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Create owner" }));

    expect(mockApiFetch).toHaveBeenCalled();
    const [, opts] = mockApiFetch.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, string>;

    expect(body.gender).toBe("male");
    expect(body.dateOfBirth).toBe("1970-05-15");
    expect(body.whatsappPhone).toBe("+60129998888");
    expect(body.occupation).toBe("Property investor");
    expect(body.employerName).toBe("Own business");
    expect(body.employerAddress).toBe("1 Jalan Test");
    expect(body.monthlyIncome).toBe("12000");
    expect(body.emergencyContactName).toBe("Lim Ah Kow");
    expect(body.emergencyContactPhone).toBe("+60111234567");
    expect(body.emergencyContactRelation).toBe("Spouse");

    // Regression guard: "Company name" is the EXISTING legalName field, not a new one.
    expect(body.legalName).toBeUndefined(); // left blank in this test — never set
  });
});

describe("EditOwnerDialog — owner profile fields it lacked (occupation, employer, employer address, monthly income, emergency contact)", () => {
  const ownerDetailWithProfile = {
    id: "1",
    displayName: "Dato Razak",
    legalName: null,
    primaryEmail: null,
    primaryPhone: "60123456789",
    formattedPhone: "+60 12-345 6789",
    whatsappPhone: "+60129876543",
    idType: "NRIC",
    idNumberMasked: "••••1234",
    nationality: "MY",
    gender: "male",
    dateOfBirth: "1970-05-15T00:00:00.000Z",
    occupation: "Property investor",
    employerName: "Own business",
    employerAddress: "1 Jalan Test",
    monthlyIncome: "12000",
    emergencyContactName: "Lim Ah Kow",
    emergencyContactPhone: "+60111234567",
    emergencyContactRelation: "Spouse",
    isBlacklisted: false,
    blacklistReason: null,
    status: "active",
    bank: { name: "Maybank", accountHolder: "Dato Razak Bin Ali", accountNumber: "1234567890" },
    unitsOwned: [],
    createdAt: "",
    portalUser: null,
  };

  test("owner profile fields: edit dialog prefills and submits lacked fields", async () => {
    vi.mocked(useOwnerDetail).mockReturnValue({
      data: ownerDetailWithProfile,
      isLoading: false,
    } as unknown as ReturnType<typeof useOwnerDetail>);

    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    wrap(<EditOwnerDialog owner={owner} open onOpenChange={() => {}} />);

    // Assert: prefilled from detail.
    expect(screen.getByDisplayValue("Property investor")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Own business")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1 Jalan Test")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12000")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Lim Ah Kow")).toBeInTheDocument();
    expect(screen.getByDisplayValue("+60111234567")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Spouse")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Update owner" }));

    expect(mockApiFetch).toHaveBeenCalled();
    const [, opts] = mockApiFetch.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, string>;

    expect(body.occupation).toBe("Property investor");
    expect(body.employerName).toBe("Own business");
    expect(body.employerAddress).toBe("1 Jalan Test");
    expect(body.monthlyIncome).toBe("12000");
    expect(body.emergencyContactName).toBe("Lim Ah Kow");
    expect(body.emergencyContactPhone).toBe("+60111234567");
    expect(body.emergencyContactRelation).toBe("Spouse");
  });

  test("owner profile fields: edit dialog sends blank string for a cleared field", async () => {
    vi.mocked(useOwnerDetail).mockReturnValue({
      data: ownerDetailWithProfile,
      isLoading: false,
    } as unknown as ReturnType<typeof useOwnerDetail>);

    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();

    const user = userEvent.setup();
    wrap(<EditOwnerDialog owner={owner} open onOpenChange={() => {}} />);

    // Clear the prefilled Occupation and Monthly income to blank.
    await user.clear(screen.getByDisplayValue("Property investor"));
    await user.clear(screen.getByDisplayValue("12000"));
    await user.click(screen.getByRole("button", { name: "Update owner" }));

    const [, opts] = mockApiFetch.mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, string>;
    // blank = blank: cleared fields are SENT as "" so the backend nulls them
    // (getEditFormData semantics — same as the existing tenant/owner Edit fields).
    expect(body.occupation).toBe("");
    expect(body.monthlyIncome).toBe("");
    // Untouched fields still carry their prefilled values.
    expect(body.employerName).toBe("Own business");
    expect(body.emergencyContactName).toBe("Lim Ah Kow");
  });
});

describe("OwnerDetailPanel — Employment + Emergency contact sections", () => {
  const fullOwnerDetail = {
    id: "1",
    displayName: "Dato Razak",
    legalName: "Apex Holdings Sdn Bhd",
    primaryEmail: "ops@apex.com",
    primaryPhone: "60123456789",
    formattedPhone: "+60 12-345 6789",
    whatsappPhone: "+60129876543",
    idType: "NRIC",
    idNumberMasked: "••••1234",
    nationality: "MY",
    gender: "male",
    dateOfBirth: "1970-05-15T00:00:00.000Z",
    occupation: "Property investor",
    employerName: "Own business",
    employerAddress: "1 Jalan Test",
    monthlyIncome: "12000",
    emergencyContactName: "Lim Ah Kow",
    emergencyContactPhone: "+60111234567",
    emergencyContactRelation: "Spouse",
    isBlacklisted: false,
    blacklistReason: null,
    status: "active",
    bank: { name: "Maybank", accountHolder: "Dato Razak Bin Ali", accountNumber: "1234567890" },
    unitsOwned: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    portalUser: null,
  };

  test("owner detail shows employment section with monthly income", () => {
    vi.mocked(useOwnerDetail).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: fullOwnerDetail,
    } as unknown as ReturnType<typeof useOwnerDetail>);

    const rendered = wrap(<OwnerDetailPanel partyId="1" />);

    // Employment section shows the profile data — not write-only.
    expect(screen.getByText("Employment")).toBeInTheDocument();
    expect(screen.getByText("Property investor")).toBeInTheDocument();
    expect(screen.getByText("Own business")).toBeInTheDocument();
    expect(screen.getByText("1 Jalan Test")).toBeInTheDocument();
    expect(screen.getByText(formatRM(12000))).toBeInTheDocument();

    // Emergency contact section
    expect(screen.getByText("Emergency contact")).toBeInTheDocument();
    expect(screen.getByText("Lim Ah Kow")).toBeInTheDocument();
    expect(screen.getByText("+60111234567")).toBeInTheDocument();
    expect(screen.getByText("Spouse")).toBeInTheDocument();

    // Boundary: absent employment/emergency data renders dash placeholders, no crash.
    rendered.unmount();
    vi.mocked(useOwnerDetail).mockReturnValue({
      isLoading: false,
      isError: false,
      error: null,
      data: {
        ...fullOwnerDetail,
        occupation: null,
        employerName: null,
        employerAddress: null,
        monthlyIncome: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelation: null,
      },
    } as unknown as ReturnType<typeof useOwnerDetail>);

    wrap(<OwnerDetailPanel partyId="1" />);
    const employmentGroup = screen.getByText("Employment").closest("div")!;
    expect(within(employmentGroup).getAllByText("—")).toHaveLength(4);
    const emergencyGroup = screen.getByText("Emergency contact").closest("div")!;
    expect(within(emergencyGroup).getAllByText("—")).toHaveLength(3);
  });
});

// ── Server-side field errors (#3.2) ─────────────────────────────────────────
//
// Backend validation failures return { error, fieldErrors } via formatZodError
// (apps/api/src/lib/zod-error-mapper.ts), carried on ApiError.data. Before this
// fix, onError only toast.error(err.message) and never read err.data.fieldErrors,
// so "Check the highlighted N fields" highlighted nothing.

describe("CreateOwnerDialog — server-side field errors", () => {
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
    wrap(<CreateOwnerDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    fireEvent.change(screen.getByPlaceholderText("Apex Holdings"), { target: { value: "Test Owner" } });
    await user.click(screen.getByRole("button", { name: "Create owner" }));

    // Inline field error (not just the toast) is what this task adds.
    expect(await screen.findByText("Email is required.")).toBeInTheDocument();
  });

  // Regression (duplicate-on-create): a 409 conflict now carries the same
  // { error, fieldErrors } contract as a 400 — and the owner route (which used
  // to drop the body entirely) now surfaces it — so the offending input reddens
  // instead of only a generic "Conflict…" toast. Characterizes the client half;
  // the 409 emission + route guard are TDD'd on the API side.
  test("reddens the field inline when a DUPLICATE (409) carries fieldErrors", async () => {
    const mockApiFetch = vi.mocked(apiFetch);
    mockApiFetch.mockClear();
    mockApiFetch.mockRejectedValueOnce(
      new ApiError("This email is already used by Apex Holdings.", 409, undefined, {
        error: "This email is already used by Apex Holdings.",
        fieldErrors: { primaryEmail: "Already used by Apex Holdings" },
      }),
    );

    const user = userEvent.setup();
    wrap(<CreateOwnerDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    fireEvent.change(screen.getByPlaceholderText("Apex Holdings"), { target: { value: "New Owner" } });
    await user.click(screen.getByRole("button", { name: "Create owner" }));

    expect(await screen.findByText("Already used by Apex Holdings")).toBeInTheDocument();
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
    wrap(<CreateOwnerDialog trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.change(screen.getByPlaceholderText("Apex Holdings"), { target: { value: "Test Owner" } });

    // First submit rejects — inline error appears.
    await user.click(screen.getByRole("button", { name: "Create owner" }));
    expect(await screen.findByText("Email is required.")).toBeInTheDocument();

    // Second submit succeeds — the stale field error must not linger.
    await user.click(screen.getByRole("button", { name: "Create owner" }));
    await waitFor(() => expect(screen.queryByText("Email is required.")).not.toBeInTheDocument());
  });
});
