import { describe, expect, it } from "vitest";
import {
  bearerConfigSchema,
  billSchema,
  createExpensesSchema,
  gridQuerySchema,
  lineSettingsSchema,
  saveEntrySchema,
  saveReadingsSchema,
  updateExpenseSchema,
} from "../bills-grid";

const APT = "b0a7f8f2-1c1e-4c9e-9a1d-2f3b4c5d6e7f";
const TEN = "c1b8a9e3-2d2f-4dae-8b2e-3a4c5d6e7f80";
const PTY = "d2c9bafd-3e30-4ebf-9c3f-4b5d6e7f8091";

describe("bills-grid schemas", () => {
  it("money accepts 2dp, rejects 3dp and formulas", () => {
    // Uses `cleaning` (a still-present money field): `rental` was dropped from
    // saveEntrySchema in the auto-calc-derivation work (server-derived now), so
    // the `money` validator is exercised via cleaning instead.
    expect(saveEntrySchema.safeParse({ period: "2026-07-01", cleaning: "3000.00" }).success).toBe(true);
    expect(saveEntrySchema.safeParse({ period: "2026-07-01", cleaning: "10.001" }).success).toBe(false);
    expect(saveEntrySchema.safeParse({ period: "2026-07-01", cleaning: "=SUM(A1)" }).success).toBe(false);
  });

  it("saveEntrySchema is amounts-only — it strips pattern/bearer fields (C4)", () => {
    const r = saveEntrySchema.safeParse({ period: "2026-07-01", tnbTotal: "590.00", tnbPattern: "absorbed" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect("tnbPattern" in r.data).toBe(false);
  });

  it("lineSettingsSchema rejects a bearer value in a pattern field (Invariant 3)", () => {
    const base = { tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" };
    expect(lineSettingsSchema.safeParse(base).success).toBe(true);
    expect(lineSettingsSchema.safeParse({ ...base, tnbPattern: "owner" }).success).toBe(false);
    expect(lineSettingsSchema.safeParse({ ...base, cleaningBearer: "absorbed" }).success).toBe(false);
  });

  // Task 4 (bills-grid grid funded-by capture): utilityPattern widens to accept
  // "manager_advanced" (KAEN fronts the provider, recovers from the tenant pool —
  // fundedBy=manager, see fundedByForUtility in service.ts). The enum stays
  // CLOSED — a bogus value must still be rejected (no accidental z.string() loosening).
  it("lineSettingsSchema accepts manager_advanced for tnbPattern/airPattern; still rejects an unrecognized pattern value", () => {
    const base = { tnbPattern: "recharged", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner" };
    expect(lineSettingsSchema.safeParse({ ...base, tnbPattern: "manager_advanced" }).success).toBe(true);
    expect(lineSettingsSchema.safeParse({ ...base, airPattern: "manager_advanced" }).success).toBe(true);
    expect(lineSettingsSchema.safeParse({ ...base, tnbPattern: "manager_absorbed" }).success).toBe(false);
  });

  it("billSchema requires at least one row, each with an expectedUpdatedAt token", () => {
    expect(billSchema.safeParse({ period: "2026-07-01", rows: [] }).success).toBe(false);
    expect(billSchema.safeParse({ period: "2026-07-01", rows: [{ apartmentId: APT, expectedUpdatedAt: "2026-07-10T00:00:00.000Z" }] }).success).toBe(true);
  });

  it("createExpensesSchema takes billingMonth + optional tenancyId; partyId is server-derived and stripped", () => {
    const base = {
      apartmentId: APT, billingMonth: "2026-07-01", bearer: "tenant",
      items: [{ description: "Aircond service", amount: "150.00", withSST: true }],
    };
    expect(createExpensesSchema.safeParse(base).success).toBe(true);
    expect(createExpensesSchema.safeParse({ ...base, tenancyId: TEN }).success).toBe(true);

    // A client cannot supply the party snapshot: the service derives it from the
    // org-scoped Tenancy (A1). An unknown key is stripped, never honoured.
    const spoof = createExpensesSchema.safeParse({ ...base, partyId: PTY });
    expect(spoof.success).toBe(true);
    if (spoof.success) expect("partyId" in spoof.data).toBe(false);

    // The spec's field is `billingMonth`; the parent entry's `periodMonth` is not a wire field here.
    expect(createExpensesSchema.safeParse({ ...base, billingMonth: undefined, periodMonth: "2026-07-01" }).success).toBe(false);
    expect(createExpensesSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });

  // Task B2 — per-row Expense/Profit `nature`, threaded onto each item (mirrors
  // chargeCategoryId's per-item, optional shape). Omitted ⇒ backward-compatible
  // NULL (Task B1: routes as Expense). Not flag-gated at the schema layer — see
  // service.ts's createExpensesService doc-comment for why.
  it("createExpensesSchema: items accept an optional nature ('expense'|'profit'); omitted or invalid is handled", () => {
    const base = { apartmentId: APT, billingMonth: "2026-07-01", bearer: "tenant" as const };
    const withNature = (nature?: string) =>
      createExpensesSchema.safeParse({ ...base, items: [{ description: "Aircond service", amount: "150.00", withSST: true, ...(nature !== undefined ? { nature } : {}) }] });

    expect(withNature("profit").success).toBe(true);
    expect(withNature("expense").success).toBe(true);
    expect(withNature(undefined).success).toBe(true); // omitted is valid — no fail-closed at this layer
    expect(withNature("bogus").success).toBe(false); // not one of the two enum values

    const parsed = withNature("profit");
    if (parsed.success) expect(parsed.data.items[0].nature).toBe("profit");
  });

  it("gridQuerySchema: months defaults to 1, coerces, and is bounded 1..12", () => {
    const r = gridQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.months).toBe(1);
    const c = gridQuerySchema.safeParse({ months: "3" }); // querystring → coerced
    expect(c.success).toBe(true);
    if (c.success) expect(c.data.months).toBe(3);
    expect(gridQuerySchema.safeParse({ months: 0 }).success).toBe(false);
    expect(gridQuerySchema.safeParse({ months: 13 }).success).toBe(false);
    expect(gridQuerySchema.safeParse({ propertyId: "not-a-uuid" }).success).toBe(false);
  });

  it("bearerConfigSchema: line settings + recurring amount; unlock defaults false", () => {
    const base = {
      tnbPattern: "recharged", airPattern: "absorbed",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "100.00",
    };
    const r = bearerConfigSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unlock).toBe(false);
    // cleaningRecurringAmount is required and money-shaped.
    expect(bearerConfigSchema.safeParse({ ...base, cleaningRecurringAmount: undefined }).success).toBe(false);
    expect(bearerConfigSchema.safeParse({ ...base, cleaningRecurringAmount: "10.001" }).success).toBe(false);
  });

  // Task 4: bearerConfigSchema = lineSettingsSchema.extend({...}) and maps to the
  // SIBLING UnitBillsBearerConfig table (same tnbPattern/airPattern columns as
  // UnitBillsGridEntry) — confirm it inherits the widened enum via .extend()
  // rather than shadowing tnbPattern/airPattern with a stale copy.
  it("[pin] bearerConfigSchema (UnitBillsBearerConfig) also accepts manager_advanced, inherited via lineSettingsSchema.extend()", () => {
    const base = {
      tnbPattern: "manager_advanced", airPattern: "manager_advanced",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
      cleaningRecurringAmount: "100.00",
    };
    expect(bearerConfigSchema.safeParse(base).success).toBe(true);
  });

  it("updateExpenseSchema: partial + amount-shaped; carries no bearer (void+recreate to re-file)", () => {
    expect(updateExpenseSchema.safeParse({}).success).toBe(true); // all fields optional
    expect(updateExpenseSchema.safeParse({ description: "x", amount: "10.00", withSST: false }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({ description: "" }).success).toBe(false); // min(1)
    expect(updateExpenseSchema.safeParse({ amount: "10.001" }).success).toBe(false);
    // `bearer` is deliberately not a field — a supplied bearer key is stripped, never honoured.
    const b = updateExpenseSchema.safeParse({ bearer: "owner" });
    expect(b.success).toBe(true);
    if (b.success) expect("bearer" in b.data).toBe(false);
  });

  // Task B2 — same optional nature on the (single-expense) update body.
  it("updateExpenseSchema: accepts an optional nature ('expense'|'profit'); rejects an invalid value", () => {
    expect(updateExpenseSchema.safeParse({ nature: "profit" }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({ nature: "expense" }).success).toBe(true);
    expect(updateExpenseSchema.safeParse({}).success).toBe(true); // still all-optional
    expect(updateExpenseSchema.safeParse({ nature: "bogus" }).success).toBe(false);

    const parsed = updateExpenseSchema.safeParse({ description: "x", nature: "profit" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.nature).toBe("profit");
  });

  it("saveReadingsSchema: >=1 reading, listingId NOT NULL, nullable snapshot/kwh", () => {
    const reading = { listingId: APT, tenancyId: null, partyId: null, previousKwh: null, currentKwh: null };
    expect(saveReadingsSchema.safeParse({ period: "2026-07-01", readings: [reading] }).success).toBe(true);
    // occupied room with values
    expect(saveReadingsSchema.safeParse({
      period: "2026-07-01",
      readings: [{ listingId: APT, tenancyId: TEN, partyId: PTY, previousKwh: "100.00", currentKwh: "150.00" }],
    }).success).toBe(true);
    expect(saveReadingsSchema.safeParse({ period: "2026-07-01", readings: [] }).success).toBe(false); // min(1)
    // listingId is the NOT-NULL upsert key (the room = Listing.id).
    expect(saveReadingsSchema.safeParse({ period: "2026-07-01", readings: [{ ...reading, listingId: null }] }).success).toBe(false);
    const { listingId: _omit, ...noListing } = reading;
    expect(saveReadingsSchema.safeParse({ period: "2026-07-01", readings: [noListing] }).success).toBe(false);
  });

  // Task 3: `amount` is SERVER-DERIVED (kWh x rate) — a wire-supplied amount must
  // NEVER be honoured. Mirrors the createExpensesSchema partyId-strip test above.
  it("saveReadingsSchema: amount is not a wire field — a spoofed amount is stripped, never honoured", () => {
    const reading = { listingId: APT, tenancyId: null, partyId: null, previousKwh: "100.00", currentKwh: "250.00" };
    const spoof = saveReadingsSchema.safeParse({ period: "2026-07-01", readings: [{ ...reading, amount: "9999.00" }] });
    expect(spoof.success).toBe(true);
    if (!spoof.success) return;
    expect("amount" in spoof.data.readings[0]).toBe(false);
  });
});
