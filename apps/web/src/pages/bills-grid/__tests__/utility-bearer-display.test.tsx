// How the Unit setting drawer's "who bears this cost" answer SHOWS UP in the grid, for
// the two provider-bill bands (2026-08-14). Render-level twin of cell-applicability.test.ts:
// that file pins the predicate, this one pins that the predicate reaches the screen.
//
//   AIR  owns Owner + Tenant columns -> the amount RENDERS under the side that bears it.
//        From bd80276a (2026-07-27) until this fix the split keyed on the legacy
//        "tenant_direct", which the drawer can no longer write, so every choice landed on
//        Owner and the Tenant column was permanently blank.
//   TNB  owns ONE column, headed "Owner", and is not gaining a second (client decision):
//        the figure typed there is the master provider bill, while the tenant's share is
//        the per-room meter + pax split — a different number, so a "Tenant" header over it
//        would state something false. It carries a corner "T" marker instead.
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { GridRow, GridEntryDto, GridBearerConfigDto, GridSubRow } from "@/api/bills-grid";
import { GridTable } from "../grid-table";
import { CURRENT_COLUMNS } from "../columns";

function makeEntry(partial: Partial<GridEntryDto> = {}): GridEntryDto {
  return {
    cleaning: null,
    tnbTotal: "500.00",
    airSelangor: "40.00",
    wifi: null,
    maintenanceFee: null,
    readingDate: null,
    paymentStatus: "unpaid",
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lockState: "draft",
    ...partial,
  };
}

function makeBearerConfig(partial: Partial<GridBearerConfigDto> = {}): GridBearerConfigDto {
  return {
    tnbPattern: "recharged",
    airPattern: "recharged",
    cleaningBearer: "owner",
    wifiBearer: "owner",
    maintenanceFeeBearer: "owner",
    cleaningRecurringAmount: "0.00",
    isLocked: false,
    ...partial,
  };
}

function makeSubRow(partial: Partial<GridSubRow> = {}): GridSubRow {
  return {
    listingId: "L1",
    tenancyId: "T1",
    partyName: "Tenant",
    previousKwh: null,
    currentKwh: null,
    amount: null,
    ratePerKwh: "0.6000",
    rateConfigured: false,
    rental: null,
    ...partial,
  } as GridSubRow;
}

function makeRow(partial: Partial<GridRow> = {}): GridRow {
  return {
    apartmentId: "APT1",
    unitCode: "PV9 A-13-13",
    propertyId: "PROP1",
    propertyName: "Sunway Vista",
    entryId: null,
    preview: null,
    previewError: null,
    warnings: [],
    subRows: [makeSubRow()],
    billedAt: null,
    paymentStatus: "unpaid",
    priorMonths: [],
    entry: null,
    bearerConfig: makeBearerConfig(),
    expenses: {
      tenant: { total: "0.00", withSstTotal: "0.00", count: 0 },
      owner: { total: "0.00", withSstTotal: "0.00", count: 0 },
    },
    attachments: [],
    isWholeUnit: true,
    ...partial,
  };
}

const MARK = "tenant-borne-mark";

/** The rendered AIR cells, as the admin sees them: which one holds an input, and what
 *  each displays. An inapplicable side renders a LockedCell showing "—". */
function airCells() {
  const owner = screen.getByTestId("cell-airOwner");
  const tenant = screen.getByTestId("cell-airTenant");
  return {
    ownerInput: within(owner).queryByRole("textbox") as HTMLInputElement | null,
    tenantInput: within(tenant).queryByRole("textbox") as HTMLInputElement | null,
    ownerText: owner.textContent ?? "",
    tenantText: tenant.textContent ?? "",
  };
}

describe("AIR — the amount renders under the side that bears it", () => {
  it('Tenant ("recharged") puts the water bill in the Tenant column, not Owner', () => {
    const row = makeRow({ entry: makeEntry({ airPattern: "recharged" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const air = airCells();
    expect(air.tenantInput).not.toBeNull();
    expect(air.tenantInput!.value).toBe("40.00");
    expect(air.ownerInput).toBeNull();
    expect(air.ownerText).toBe("—");
  });

  it('Owner ("absorbed") puts it in the Owner column, not Tenant', () => {
    const row = makeRow({ entry: makeEntry({ airPattern: "absorbed" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const air = airCells();
    expect(air.ownerInput).not.toBeNull();
    expect(air.ownerInput!.value).toBe("40.00");
    expect(air.tenantInput).toBeNull();
    expect(air.tenantText).toBe("—");
  });

  it("the amount is never shown on both sides at once, whatever the pattern", () => {
    for (const airPattern of ["absorbed", "recharged", "tenant_direct", "manager_advanced"]) {
      const { unmount } = render(
        <GridTable rows={[makeRow({ entry: makeEntry({ airPattern }) })]} columns={CURRENT_COLUMNS} />,
      );
      const air = airCells();
      expect([air.ownerInput, air.tenantInput].filter(Boolean), `airPattern=${airPattern}`).toHaveLength(1);
      unmount();
    }
  });
});

describe("TNB — one Owner column, so the bearer shows as a corner marker", () => {
  it('marks the cell when TNB is set to Tenant ("recharged")', () => {
    const row = makeRow({ entry: makeEntry({ tnbPattern: "recharged" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    expect(screen.getByTestId("cell-tnbOwner")).toContainElement(screen.getByTestId(MARK));
    expect(screen.getByTestId(MARK)).toHaveTextContent("T");
  });

  it('leaves the cell unmarked when TNB is set to Owner ("absorbed")', () => {
    const row = makeRow({ entry: makeEntry({ tnbPattern: "absorbed" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    expect(screen.getByTestId("cell-tnbOwner")).toBeInTheDocument();
    expect(screen.queryByTestId(MARK)).not.toBeInTheDocument();
  });

  it("names the state for screen readers, not just a bare letter", () => {
    const row = makeRow({ entry: makeEntry({ tnbPattern: "recharged" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId(MARK)).toHaveTextContent(/borne by the tenant/i);
  });

  it("the hover tooltip sits on the CELL, not on the pointer-events-none mark", () => {
    // Review finding 1: `pointer-events: none` makes the mark un-hit-testable, so a
    // `title` on the mark itself can never render a native tooltip — a sighted admin
    // would get an unexplained letter. The cell is the hoverable element.
    const row = makeRow({ entry: makeEntry({ tnbPattern: "recharged" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    expect(screen.getByTestId("cell-tnbOwner")).toHaveAttribute("title", expect.stringMatching(/borne by the tenant/i));
    expect(screen.getByTestId(MARK)).not.toHaveAttribute("title");
  });

  it("an unmarked cell carries no stray tooltip", () => {
    const row = makeRow({ entry: makeEntry({ tnbPattern: "absorbed" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-tnbOwner")).not.toHaveAttribute("title");
  });

  it('legacy "manager_advanced" is not described as "recharged" — KAEN fronted it', () => {
    // Review finding 6: the drawer calls this value "KAEN advanced (legacy)". The mark
    // answers the one question both share — who BEARS it — so it must not assert the
    // recharge mechanism, which is a different fact.
    const row = makeRow({ entry: makeEntry({ tnbPattern: "manager_advanced" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const mark = screen.getByTestId(MARK);
    expect(mark).toHaveTextContent(/borne by the tenant/i);
    expect(mark.textContent ?? "").not.toMatch(/recharged/i);
  });

  it("marks a BILLED (locked) row too — the setting still applies, the cell is just read-only", () => {
    // A locked row renders through LockedCell, a different branch. The marker has to be on
    // both or the answer disappears exactly when an admin is auditing what was billed.
    const row = makeRow({
      billedAt: "2026-08-10T00:00:00.000Z",
      entry: makeEntry({ tnbPattern: "recharged", lockState: "locked" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-tnbOwner")).toContainElement(screen.getByTestId(MARK));
  });

  it("falls back to the unit config when the month has no entry yet", () => {
    const row = makeRow({ entry: null, bearerConfig: makeBearerConfig({ tnbPattern: "recharged" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-tnbOwner")).toContainElement(screen.getByTestId(MARK));
  });

  it("the OPENED month's snapshot wins over a since-changed unit default", () => {
    // getOrCreateEntry snapshots the config on first open and never re-reads it, so the
    // marker must report what this month will actually bill, not the current setting.
    const row = makeRow({
      entry: makeEntry({ tnbPattern: "absorbed" }),
      bearerConfig: makeBearerConfig({ tnbPattern: "recharged" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId(MARK)).not.toBeInTheDocument();
  });

  it('still marks the cell under legacy "tenant pays directly", where it is greyed', () => {
    // The one inapplicable case a single-column band has, and the one where the tenant
    // most unambiguously bears the cost. Dropping the mark here left a bare "—" in exactly
    // the situation it exists to explain — and the module comment claimed otherwise.
    const row = makeRow({ entry: makeEntry({ tnbPattern: "tenant_direct" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);

    const cell = screen.getByTestId("cell-tnbOwner");
    expect(cell).toHaveTextContent("—");
    expect(cell).toContainElement(screen.getByTestId(MARK));
  });

  it("does NOT mark the AIR cells — their column split already says it", () => {
    const row = makeRow({ entry: makeEntry({ airPattern: "recharged" }) });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    // Exactly one marker in the whole row, and it belongs to TNB.
    expect(screen.getAllByTestId(MARK)).toHaveLength(1);
    expect(screen.getByTestId("cell-tnbOwner")).toContainElement(screen.getByTestId(MARK));
  });
});

describe("Maintenance Fee — the other single-column band", () => {
  // Same shape as TNB: one money column headed "Owner" (columns.ts:36) and no tenant-side
  // sibling, so a tenant-borne fee read as owner-borne with nothing on screen to say
  // otherwise. This is live money — computeAllocation pools a tenant-borne maintenance fee
  // into the per-pax split — and the drawer still renders "Borne by the tenant" as a real
  // state (setting-drawer.tsx), even though its bearer CONTROL was removed, so existing
  // rows can carry it. Added 2026-08-16 on the user's call after the review raised it.
  it("marks the cell when maintenance is borne by the tenant", () => {
    const row = makeRow({
      // TNB owner-borne so this row carries exactly ONE mark, and it is the maintenance one.
      entry: makeEntry({ maintenanceFeeBearer: "tenant", maintenanceFee: "50.00", tnbPattern: "absorbed" }),
      bearerConfig: makeBearerConfig({ maintenanceFeeBearer: "tenant", tnbPattern: "absorbed" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-maintenanceFee")).toContainElement(screen.getByTestId(MARK));
  });

  it("TNB and Maintenance can be marked independently in the same row", () => {
    const row = makeRow({
      entry: makeEntry({ tnbPattern: "recharged", maintenanceFeeBearer: "tenant", maintenanceFee: "50.00" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getAllByTestId(MARK)).toHaveLength(2);
  });

  it("leaves the owner-borne default unmarked", () => {
    const row = makeRow({
      entry: makeEntry({ maintenanceFeeBearer: "owner", maintenanceFee: "50.00", tnbPattern: "absorbed" }),
      bearerConfig: makeBearerConfig({ maintenanceFeeBearer: "owner", tnbPattern: "absorbed" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId(MARK)).not.toBeInTheDocument();
  });

  it("reads the OPENED month's snapshot, not the unit's current default", () => {
    const row = makeRow({
      entry: makeEntry({ maintenanceFeeBearer: "owner", tnbPattern: "absorbed" }),
      bearerConfig: makeBearerConfig({ maintenanceFeeBearer: "tenant", tnbPattern: "absorbed" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.queryByTestId(MARK)).not.toBeInTheDocument();
  });

  it("marks a billed (read-only) maintenance cell too", () => {
    const row = makeRow({
      billedAt: "2026-08-10T00:00:00.000Z",
      entry: makeEntry({ maintenanceFeeBearer: "tenant", maintenanceFee: "50.00", tnbPattern: "absorbed", lockState: "locked" }),
    });
    render(<GridTable rows={[row]} columns={CURRENT_COLUMNS} />);
    expect(screen.getByTestId("cell-maintenanceFee")).toContainElement(screen.getByTestId(MARK));
  });
});
