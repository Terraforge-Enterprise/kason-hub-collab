/**
 * Bills-grid service layer — the money core (Task 5).
 *
 * Integration suite (RUN_INTEGRATION=1) against the real local Postgres, using the
 * meter/repository harness convention (getDb + RUN_INTEGRATION gate + non-local host
 * guard) rather than a bare `new PrismaClient()`: under Prisma 7 the datasource has
 * no `url`, so the client is only constructible through @kason/db's PrismaPg adapter.
 * (The brief's excerpt showed `new PrismaClient()` + a DATABASE_URL-only gate; that
 * would throw here — see the task report's deviation note.)
 *
 * DB column note: `GridExpense`/`GridMeterReading`/`GridAttachment` store the month in
 * a column named `periodMonth` (verified against the generated client AND the live DB).
 * `billingMonth` survives ONLY as the WIRE field name on `createExpensesSchema`.
 *
 * Run:
 *   cd apps/api && DATABASE_URL=<local> RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/bills-grid/__tests__/service.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import { billService, createExpensesService, getGridService, saveEntryService, saveReadingsService, voidExpenseService } from "../service";
import { cleanupGridFixtures } from "./cleanup";

const prisma = getDb();

/**
 * Task 5's query-spy case. Mirrors batch-loaders.integration.test.ts's own
 * `spyCallthrough` helper verbatim (see that file's doc comment for the two
 * empirically-verified Prisma-spy gotchas this works around: `vi.spyOn` alone
 * does not call through, and `spy.mockRestore()` corrupts the property for
 * later tests — restore by hand instead).
 */
function spyCallthrough<T extends object, K extends keyof T>(target: T, method: K) {
  const original = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
  const spy = vi.spyOn(target, method as never).mockImplementation(original as never);
  const restore = () => {
    (target as unknown as Record<string, unknown>)[method as string] = original;
  };
  return { spy, restore };
}

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixtures. Every identifier used below is bound here; nothing is implicit. ──
// ACTOR is resolved to a REAL User.id in beforeAll: `AuditLog.actorUserId` has an
// FK (`AuditLog.actor … onDelete: Restrict`), so recordAudit — which every write
// service calls inside its transaction — would violate it (and roll the whole tx
// back) if ACTOR were a synthetic UUID. (The brief's excerpt used a fixed UUID and
// called it "no FK"; the grid's own createdBy/lockedBy/uploadedBy are indeed FK-free,
// but AuditLog.actorUserId is not. See the task report's fixture note.)
let ACTOR = "";
const PERIOD_STR = "2026-07-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
let ORG = "";
let APT = "";   // absorbed, no readings → the C3 baseline
let APT_X = ""; // absorbed, tnbTotalRaw = null → save_failed
let APT_Y = ""; // the STALE subject (mutated while UNBILLED), THEN billed by ABSORBED — STALE must run first
let APT_G = ""; // absorbed WITH aircond → the A4 gross-vs-net pin
let APT_Z = ""; // a reading whose tenancy has pax 0 → ZERO_PAX_TENANCY
let APT_E = ""; // expenses: tenancyId → partyId resolution + the cross-org 404
let APT_R = ""; // WHOLE_UNIT_MULTI_READING subject (carries a rental)
let APT_P = ""; // poisoned on the READ path → previewError
let APT_RD = ""; // the per-listing reading race + two-vacant-rooms (NO rental — Invariant 9 must not fire)
// ── Fix-pass (findings 1 & 2) dedicated apartments — pristine (indices ≥20, never
// touched by the cases above). ──
let APT_VOID_OK = "";     // happy void on an UNBILLED entry (regression guard)
let APT_VOID_LOCKED = ""; // void of a billed-month expense → 409 ENTRY_LOCKED (finding 1)
let APT_XORG = "";        // reading with a cross-org tenancyId → 404 (finding 2, write path)
let APT_SPOOF = "";       // reading with a spoofed wire partyId → server-derived (finding 2, write path)
let APT_FOREIGN_READ = ""; // injected foreign-party reading → read path must not echo it (finding 2, read path)
// Task 3 (server-derived amount) — dedicated, pristine apartments.
let APT_AMT = "";     // spoof-ignored + carry-forward + negative-clamp + first-month-no-prior cases
let APT_AMT_RATE = ""; // rate-snapshot case (own apartment so its AircondMeter mutation cannot bleed into APT_AMT)
let FIX_APTS: string[] = []; // the five above, for teardown
let ELEVEN: string[] = [];

// Real Listing ids (= the rooms). GridMeterReading.listingId is these (Foundation
// CORRECTION 2). A pool of distinct room ids the reading cases draw from.
let LISTINGS: string[] = [];

// The cross-org tenancy: a real row in a DIFFERENT organization.
let OTHER_ORG = "";
let OTHER_TENANCY = "";
let OTHER_PARTY = "";   // the foreign org's Party — its displayName must NEVER leak into this org's read path
let SAME_ORG_TENANCY = "";
let SAME_ORG_PARTY = "";

const session = (role: "editor" | "manager" | "admin") => ({ orgId: ORG, userId: ACTOR, role });
const KEY = () => ({ organizationId: ORG, apartmentId: APT, periodMonth: PERIOD });
const keyOf = (apartmentId: string) => ({ organizationId: ORG, apartmentId, periodMonth: PERIOD });

/** Refresh each row's optimistic-concurrency token straight from the DB. */
async function rowsFor(apartmentIds: string[]) {
  const entries = await prisma.unitBillsGridEntry.findMany({
    where: { organizationId: ORG, periodMonth: PERIOD, apartmentId: { in: apartmentIds } },
  });
  return entries.map((e) => ({ apartmentId: e.apartmentId, expectedUpdatedAt: e.updatedAt.toISOString() }));
}

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  // A real User in this org — AuditLog.actorUserId FKs User (onDelete: Restrict).
  ACTOR = (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG } })).id;

  // The clean dev seed creates 20 distinct apartments (verified: 20 distinct
  // `apartmentId`s in packages/db/prisma/seed.ts's `unitDefs`, deduped into
  // `apartmentsData`). This suite claims all 20, each dedicated to ONE case,
  // because several cases bill their subject and later cases must start unbilled.
  const apts = await prisma.apartment.findMany({ where: { organizationId: ORG }, take: 20, orderBy: { unitCode: "asc" } });
  if (apts.length < 20) throw new Error(`need ≥20 apartments in the local seed, found ${apts.length}`);
  [APT, APT_X, APT_Y, APT_G, APT_Z, APT_E, APT_R, APT_P] = apts.slice(0, 8).map((a) => a.id);
  APT_RD = apts[19].id; // the rental-free readings subject
  // Invariant 9 is now keyed on Apartment.listingMode (Task 4), not `entry.rental`.
  // APT_RD's own tests save readings for MULTIPLE distinct listingIds in one
  // apartment and must NOT trip WHOLE_UNIT_MULTI_READING, so it is flipped to
  // PARTITIONED here (seed apartments default to WHOLE — see seed.ts unitDefs).
  await prisma.apartment.update({ where: { id: APT_RD }, data: { listingMode: "PARTITIONED" } });
  // ELEVEN must NOT overlap the dedicated apartments above: `non-atomic` asserts
  // exactly 10 `billed`, and an already-billed subject would return `already_billed`.
  ELEVEN = apts.slice(8, 19).map((a) => a.id);

  // Fix-pass apartments — CREATED here, not drawn from the seed. The clean dev seed
  // guarantees exactly 20 apartments (all claimed above), so these five must be minted
  // to stay robust against a fresh `db push --force-reset && seed`. Torn down in
  // afterAll AFTER cleanupGridFixtures (UnitBillsGridEntry.apartment is onDelete:Restrict).
  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  const mkApt = async (tag: string, listingMode: "WHOLE" | "PARTITIONED" = "WHOLE") =>
    (await prisma.apartment.create({
      data: { organizationId: ORG, propertyId: prop.id, unitCode: `FIX-${tag}-${Date.now()}`, listingMode },
    })).id;
  APT_VOID_OK = await mkApt("VOK");
  APT_VOID_LOCKED = await mkApt("VLK");
  APT_XORG = await mkApt("XORG");
  APT_SPOOF = await mkApt("SPOOF");
  APT_FOREIGN_READ = await mkApt("FRD");
  // APT_AMT's F2 test (Task 3) saves TWO distinct listingIds in one request —
  // a PARTITIONED scenario; give it PARTITIONED so Invariant 9 (Task 4) does
  // not collide with the pre-existing amount-derivation coverage.
  APT_AMT = await mkApt("AMT", "PARTITIONED");
  APT_AMT_RATE = await mkApt("AMTRATE");
  FIX_APTS = [APT_VOID_OK, APT_VOID_LOCKED, APT_XORG, APT_SPOOF, APT_FOREIGN_READ, APT_AMT, APT_AMT_RATE];

  // A pool of ≥5 distinct room ids. GridMeterReading.listingId is a Listing.id
  // (mirrors MeterReading.unitId). The seed creates one Listing per WHOLE unit,
  // so ≥5 apartments already give ≥5 rooms; the reading cases pick distinct ones.
  // Task 3 (server-derived amount) claims indices 5-16 for its own dedicated rooms.
  const listingRows = await prisma.listing.findMany({ where: { organizationId: ORG }, take: 17, orderBy: { id: "asc" } });
  if (listingRows.length < 17) throw new Error(`need ≥17 listings in the local seed, found ${listingRows.length}`);
  LISTINGS = listingRows.map((l) => l.id);

  const t = await prisma.tenancy.findFirstOrThrow({ where: { organizationId: ORG } });
  SAME_ORG_TENANCY = t.id;
  SAME_ORG_PARTY = t.tenantPartyId; // Tenancy's party column is `tenantPartyId`, not `partyId`

  // A tenancy in ANOTHER org. Tenancy.unitId FKs Listing (not Apartment) and
  // Tenancy.propertyId FKs Property, so both may be reused cross-org: the FKs
  // carry no organization predicate. That is precisely the hole the service closes.
  const other = await prisma.organization.create({
    data: { name: "Other Org", slug: `other-${Date.now()}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  OTHER_ORG = other.id;
  const otherParty = await prisma.party.create({
    data: { organizationId: OTHER_ORG, partyType: "individual", displayName: "Other Tenant", status: "active" },
  });
  OTHER_PARTY = otherParty.id;
  const otherTenancy = await prisma.tenancy.create({
    data: {
      organizationId: OTHER_ORG, propertyId: t.propertyId, unitId: t.unitId, tenantPartyId: otherParty.id,
      tenancyCode: `OTH-${Date.now()}`, status: "active", billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000.00",
    },
  });
  OTHER_TENANCY = otherTenancy.id;

  await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, periodMonth: PERIOD } });
});

afterAll(async () => {
  if (!RUN) return;
  // Children → entry → config, THEN anything that owns an apartment. The entry's
  // .apartment FK is onDelete: Restrict (schema.prisma:2735 precedent).
  await cleanupGridFixtures(prisma, ORG, { apartmentIds: [APT, APT_X, APT_Y, APT_G, APT_Z, APT_E].filter(Boolean) });
  // The five fix-pass apartments were CREATED by this suite — delete them AFTER
  // cleanupGridFixtures cleared the entries that Restrict them.
  if (FIX_APTS.length) await prisma.apartment.deleteMany({ where: { id: { in: FIX_APTS } } });
  // Grid-specific append-only audit residue from this run (grid entity types are
  // written ONLY by this flag-dark feature, so in the local DB they are all ours).
  await prisma.auditLog.deleteMany({
    where: { organizationId: ORG, entityType: { in: ["UnitBillsGridEntry", "GridExpense", "GridAttachment", "UnitBillsBearerConfig"] } },
  });
  await prisma.tenancy.delete({ where: { id: OTHER_TENANCY } });
  await prisma.organization.delete({ where: { id: OTHER_ORG } }); // Cascades the Party
  await prisma.tenancy.update({ where: { id: SAME_ORG_TENANCY }, data: { numberOfPax: null } });
});

// Task 4: these cases pin the LEGACY (flag-off) Bill contract — owner-borne
// recording, GROSS semantics, per-row batch isolation, ENTRY_LOCKED — which Task 4
// guarantees byte-for-byte unchanged. The NEW flag-on issuance (IVTEN/IVOWN) has
// its own suite (bill-issuance.integration.test.ts). The dev `.env` sets
// ENABLE_PHASE2_BILLING_DOCS=true, so without this pin these legacy assertions
// would exercise the issuance path against seed apartments that carry no owner /
// active tenancy and land in `save_failed` — noise unrelated to what they test.
let __billFlagPrev: string | undefined;
d("bills-grid Bill", () => {
  beforeAll(() => { __billFlagPrev = process.env.ENABLE_PHASE2_BILLING_DOCS; delete process.env.ENABLE_PHASE2_BILLING_DOCS; });
  afterAll(() => { if (__billFlagPrev !== undefined) process.env.ENABLE_PHASE2_BILLING_DOCS = __billFlagPrev; });
  it("C3 ownerBorne from raw: an absorbed row records 590, not ComputeResult's 180", async () => {
    await saveEntryService(session("editor"), APT, { period: PERIOD_STR, tnbTotal: "590.00", airSelangor: "40.00" });
    // Pattern is snapshotted on create, so flip it via the dedicated path, not Save.
    await prisma.unitBillsGridEntry.update({ where: { organizationId_apartmentId_periodMonth: KEY() }, data: { tnbPattern: "absorbed", airPattern: "absorbed" } });

    const r = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor([APT]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("billed");

    const e1 = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: KEY() } });
    expect(String(e1.ownerBorneTnb)).toBe("590");  // RAW, not ComputeResult.ownerBorneUtilitiesTotal (=180)
    expect(String(e1.ownerBorneAir)).toBe("40");
    expect(e1.billedAt).not.toBeNull();
    expect(e1.lockedBy).not.toBeNull();
    expect(e1.paymentStatus).toBe("unpaid"); // billing != payment

    // The audit row is written INSIDE the Bill transaction (API-contract §).
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: ORG, entityType: "UnitBillsGridEntry", entityId: e1.id, action: "grid.entry.bill" } });
    expect(audit).not.toBeNull();
  });

  // ── A4: the gross-vs-net semantic of ownerBorneTnb, pinned. ──────────────────
  it("ownerBorneTnb is GROSS: an absorbed month with aircond 100 records rawTnbTotal 590, never 490", async () => {
    await saveEntryService(session("editor"), APT_G, { period: PERIOD_STR, tnbTotal: "590.00", airSelangor: "40.00" });
    const e0 = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_G) } });
    await prisma.unitBillsGridEntry.update({ where: { id: e0.id }, data: { tnbPattern: "absorbed", airPattern: "absorbed" } });
    await prisma.gridMeterReading.create({
      data: { organizationId: ORG, entryId: e0.id, apartmentId: APT_G, periodMonth: PERIOD, listingId: LISTINGS[0], tenancyId: null, partyId: null, amount: "100.00", createdBy: ACTOR },
    });

    const r = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor([APT_G]) });
    if (!r.ok) throw new Error("expected 200");
    expect(r.data.results[0].outcome).toBe("billed");

    const e1 = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { id: e0.id } });
    expect(String(e1.ownerBorneTnb)).toBe("590");        // GROSS — the bill the owner actually paid
    expect(String(e1.ownerBorneTnb)).not.toBe("490");    // NOT raw − totalAircond
    expect(String(e1.ownerBorneAir)).toBe("40");
  });

  // ⚠️ REQUIRED ORDERING: STALE must run BEFORE ABSORBED. Both mutate APT_Y, and
  // ABSORBED BILLS it. saveEntryService checks `billedAt` (→ ENTRY_LOCKED) BEFORE the
  // optimistic-concurrency check (→ STALE), so once APT_Y is billed a Save can only
  // ever return ENTRY_LOCKED — STALE would be unreachable.
  it("STALE: a Save with a superseded expectedUpdatedAt is refused without clobbering", async () => {
    // APT_Y is still UNBILLED here (ABSORBED, which bills it, runs after this).
    // `cleaning` (not `rental` — dropped from the wire, Task 4) is the distinguishing
    // amounts-only field proving which write won / lost.
    await saveEntryService(session("editor"), APT_Y, { period: PERIOD_STR, cleaning: "100.00" });
    const stale = await prisma.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT_Y, periodMonth: PERIOD } });
    await saveEntryService(session("editor"), APT_Y, { period: PERIOD_STR, cleaning: "200.00" }); // moves updatedAt
    const r = await saveEntryService(session("editor"), APT_Y, { period: PERIOD_STR, cleaning: "300.00", expectedUpdatedAt: stale.updatedAt.toISOString() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toBe("STALE");
    const after = await prisma.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT_Y, periodMonth: PERIOD } });
    expect(String(after.cleaning)).toBe("200"); // the loser did NOT clobber
  });

  it("ABSORBED_REQUIRES_OWNER_BORNE isolates to one row and never aborts the batch", async () => {
    // Runs AFTER STALE (which left APT_Y unbilled with cleaning=200). This is an
    // amounts-only merge (no cleaning in the body), so cleaning stays 200; then it bills APT_Y.
    // APT_X: absorbed with tnbTotalRaw = null → save_failed
    await saveEntryService(session("editor"), APT_X, { period: PERIOD_STR });
    await prisma.unitBillsGridEntry.update({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_X) }, data: { tnbPattern: "absorbed" } });
    // APT_Y: recharged with real amounts → billed
    await saveEntryService(session("editor"), APT_Y, { period: PERIOD_STR, tnbTotal: "300.00", airSelangor: "20.00" });

    const r = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor([APT_X, APT_Y]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const x = r.data.results.find((v) => v.apartmentId === APT_X)!;
    expect(x.outcome).toBe("save_failed");
    expect(x.code).toBe("ABSORBED_REQUIRES_OWNER_BORNE"); // the stable code survives the catch
    expect(r.data.results.find((v) => v.apartmentId === APT_Y)!.outcome).toBe("billed");
  });

  it("non-atomic: 10 billed + 1 compute_error; re-run yields already_billed", async () => {
    for (const id of ELEVEN) await saveEntryService(session("editor"), id, { period: PERIOD_STR, tnbTotal: "500.00", airSelangor: "20.00" });
    // Row #4 is poisoned: a recharged line whose aircond exceeds TNB ⇒ compute throws.
    const poisoned = ELEVEN[3];
    const e = await prisma.unitBillsGridEntry.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: poisoned, periodMonth: PERIOD } });
    await prisma.gridMeterReading.create({
      data: { organizationId: ORG, entryId: e.id, apartmentId: poisoned, periodMonth: PERIOD, listingId: LISTINGS[0], tenancyId: null, partyId: null, amount: "600.00", createdBy: ACTOR },
    });

    const first = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor(ELEVEN) });
    if (!first.ok) throw new Error("expected 200");
    expect(first.data.results.filter((v) => v.outcome === "billed")).toHaveLength(10);
    const failed = first.data.results.filter((v) => v.outcome === "compute_error");
    expect(failed).toHaveLength(1);
    expect(failed[0].code).toBe("AIRCON_EXCEEDS_TNB");

    const second = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor(ELEVEN) });
    if (!second.ok) throw new Error("expected 200");
    expect(second.data.results.filter((v) => v.outcome === "already_billed")).toHaveLength(10);
  });

  // Client/server parity (bills-grid-page.tsx `billedApartmentIds`): the LOCKED set is
  // billed AND fully paid. A billed-but-UNPAID entry stays amendable so an admin can fix
  // figures before re-Billing; only a billed+PAID entry is refused (use the accounting
  // adjustment path). Save edits the DRAFT only — the money op (re-Bill) has its own
  // payment guard (`rebill_blocked_payment_exists`), so relaxing Save cannot move money.
  it("billed-but-UNPAID entry: saveEntry persists the amend; billed+PAID stays ENTRY_LOCKED", async () => {
    const before = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: KEY() } });
    expect(before.billedAt).not.toBeNull();
    expect(before.paymentStatus).toBe("unpaid"); // billing != payment (R10)
    const origCleaning = before.cleaning;

    // billed + unpaid ⇒ ACCEPTED and PERSISTED
    const amend = await saveEntryService(session("editor"), APT, { period: PERIOD_STR, cleaning: "12.34" });
    expect(amend.ok).toBe(true);
    const afterAmend = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: KEY() } });
    expect(String(afterAmend.cleaning)).toBe("12.34");

    // billed + fully PAID ⇒ refused
    await prisma.unitBillsGridEntry.update({ where: { organizationId_apartmentId_periodMonth: KEY() }, data: { paymentStatus: "paid" } });
    const locked = await saveEntryService(session("editor"), APT, { period: PERIOD_STR, cleaning: "99.99" });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.status).toBe(409);
    expect(locked.error).toBe("ENTRY_LOCKED");

    // restore APT (unpaid + original cleaning) for later cases
    await prisma.unitBillsGridEntry.update({ where: { organizationId_apartmentId_periodMonth: KEY() }, data: { paymentStatus: "unpaid", cleaning: origCleaning } });
  });

  it("billed-but-UNPAID entry: saveReadings amend allowed; billed+PAID refused", async () => {
    // APT is WHOLE + billed+unpaid — an admin corrects a kWh reading before re-Bill.
    const room = await prisma.listing.findFirstOrThrow({ where: { apartmentId: APT, organizationId: ORG } });
    const amend = await saveReadingsService(session("editor"), APT, {
      period: PERIOD_STR,
      readings: [{ listingId: room.id, tenancyId: null, partyId: null, previousKwh: null, currentKwh: "42.00" }],
    });
    expect(amend.ok).toBe(true);

    await prisma.unitBillsGridEntry.update({ where: { organizationId_apartmentId_periodMonth: KEY() }, data: { paymentStatus: "paid" } });
    const locked = await saveReadingsService(session("editor"), APT, {
      period: PERIOD_STR,
      readings: [{ listingId: room.id, tenancyId: null, partyId: null, previousKwh: null, currentKwh: "43.00" }],
    });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.status).toBe(409);
    expect(locked.error).toBe("ENTRY_LOCKED");

    // restore APT (unpaid) + drop the test reading so later cases see it clean
    await prisma.unitBillsGridEntry.update({ where: { organizationId_apartmentId_periodMonth: KEY() }, data: { paymentStatus: "unpaid" } });
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: KEY() } });
    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id } });
  });

  it("WHOLE_UNIT_MULTI_READING (listingMode): a WHOLE apartment with 1 saved reading rejects a 2nd distinct listingId", async () => {
    // Invariant 9 is now keyed on Apartment.listingMode (Task 4), not `entry.rental`.
    // APT_R is a seed apartment, listingMode WHOLE (seed.ts unitDefs default). This
    // runs BEFORE the rental-ignored test below so entry.rental is still null here —
    // isolating the NEW listingMode guard from the (about to be deleted) old one.
    const first = await saveReadingsService(session("editor"), APT_R, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[1], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "10.00" }],
    });
    expect(first.ok).toBe(true);

    const r = await saveReadingsService(session("editor"), APT_R, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[2], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "20.00" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("WHOLE_UNIT_MULTI_READING");

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_R) } });
    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id } }); // leave APT_R clean for other cases
  });

  it("rental is ignored by saveEntryService: entry.rental stays unchanged after a save carrying rental (Task 4)", async () => {
    // `rental` is dropped from `saveEntrySchema` (Task 4) — the service signature
    // still accepts an untyped body (`[k: string]: unknown`), so this simulates a
    // stale/bypassing caller that still sends `rental` directly to the service,
    // proving the SERVICE itself never writes it, not just that Zod strips it.
    const before = await prisma.unitBillsGridEntry.findUnique({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_R) } });
    expect(before?.rental ?? null).toBeNull();

    const r = await saveEntryService(session("editor"), APT_R, { period: PERIOD_STR, rental: "3000.00", cleaning: "5.00" } as never);
    expect(r.ok).toBe(true);

    const after = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_R) } });
    expect(after.rental).toBeNull();           // rental was NEVER written, despite being on the wire body
    expect(String(after.cleaning)).toBe("5");  // sibling amounts-only fields still persist normally
  });

  it("P5: stamps updatedById on entry save", async () => {
    await saveEntryService(session("manager"), APT_R, { period: PERIOD_STR, cleaning: "10" });
    const entry = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_R) } });
    expect(entry.updatedById).toBe(ACTOR);
  });

  it("P5: stamps updatedById on reading save (create, upsert-update, and other-room isolation)", async () => {
    // APT_RD is PARTITIONED (flipped in beforeAll) — required here because this test
    // saves TWO distinct listingIds in one call, which would trip WHOLE_UNIT_MULTI_READING
    // on a WHOLE apartment (e.g. APT_R). Two rooms in one call → both created via the
    // `create` branch of the upsert.
    const created = await saveReadingsService(session("editor"), APT_RD, {
      period: PERIOD_STR,
      readings: [
        { listingId: LISTINGS[1], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "10.00" },
        { listingId: LISTINGS[2], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "5.00" },
      ],
    });
    expect(created.ok).toBe(true);

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_RD) } });
    const bothAfterCreate = await prisma.gridMeterReading.findMany({ where: { entryId: e.id, listingId: { in: [LISTINGS[1], LISTINGS[2]] } } });
    expect(bothAfterCreate.every((row) => row.updatedById === ACTOR)).toBe(true);

    // Re-save ONLY room LISTINGS[1] (the upsert.update branch) — LISTINGS[2] must be untouched.
    const updated = await saveReadingsService(session("editor"), APT_RD, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[1], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "20.00" }],
    });
    expect(updated.ok).toBe(true);

    const room1 = await prisma.gridMeterReading.findFirstOrThrow({ where: { entryId: e.id, listingId: LISTINGS[1] } });
    expect(room1.updatedById).toBe(ACTOR);
    expect(String(room1.currentKwh)).toBe("20"); // proves this IS the updated row, not a stale read

    const room2 = await prisma.gridMeterReading.findFirstOrThrow({ where: { entryId: e.id, listingId: LISTINGS[2] } });
    expect(room2.updatedById).toBe(ACTOR);       // set on its own earlier create, unchanged by room1's later update
    expect(String(room2.currentKwh)).toBe("5");  // untouched by the LISTINGS[1]-only save

    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id, listingId: { in: [LISTINGS[1], LISTINGS[2]] } } }); // leave APT_RD clean for its own describe block
  });
});

d("bills-grid readings — the listingId upsert (Foundation CORRECTION 2)", () => {
  // Task 3: `amount` is SERVER-DERIVED, not a wire field. `currentKwh` drives the
  // derivation instead; `previousKwh` omitted + no prior reading ⇒ previous 0 ⇒
  // amount = currentKwh * rate (first-month parity).
  const reading = (listingId: string, tenancyId: string | null, currentKwh: string) => ({
    listingId, tenancyId, partyId: null, previousKwh: null, currentKwh,
  });

  it("one reading per listing per entry: two racing writes for the SAME listingId yield exactly ONE row", async () => {
    // APT_RD is PARTITIONED (Task 4), so Invariant 9 never fires here — this
    // isolates the per-room uniqueness from the whole-unit listingMode rule.
    const body = { period: PERIOD_STR, readings: [reading(LISTINGS[3], null, "10.00")] };
    const call = () => saveReadingsService(session("editor"), APT_RD, body);
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_RD) } });
    const rows = await prisma.gridMeterReading.findMany({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[3] } });
    expect(rows).toHaveLength(1);                 // NOT two — @@unique([organizationId, entryId, listingId]) + P2002 backstop
    expect(rows[0].tenancyId).toBeNull();         // the real nullable snapshot survives
    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id } });
  });

  it("two vacant rooms yield two rows AND both amounts sum into totalAircond", async () => {
    // rate 1.0000 on both rooms so amount = currentKwh exactly (30 / 70) — keeps
    // this test's money assertions unchanged from before Task 3.
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[3], ratePerKwh: "1.0000", isActive: true } });
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[4], ratePerKwh: "1.0000", isActive: true } });
    const body = {
      period: PERIOD_STR,
      readings: [reading(LISTINGS[3], null, "30.00"), reading(LISTINGS[4], null, "70.00")],
    };
    const r = await saveReadingsService(session("editor"), APT_RD, body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toHaveLength(2);
    // Each vacant room's result is addressable by listingId (never by tenancyId — both are null).
    expect(new Set(r.data.results.map((x) => x.listingId))).toEqual(new Set([LISTINGS[3], LISTINGS[4]]));

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_RD) } });
    const rows = await prisma.gridMeterReading.findMany({ where: { organizationId: ORG, entryId: e.id } });
    expect(rows).toHaveLength(2);                 // TWO distinct rows — no collapse
    expect(rows.every((x) => x.tenancyId === null)).toBe(true);

    // MONEY-CORRECTNESS: drive the READ/preview path and prove totalAircond = 30 + 70.
    // Give the pool headroom (recharged tnbTotal 200 > 100) so the AIRCON_EXCEEDS_TNB
    // guard does not fire and a clean preview is produced.
    await saveEntryService(session("editor"), APT_RD, { period: PERIOD_STR, tnbTotal: "200.00" });
    const g = await getGridService(session("editor"), { period: PERIOD_STR, months: 1 });
    if (!g.ok) throw new Error("expected 200");
    const row = g.data.rows.find((x) => x.apartmentId === APT_RD)!;
    expect(row.previewError).toBeNull();
    expect(row.preview!.totalAircond).toBe(100);       // BOTH rooms' amounts summed — the listingId fix's payoff
    // Both keyed readings surface as sub-rows. subRows now ALSO always includes
    // the apartment's own real rooms (so tenants + meter cells show up-front,
    // before any reading is keyed), so assert on the two reading rooms by
    // listingId rather than the whole-array length.
    const readingSubs = row.subRows.filter((s) => s.listingId === LISTINGS[3] || s.listingId === LISTINGS[4]);
    expect(readingSubs).toHaveLength(2);               // one per keyed room

    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id } });
    await prisma.aircondMeter.deleteMany({ where: { organizationId: ORG, unitId: { in: [LISTINGS[3], LISTINGS[4]] } } });
  });

  it("PARTITIONED apartment: 3 distinct room readings all persist (no false WHOLE_UNIT_MULTI_READING)", async () => {
    // APT_RD is PARTITIONED (Task 4 fixture flip, beforeAll) — Invariant 9 is
    // unconstrained here regardless of how many distinct rooms are keyed.
    const body = {
      period: PERIOD_STR,
      readings: [
        reading(LISTINGS[3], null, "10.00"),
        reading(LISTINGS[4], null, "20.00"),
        reading(LISTINGS[0], null, "30.00"),
      ],
    };
    const r = await saveReadingsService(session("editor"), APT_RD, body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results).toHaveLength(3);

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_RD) } });
    const rows = await prisma.gridMeterReading.findMany({ where: { organizationId: ORG, entryId: e.id } });
    expect(rows).toHaveLength(3); // all three persisted — no WHOLE_UNIT_MULTI_READING rejection

    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id } });
  });
});

d("bills-grid expenses — tenancyId resolves server-side to partyId", () => {
  const items = [{ description: "Aircond service", amount: "150.00", withSST: true }];

  it("tenancyId resolves to partyId: the snapshot is server-derived from the org-scoped Tenancy", async () => {
    await prisma.tenancy.update({ where: { id: SAME_ORG_TENANCY }, data: { numberOfPax: 2 } });
    const r = await createExpensesService(session("editor"), {
      apartmentId: APT_E, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: SAME_ORG_TENANCY, items,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rows = await prisma.gridExpense.findMany({ where: { organizationId: ORG, apartmentId: APT_E, periodMonth: PERIOD } });
    expect(rows).toHaveLength(1);
    expect(rows[0].partyId).toBe(SAME_ORG_PARTY); // === tenancy.tenantPartyId
    expect(rows[0].partyId).not.toBeNull();       // D8 tenant-record reachability depends on this
  });

  it("cross-org tenancyId: 404 TENANCY_NOT_FOUND, and NOTHING is written", async () => {
    const beforeExpenses = await prisma.gridExpense.count({ where: { organizationId: ORG } });
    const beforeEntries = await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG } });

    const r = await createExpensesService(session("editor"), {
      apartmentId: APT_E, billingMonth: "2026-09-01", bearer: "tenant", tenancyId: OTHER_TENANCY, items,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);          // 404, NOT 403 — a 403 would leak that the tenancy exists
    expect(r.error).toBe("TENANCY_NOT_FOUND");

    // The tenancy is resolved BEFORE getOrCreateEntry, so no parent entry is created either.
    expect(await prisma.gridExpense.count({ where: { organizationId: ORG } })).toBe(beforeExpenses);
    expect(await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG } })).toBe(beforeEntries);
    expect(await prisma.gridExpense.count({ where: { organizationId: OTHER_ORG } })).toBe(0);
  });
});

d("bills-grid read path — per-apartment isolation and row warnings", () => {
  it("previewError: one poisoned apartment degrades alone; every other apartment still renders, HTTP 200", async () => {
    await saveEntryService(session("editor"), APT_P, { period: PERIOD_STR, tnbTotal: "500.00", airSelangor: "20.00" });
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_P) } });
    await prisma.gridMeterReading.create({
      data: { organizationId: ORG, entryId: e.id, apartmentId: APT_P, periodMonth: PERIOD, listingId: LISTINGS[0], tenancyId: null, partyId: null, amount: "600.00", createdBy: ACTOR },
    });

    const r = await getGridService(session("editor"), { period: PERIOD_STR, months: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200); // never a request-level error; there is no HTTP 422

    const bad = r.data.rows.find((x) => x.apartmentId === APT_P)!;
    expect(bad.preview).toBeNull();
    expect(bad.previewError?.code).toBe("AIRCON_EXCEEDS_TNB");
    // The reading's sub-row is keyed on listingId even when preview fails
    // (CORRECTION 2). subRows now ALSO always includes the apartment's own real
    // rooms, so locate the reading row by listingId instead of whole-array match.
    const readingSub = bad.subRows.find((s) => s.listingId === LISTINGS[0]);
    // Task 5: ratePerKwh/rateConfigured/rental now ride along on every sub-row —
    // LISTINGS[0] has no dedicated AircondMeter in this suite's shared pool, so
    // the lazy default applies; the room is vacant (tenancyId null) so rental is null.
    // P5 (fixture minimally updated): the sub-row now ALSO carries updatedAt +
    // lastEditedByName. This reading was injected with only `createdBy` (no
    // updatedById), so lastEditedByName is null; updatedAt is a real @updatedAt
    // stamp — assert its shape, not a volatile literal.
    expect(readingSub).toMatchObject({ listingId: LISTINGS[0], tenancyId: null, partyName: null, previousKwh: null, currentKwh: null, amount: "600", ratePerKwh: "0.6000", rateConfigured: false, rental: null, lastEditedByName: null });
    expect(typeof readingSub!.updatedAt).toBe("string");
    // Isolation: a healthy neighbour still previews.
    const good = r.data.rows.find((x) => x.apartmentId === APT_Y)!;
    expect(good.previewError).toBeNull();
  });

  it("ZERO_PAX_TENANCY: a dangling/zero-pax tenancy is surfaced as a row warning, not silently dropped", async () => {
    await prisma.tenancy.update({ where: { id: SAME_ORG_TENANCY }, data: { numberOfPax: 0 } });
    await saveEntryService(session("editor"), APT_Z, { period: PERIOD_STR, tnbTotal: "500.00", airSelangor: "20.00" });
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_Z) } });
    await prisma.gridMeterReading.create({
      data: { organizationId: ORG, entryId: e.id, apartmentId: APT_Z, periodMonth: PERIOD, listingId: LISTINGS[1], tenancyId: SAME_ORG_TENANCY, partyId: SAME_ORG_PARTY, amount: "50.00", createdBy: ACTOR },
    });

    const r = await getGridService(session("editor"), { period: PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === APT_Z)!;

    expect(row.warnings).toEqual([{ code: "ZERO_PAX_TENANCY", tenancyId: SAME_ORG_TENANCY }]);
    expect(row.previewError).toBeNull();               // a warning NEVER blanks the row
    expect(row.preview).not.toBeNull();
    expect(row.preview!.totalAircond).toBe(50);        // the aircond still counts (the AIRCON guard sees it)
    expect(row.preview!.allocations).toHaveLength(0);  // …but the room gets no allocation line
    expect(row.preview!.ownerAttributableAircond).toBe(0); // …and is not attributed to the owner either
  });

  it("the Bill path's money is unaffected by a zero-pax tenancy", async () => {
    // ownerBorne* comes from the RAW columns (C3) and computeAllocation's result is
    // DISCARDED by billService — it is called only so a genuine ComputeError surfaces
    // as that row's `compute_error`. So the warning has no money consequence.
    // Task 4: pins the LEGACY (flag-off) Bill contract — under flag-on APT_Z's
    // zero-pax active room is a partitioned `pax_blocked`, a separate concern
    // covered by the issuance suite. The owner-borne columns (what this test
    // asserts) are written identically on the flag-off path.
    const flagPrev = process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    try {
      const r = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor([APT_Z]) });
      if (!r.ok) throw new Error("expected 200");
      expect(r.data.results[0].outcome).toBe("billed");
      const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_Z) } });
      expect(e.ownerBorneTnb).toBeNull(); // "recharged", so nothing is owner-borne
      expect(e.ownerBorneAir).toBeNull();
    } finally {
      if (flagPrev !== undefined) process.env.ENABLE_PHASE2_BILLING_DOCS = flagPrev;
    }
  });
});

// ─────────────────────── Fix pass (findings 1 & 2) ──────────────────────────
// Adversarial-review defects:
//  (1) voidExpenseService was the ONE mutating expense path missing the terminal
//      Bill lock — an owner-borne expense on a BILLED month could be voided,
//      silently changing that month's recorded totals.
//  (2) the reading path trusted the wire: saveReadingsService persisted the wire
//      partyId verbatim and never org-scoped tenancyId; the read path echoed a
//      foreign party's displayName and folded a foreign tenancy's pax into preview.
d("bills-grid fix pass — terminal-lock on void + org-scoped reading identity", () => {
  const ownerItems = [{ description: "Roof repair (owner)", amount: "250.00", withSST: false }];
  // Task 3: `amount` is no longer a wire field — these identity-only tests never
  // asserted on it, so `currentKwh` stands in (unused by the assertions below).
  const reading = (listingId: string, tenancyId: string | null, partyId: string | null, currentKwh: string) => ({
    listingId, tenancyId, partyId, previousKwh: null, currentKwh,
  });

  it("void on an UNBILLED entry still succeeds → 200, status void (regression guard)", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT_VOID_OK, billingMonth: PERIOD_STR, bearer: "owner", items: ownerItems,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    const v = await voidExpenseService(session("manager"), expenseId);
    expect(v.ok).toBe(true);
    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.status).toBe("void");
  });

  it("void of an expense on a billed-but-UNPAID month SUCCEEDS — the lock is money, not Bill (2026-08-17)", async () => {
    // Give the entry real amounts, attach an owner-borne expense, then Bill the month.
    await saveEntryService(session("editor"), APT_VOID_LOCKED, { period: PERIOD_STR, tnbTotal: "500.00", airSelangor: "20.00" });
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT_VOID_LOCKED, billingMonth: PERIOD_STR, bearer: "owner", items: ownerItems,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    // Task 4: this test asserts the terminal Bill lock covers void — orthogonal to
    // issuance. Pin the flag off so the Bill records `billed` (the entry's billedAt,
    // which is what locks the void, is stamped identically on both paths); under the
    // dev `.env` flag-on, APT_VOID_LOCKED (a seed apartment with no owner assigned)
    // would `save_failed` on the owner-borne issuance, unrelated to the void-lock.
    const flagPrev = process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    let b;
    try {
      b = await billService(session("manager"), { period: PERIOD_STR, rows: await rowsFor([APT_VOID_LOCKED]) });
    } finally {
      if (flagPrev !== undefined) process.env.ENABLE_PHASE2_BILLING_DOCS = flagPrev;
    }
    if (!b.ok) throw new Error("expected 200");
    expect(b.data.results[0].outcome).toBe("billed");

    // This test previously pinned the OPPOSITE (409 ENTRY_LOCKED on any billed month). The
    // 2026-08-17 unlock replaced the `entry.billedAt` guard with entryHasActivePayment: an
    // expense line is inert draft data until Bill mints a charge from it, and Bill keeps its
    // own payment guard (rebill_blocked_payment_exists). Here the flag is off above, so the
    // Bill issued NO document and NO charge — nothing has been paid — and the void succeeds.
    // The blocked-once-PAID direction is pinned in bill-rebill.integration.test.ts, which
    // owns the document-backed paid fixture.
    const v = await voidExpenseService(session("manager"), expenseId);
    expect(v.ok).toBe(true);
    const voided = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(voided.status).toBe("void");
  });

  it("FINDING 2 (write) — a cross-org tenancyId on a reading → 404 TENANCY_NOT_FOUND, NOTHING written", async () => {
    const beforeReadings = await prisma.gridMeterReading.count({ where: { organizationId: ORG, apartmentId: APT_XORG } });
    const beforeEntries = await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT_XORG } });

    const r = await saveReadingsService(session("editor"), APT_XORG, {
      period: PERIOD_STR,
      readings: [reading(LISTINGS[0], OTHER_TENANCY, null, "10.00")], // OTHER_TENANCY belongs to OTHER_ORG
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);           // 404, NOT 403 — mirrors resolveExpenseParty
    expect(r.error).toBe("TENANCY_NOT_FOUND");

    // Validated BEFORE getOrCreateEntry: no reading AND no stray parent entry.
    expect(await prisma.gridMeterReading.count({ where: { organizationId: ORG, apartmentId: APT_XORG } })).toBe(beforeReadings);
    expect(await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT_XORG } })).toBe(beforeEntries);
  });

  it("FINDING 2 (write) — the stored partyId is server-derived from the org tenancy, never the wire partyId", async () => {
    await prisma.tenancy.update({ where: { id: SAME_ORG_TENANCY }, data: { numberOfPax: 2 } });
    const spoofed = randomUUID(); // a partyId the client made up — must be discarded
    expect(spoofed).not.toBe(SAME_ORG_PARTY);

    // tnb headroom first so the later preview is clean (aircond 12 < 200).
    await saveEntryService(session("editor"), APT_SPOOF, { period: PERIOD_STR, tnbTotal: "200.00" });
    const w = await saveReadingsService(session("editor"), APT_SPOOF, {
      period: PERIOD_STR,
      readings: [reading(LISTINGS[0], SAME_ORG_TENANCY, spoofed, "12.00")],
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_SPOOF) } });
    const rows = await prisma.gridMeterReading.findMany({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[0] } });
    expect(rows).toHaveLength(1);
    expect(rows[0].partyId).toBe(SAME_ORG_PARTY); // === tenancy.tenantPartyId, server-derived
    expect(rows[0].partyId).not.toBe(spoofed);    // the wire partyId was discarded
    expect(rows[0].tenancyId).toBe(SAME_ORG_TENANCY);

    // Read path echoes the REAL org party's displayName (resolved org-scoped), not the spoof.
    const realName = (await prisma.party.findUniqueOrThrow({ where: { id: SAME_ORG_PARTY } })).displayName;
    const g = await getGridService(session("editor"), { period: PERIOD_STR, months: 1 });
    if (!g.ok) throw new Error("expected 200");
    const sub = g.data.rows.find((x) => x.apartmentId === APT_SPOOF)!.subRows.find((s) => s.listingId === LISTINGS[0])!;
    expect(sub.partyName).toBe(realName);
  });

  it("FINDING 2 (read) — a foreign party's displayName is NOT echoed (org-scoped subRows, defence in depth)", async () => {
    // Inject a reading carrying a FOREIGN org's partyId DIRECTLY (bypassing the now
    // hardened write path), simulating legacy/tampered data. Uses its own pristine
    // apartment so the assertion fails ONLY on the read-path leak, nothing else.
    await saveEntryService(session("editor"), APT_FOREIGN_READ, { period: PERIOD_STR, tnbTotal: "100.00" });
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_FOREIGN_READ) } });
    await prisma.gridMeterReading.create({
      data: { organizationId: ORG, entryId: e.id, apartmentId: APT_FOREIGN_READ, periodMonth: PERIOD, listingId: LISTINGS[0], tenancyId: null, partyId: OTHER_PARTY, amount: "5.00", createdBy: ACTOR },
    });

    const g = await getGridService(session("editor"), { period: PERIOD_STR, months: 1 });
    if (!g.ok) throw new Error("expected 200");
    const sub = g.data.rows.find((x) => x.apartmentId === APT_FOREIGN_READ)!.subRows.find((s) => s.listingId === LISTINGS[0])!;
    expect(sub.partyName).toBeNull(); // the foreign party is not resolvable in this org
  });
});

// ─────────────────────── Task 3: server-derived per-room amount ───────────────────────
// The client can no longer set GridMeterReading.amount directly: the server derives it
// from meter readings x the room's AircondMeter rate, mirroring meter/service.ts's own
// previousReading resolution (explicit wire -> prior period's reading -> 0) and formula
// (round2(round2(current - previous) * rate)). Money core — see task-3-brief.md.
d("bills-grid readings — server-derived amount (Task 3)", () => {
  // Every test in this block seeds its own AircondMeter row(s) on a dedicated
  // LISTINGS[5..16] slice; none of the individual tests tear them down (only their
  // GridMeterReading/UnitBillsGridEntry residue, where relevant), so a suite-level
  // afterAll clears them — otherwise a re-run within the same DB hits AircondMeter's
  // `@@unique([organizationId, unitId])`.
  afterAll(async () => {
    if (!RUN) return;
    await prisma.aircondMeter.deleteMany({ where: { organizationId: ORG, unitId: { in: LISTINGS.slice(5, 17) } } });
  });

  it("B1: a spoofed wire amount is ignored — server derives round2(round2(current-previous)*rate)", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[5], ratePerKwh: "0.6000", isActive: true } });

    // `amount` is no longer part of `saveReadingsService`'s body type (the Zod wire
    // schema dropped it — see the schema-level strip test in bills-grid.test.ts).
    // This `as any` simulates a client/caller that still smuggles the field in
    // directly (bypassing the route's Zod parse), proving the SERVICE itself,
    // not just the schema, never reads a wire `amount` — belt and braces.
    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{
        listingId: LISTINGS[5], tenancyId: null, partyId: null,
        previousKwh: "100.00", currentKwh: "250.00", amount: "9999.00",
      } as unknown as { listingId: string; tenancyId: string | null; partyId: string | null; previousKwh: string | null; currentKwh: string | null }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[5] } });
    expect(row.amount?.toFixed(2)).toBe("90.00"); // (250-100)*0.6 = 90.00 — the spoofed 9999 is discarded
  });

  it("B2: previousKwh omitted carries forward the prior period's currentKwh, then derives off it", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[6], ratePerKwh: "0.6000", isActive: true } });

    // Seed a PRIOR period's reading via the real save path (this month's save loop
    // must find it via `periodMonth: { lt: periodMonth }`, most-recent-first).
    const priorPeriodStr = `${PERIOD.getUTCFullYear()}-${String(PERIOD.getUTCMonth()).padStart(2, "0")}-01`; // month - 1
    const seed = await saveReadingsService(session("editor"), APT_AMT, {
      period: priorPeriodStr,
      readings: [{ listingId: LISTINGS[6], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "250.00" }],
    });
    expect(seed.ok).toBe(true);

    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[6], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "320.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[6] } });
    expect(row.previousKwh?.toFixed(2)).toBe("250.00"); // carried forward from the prior period's currentKwh
    expect(row.amount?.toFixed(2)).toBe("42.00");       // round2((320-250)*0.6) = 42.00

    const priorEntry = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT_AMT, periodMonth: new Date(`${priorPeriodStr}T00:00:00.000Z`) } } });
    await prisma.gridMeterReading.deleteMany({ where: { entryId: priorEntry.id } });
    await prisma.unitBillsGridEntry.delete({ where: { id: priorEntry.id } });
  });

  it("B3: negative consumption (current < previous) clamps amount to 0.00, reading still saves (200)", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[7], ratePerKwh: "0.6000", isActive: true } });

    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[7], tenancyId: null, partyId: null, previousKwh: "300.00", currentKwh: "250.00" }],
    });
    expect(r.ok).toBe(true); // HTTP 200 — the reading still saves, no rejection
    if (!r.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[7] } });
    expect(row.previousKwh?.toFixed(2)).toBe("300.00"); // the wire value survives verbatim
    expect(row.currentKwh?.toFixed(2)).toBe("250.00");
    expect(row.amount?.toFixed(2)).toBe("0.00");        // clamped, not negative
  });

  it("B4: no prior reading at all (first month) → previousKwh persists 0.00, amount = current x rate", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[8], ratePerKwh: "0.6000", isActive: true } });

    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[8], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "120.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[8] } });
    expect(row.previousKwh?.toFixed(2)).toBe("0.00");   // meter first-month parity (spec R3): no prior => previous 0
    expect(row.amount?.toFixed(2)).toBe("72.00");        // round2(120*0.6) = 72.00
  });

  it("B5: rate snapshot — a later AircondMeter rate change does NOT re-price an already-saved reading", async () => {
    const meter = await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[9], ratePerKwh: "0.6000", isActive: true } });

    const r = await saveReadingsService(session("editor"), APT_AMT_RATE, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[9], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "100.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT_RATE) } });
    const before = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[9] } });
    expect(before.amount?.toFixed(2)).toBe("60.00"); // 100 * 0.6

    // The rate changes AFTER save.
    await prisma.aircondMeter.update({ where: { id: meter.id }, data: { ratePerKwh: "0.5500" } });

    // getGrid (the read path) must echo the STORED amount, never re-derive it.
    await saveEntryService(session("editor"), APT_AMT_RATE, { period: PERIOD_STR, tnbTotal: "200.00" });
    const g = await getGridService(session("editor"), { period: PERIOD_STR, months: 1 });
    if (!g.ok) throw new Error("expected 200");
    const sub = g.data.rows.find((x) => x.apartmentId === APT_AMT_RATE)!.subRows.find((s) => s.listingId === LISTINGS[9])!;
    expect(sub.amount).toBe("60"); // UNCHANGED — snapshot, not re-priced by the new 0.55 rate (Decimal#toString, no trailing zeros)

    const after = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[9] } });
    expect(after.amount?.toFixed(2)).toBe("60.00"); // the stored column itself is also unchanged
  });

  it("F2 (adversarial): two rooms with DIFFERENT rates in ONE save request each derive off their OWN rate", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[10], ratePerKwh: "0.5500", isActive: true } });
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[11], ratePerKwh: "0.7500", isActive: true } });

    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [
        { listingId: LISTINGS[10], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "100.00" },
        { listingId: LISTINGS[11], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "100.00" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const rowA = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[10] } });
    const rowB = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[11] } });
    expect(rowA.amount?.toFixed(2)).toBe("55.00"); // 100 * 0.55 — its OWN rate, not the other room's
    expect(rowB.amount?.toFixed(2)).toBe("75.00"); // 100 * 0.75
  });

  it("F3 (adversarial): a room with NO AircondMeter configured derives off the 0.6 lazy default", async () => {
    // LISTINGS[12] deliberately gets NO aircondMeter row.
    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[12], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "100.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[12] } });
    expect(row.amount?.toFixed(2)).toBe("60.00"); // 100 * 0.6 lazy default (resolveRoomRatesBatch: configured:false)
  });

  it("F4 (adversarial): re-saving an existing reading RE-DERIVES amount from the new wire values", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[13], ratePerKwh: "0.6000", isActive: true } });

    const first = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[13], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "250.00" }],
    });
    expect(first.ok).toBe(true);
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const before = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[13] } });
    expect(before.amount?.toFixed(2)).toBe("150.00"); // 250 * 0.6

    // Re-save the SAME (entry, listingId) — the @@unique upsert path — with new values.
    const second = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[13], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "320.00" }],
    });
    expect(second.ok).toBe(true);
    const after = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[13] } });
    expect(after.amount?.toFixed(2)).toBe("192.00"); // 320 * 0.6 — RE-derived, not the stale 150.00
    expect(after.id).toBe(before.id);                // same row, upserted in place
  });

  it("F5 (adversarial): zero consumption (current == previous) derives amount exactly 0.00, distinct from the negative-clamp path", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[14], ratePerKwh: "0.6000", isActive: true } });
    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[14], tenancyId: null, partyId: null, previousKwh: "100.00", currentKwh: "100.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[14] } });
    expect(row.amount?.toFixed(2)).toBe("0.00"); // round2(0 * 0.6) — zero consumption, not a clamp
  });

  it("F7 (adversarial): an explicit previousKwh \"0\" takes the WIRE value, not the prior reading's carry-forward", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[15], ratePerKwh: "0.6000", isActive: true } });

    // A prior period exists with currentKwh 250 — if the explicit "0.00" wire value
    // were wrongly treated as falsy/omitted, carry-forward would silently override it.
    const priorPeriodStr = `${PERIOD.getUTCFullYear()}-${String(PERIOD.getUTCMonth()).padStart(2, "0")}-01`;
    const seed = await saveReadingsService(session("editor"), APT_AMT, {
      period: priorPeriodStr,
      readings: [{ listingId: LISTINGS[15], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "250.00" }],
    });
    expect(seed.ok).toBe(true);

    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[15], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "120.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[15] } });
    expect(row.previousKwh?.toFixed(2)).toBe("0.00");  // the EXPLICIT wire "0.00", not the prior period's 250
    expect(row.amount?.toFixed(2)).toBe("72.00");       // round2((120-0)*0.6) = 72.00, not round2((120-250)*0.6) clamped

    const priorEntry = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT_AMT, periodMonth: new Date(`${priorPeriodStr}T00:00:00.000Z`) } } });
    await prisma.gridMeterReading.deleteMany({ where: { entryId: priorEntry.id } });
    await prisma.unitBillsGridEntry.delete({ where: { id: priorEntry.id } });
  });

  it("F8 (adversarial, Finding 1): a NULL-currentKwh prior period does not mask an earlier REAL reading — carry-forward skips the hole", async () => {
    await prisma.aircondMeter.create({ data: { organizationId: ORG, unitId: LISTINGS[16], ratePerKwh: "0.6000", isActive: true } });

    // Two months back: a REAL reading (currentKwh 200).
    const twoBackStr = `${PERIOD.getUTCFullYear()}-${String(PERIOD.getUTCMonth() - 1).padStart(2, "0")}-01`; // month - 2
    const real = await saveReadingsService(session("editor"), APT_AMT, {
      period: twoBackStr,
      readings: [{ listingId: LISTINGS[16], tenancyId: null, partyId: null, previousKwh: "0.00", currentKwh: "200.00" }],
    });
    expect(real.ok).toBe(true);

    // One month back: the room went UNREAD — currentKwh persists NULL (a hole).
    const oneBackStr = `${PERIOD.getUTCFullYear()}-${String(PERIOD.getUTCMonth()).padStart(2, "0")}-01`; // month - 1
    const hole = await saveReadingsService(session("editor"), APT_AMT, {
      period: oneBackStr,
      readings: [{ listingId: LISTINGS[16], tenancyId: null, partyId: null, previousKwh: null, currentKwh: null }],
    });
    expect(hole.ok).toBe(true);

    // This month: a fresh REAL reading, previousKwh omitted — must carry forward the
    // LAST REAL reading (200 from two months back), skipping the null-current hole.
    const r = await saveReadingsService(session("editor"), APT_AMT, {
      period: PERIOD_STR,
      readings: [{ listingId: LISTINGS[16], tenancyId: null, partyId: null, previousKwh: null, currentKwh: "300.00" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: keyOf(APT_AMT) } });
    const row = await prisma.gridMeterReading.findFirstOrThrow({ where: { organizationId: ORG, entryId: e.id, listingId: LISTINGS[16] } });
    expect(row.previousKwh?.toFixed(2)).toBe("200.00"); // carried from the REAL two-months-back reading, not the null hole (=> 0)
    expect(row.amount?.toFixed(2)).toBe("60.00");        // round2((300-200)*0.6) = 60.00, NOT round2(300*0.6) = 180.00 (the over-bill)

    const twoBackEntry = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT_AMT, periodMonth: new Date(`${twoBackStr}T00:00:00.000Z`) } } });
    const oneBackEntry = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT_AMT, periodMonth: new Date(`${oneBackStr}T00:00:00.000Z`) } } });
    await prisma.gridMeterReading.deleteMany({ where: { entryId: { in: [twoBackEntry.id, oneBackEntry.id] } } });
    await prisma.unitBillsGridEntry.deleteMany({ where: { id: { in: [twoBackEntry.id, oneBackEntry.id] } } });
  });
});

// ─────────────────────── Task 5: read-path derivation ───────────────────────
// subRows gain ratePerKwh/rateConfigured/rental (batch-derived from Task 2's
// loaders); GridRowDto gains isWholeUnit; GridEntryDto drops rental; RowWarning
// widens with NEGATIVE_CONSUMPTION. Dedicated fixtures (own apartments/listings/
// tenancies), mirroring batch-loaders.integration.test.ts's self-contained style
// rather than the shared 20-apartment pool — this suite needs EXACT AircondMeter/
// reservation state per room, which the shared pool cannot guarantee.
d("bills-grid Task 5 — read-path rate/rental derivation + isWholeUnit + NEGATIVE_CONSUMPTION", () => {
  const T5_PERIOD_STR = "2026-08-01"; // distinct from PERIOD (2026-07-01) — avoids any cross-suite entry collision
  const T5_PERIOD = new Date(`${T5_PERIOD_STR}T00:00:00.000Z`);

  let t5Org = "";
  let t5Property = "";
  let t5Party = "";
  let t5Actor = "";

  // B1/B8: one apartment, one occupied room (rate 0.5500, reservation rent 1800.00)
  // + one vacant room (no meter, no tenancy) — proves rental null for vacancy in
  // the SAME apartment as the happy-path occupied room.
  let aptOcc = "";
  let roomOccupied = "";
  let roomVacant = "";
  let tenancyOccupied = "";

  // B2: a room with NO AircondMeter row at all → lazy default + must create NOTHING.
  let aptNoMeter = "";
  let roomNoMeter = "";

  // B7: WHOLE vs PARTITIONED.
  let aptWhole = "";
  let aptPartitioned = "";

  // B6/B12/B14/B15: negative consumption + null-current guard + multi-room + ZERO_PAX_TENANCY coexistence.
  let aptNeg = "";
  let roomNegative = "";   // stored current < previous → NEGATIVE_CONSUMPTION
  let roomNotYetRead = ""; // currentKwh null → must NOT be misreported negative
  let roomHealthy = "";    // positive consumption, sibling room, unaffected
  let roomZeroPax = "";    // ALSO carries a zero-pax tenancy → both warnings must coexist
  let tenancyZeroPax = "";

  // B13: a RETIRED (isActive:false) AircondMeter must still report rateConfigured:true.
  let aptRetired = "";
  let roomRetired = "";

  // B5: 10 apartments (1 room each) for the query-spy bounded-count assertion.
  const spyApts: string[] = [];
  const spyListings: string[] = [];

  let t5Apts: string[] = []; // every apartment THIS block creates, for teardown

  const mkListing = async (apartmentId: string, tag: string) =>
    (
      await prisma.listing.create({
        data: { organizationId: t5Org, apartmentId, listingType: `t5-${tag}`, occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: t5Party },
      })
    ).id;

  const mkTenancy = async (unitId: string, monthlyRentAmount: string, reservationId?: string) =>
    (
      await prisma.tenancy.create({
        data: {
          organizationId: t5Org, propertyId: t5Property, unitId, tenantPartyId: t5Party,
          tenancyCode: `T5-${randomUUID()}`, status: "active", billingStatus: "current",
          startDate: new Date("2026-01-01T00:00:00.000Z"), endDate: null, monthlyRentAmount, reservationId: reservationId ?? null,
        },
      })
    ).id;

  const mkReservation = async (unitId: string, agreedMonthlyRent: string) =>
    (
      await prisma.unitReservation.create({
        data: {
          organizationId: t5Org, referenceCode: `T5-R-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          issuedByPartyId: t5Party, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          publicToken: `t5-${randomUUID()}`, propertyId: t5Property, unitId,
          proposedMoveIn: new Date("2026-01-01T00:00:00.000Z"),
          reservationDeposit: "0.00", documentationFee: "0.00", rentalDeposit: "0.00",
          utilityDeposit: "0.00", accessCardDeposit: "0.00", agreedMonthlyRent,
        },
      })
    ).id;

  beforeAll(async () => {
    if (!RUN) return;
    const org = await prisma.organization.findFirstOrThrow();
    t5Org = org.id;
    t5Property = (await prisma.property.findFirstOrThrow({ where: { organizationId: t5Org } })).id;
    t5Party = (
      await prisma.party.create({ data: { organizationId: t5Org, displayName: "Task5 Test Party", partyType: "individual", status: "active" } })
    ).id;
    t5Actor = (await prisma.user.findFirstOrThrow({ where: { organizationId: t5Org } })).id;

    const mkApt = async (tag: string, listingMode: "WHOLE" | "PARTITIONED" = "PARTITIONED") =>
      (await prisma.apartment.create({ data: { organizationId: t5Org, propertyId: t5Property, unitCode: `T5-${tag}-${Date.now()}`, listingMode } })).id;

    // ── B1/B8: occupied + vacant room in ONE apartment ──
    aptOcc = await mkApt("OCC");
    roomOccupied = await mkListing(aptOcc, "occ-room");
    roomVacant = await mkListing(aptOcc, "vac-room");
    await prisma.aircondMeter.create({ data: { organizationId: t5Org, unitId: roomOccupied, ratePerKwh: "0.5500", isActive: true } });
    const resvOcc = await mkReservation(roomOccupied, "1800.00");
    tenancyOccupied = await mkTenancy(roomOccupied, "999.00", resvOcc);

    // ── B2: no-meter room ──
    aptNoMeter = await mkApt("NOMETER");
    roomNoMeter = await mkListing(aptNoMeter, "nometer-room");

    // ── B7: WHOLE vs PARTITIONED ──
    aptWhole = await mkApt("WHOLE", "WHOLE");
    aptPartitioned = await mkApt("PART", "PARTITIONED");

    // ── B6/B12/B14/B15: negative + null-current + healthy sibling + zero-pax, all in ONE apartment ──
    aptNeg = await mkApt("NEG");
    roomNegative = await mkListing(aptNeg, "neg-room");
    roomNotYetRead = await mkListing(aptNeg, "unread-room");
    roomHealthy = await mkListing(aptNeg, "healthy-room");
    roomZeroPax = await mkListing(aptNeg, "zeropax-room");
    tenancyZeroPax = await mkTenancy(roomZeroPax, "1000.00");
    await prisma.tenancy.update({ where: { id: tenancyZeroPax }, data: { numberOfPax: 0 } });

    // ── B13: retired meter ──
    aptRetired = await mkApt("RETIRED");
    roomRetired = await mkListing(aptRetired, "retired-room");
    await prisma.aircondMeter.create({ data: { organizationId: t5Org, unitId: roomRetired, ratePerKwh: "0.5500", isActive: false } });

    // ── B5: 10 apartments, 1 room each, for the query-spy ──
    for (let i = 0; i < 10; i++) {
      const a = await mkApt(`SPY${i}`);
      spyApts.push(a);
      spyListings.push(await mkListing(a, `spy-room-${i}`));
    }

    t5Apts = [aptOcc, aptNoMeter, aptWhole, aptPartitioned, aptNeg, aptRetired, ...spyApts];
  });

  afterAll(async () => {
    if (!RUN) return;
    // Inner afterAll runs BEFORE the outer suite's afterAll (which calls
    // cleanupGridFixtures on the whole ORG) — so this block must clear its OWN
    // entries/readings/apartments itself; they are NOT guaranteed to be gone yet
    // when this runs.
    await prisma.gridMeterReading.deleteMany({ where: { organizationId: t5Org, apartmentId: { in: t5Apts } } });
    await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: t5Org, apartmentId: { in: t5Apts } } });
    await prisma.unitBillsBearerConfig.deleteMany({ where: { organizationId: t5Org, apartmentId: { in: t5Apts } } });
    await prisma.tenancy.deleteMany({ where: { id: { in: [tenancyOccupied, tenancyZeroPax] } } });
    await prisma.aircondMeter.deleteMany({ where: { organizationId: t5Org, unitId: { in: [roomOccupied, roomRetired] } } });
    // UnitReservation.unitId carries a raw-SQL FK to Listing (not declared in
    // schema.prisma as a Prisma @relation, but enforced at the DB level) — must
    // be cleared BEFORE apartment.deleteMany cascades the Listings, or the
    // apartment delete 500s on UnitReservation_unitId_fkey.
    await prisma.unitReservation.deleteMany({ where: { organizationId: t5Org } });
    await prisma.apartment.deleteMany({ where: { id: { in: t5Apts } } }); // cascades Listings
    await prisma.party.delete({ where: { id: t5Party } });
  });

  it("B1: an occupied room (reservation rent 1800, rate 0.55) derives rental='1800.00', ratePerKwh='0.5500', rateConfigured=true", async () => {
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptOcc)!;
    const sub = row.subRows.find((s) => s.listingId === roomOccupied)!;
    expect(sub.rental).toBe("1800.00");
    expect(sub.ratePerKwh).toBe("0.5500");
    expect(sub.rateConfigured).toBe(true);
  });

  it("B8: a vacant room in the SAME apartment has rental null (no active tenancy to resolve rent for)", async () => {
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptOcc)!;
    const sub = row.subRows.find((s) => s.listingId === roomVacant)!;
    expect(sub.rental).toBeNull();
    expect(sub.tenancyId).toBeNull();
  });

  // PAX-per-room drive: the real DB → Prisma select (numberOfPax: true) → rooms-map
  // (active?.numberOfPax) → SubRowDto path. An occupied room surfaces its active tenancy's
  // numberOfPax; a vacant room is null. This is the path the toGridRowDto unit test cannot
  // reach (it feeds rooms directly, bypassing the query).
  it("(pax-per-room) an occupied room's sub-row surfaces its tenancy numberOfPax; a vacant room is null", async () => {
    await prisma.tenancy.update({ where: { id: tenancyOccupied }, data: { numberOfPax: 4 } });
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptOcc)!;
    expect(row.subRows.find((s) => s.listingId === roomOccupied)!.numberOfPax).toBe(4);
    expect(row.subRows.find((s) => s.listingId === roomVacant)!.numberOfPax).toBeNull();
  });

  it("P5 (read path): surfaces the last-editor fullName on entry AND on the edited sub-row, with a non-null updatedAt; a never-edited sub-row is null/null", async () => {
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: t5Actor }, select: { fullName: true } });

    // Save the ENTRY as t5Actor → stamps entry.updatedById (P5, saveEntryService).
    await saveEntryService({ orgId: t5Org, userId: t5Actor, role: "manager" }, aptOcc, { period: T5_PERIOD_STR, cleaning: "10" });
    // Save a READING for the occupied room as t5Actor → stamps that reading's updatedById.
    const w = await saveReadingsService({ orgId: t5Org, userId: t5Actor, role: "editor" }, aptOcc, {
      period: T5_PERIOD_STR,
      readings: [{ listingId: roomOccupied, tenancyId: tenancyOccupied, partyId: null, previousKwh: "0.00", currentKwh: "10.00" }],
    });
    expect(w.ok).toBe(true);

    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptOcc)!;

    // (a) the entry-level editor name resolves to the real User.fullName.
    expect(row.entry?.lastEditedByName).toBe(actor.fullName);

    // (b) the edited room's sub-row carries the editor name + a non-null ISO updatedAt.
    const edited = row.subRows.find((s) => s.listingId === roomOccupied)!;
    expect(edited.lastEditedByName).toBe(actor.fullName);
    expect(edited.updatedAt).not.toBeNull();
    expect(typeof edited.updatedAt).toBe("string");
    expect(new Date(edited.updatedAt!).toISOString()).toBe(edited.updatedAt); // a real ISO string

    // (c) the vacant room was NEVER given a reading → no editor, no timestamp (never a raw UUID, never a crash).
    const vacant = row.subRows.find((s) => s.listingId === roomVacant)!;
    expect(vacant.lastEditedByName).toBeNull();
    expect(vacant.updatedAt).toBeNull();

    // Leave aptOcc's reading behind for teardown only (afterAll clears all t5 readings).
  });

  it("B2: a room with no meter configured → ratePerKwh='0.6000', rateConfigured=false, and getGrid creates NO AircondMeter row", async () => {
    const before = await prisma.aircondMeter.count({ where: { organizationId: t5Org, unitId: roomNoMeter } });
    expect(before).toBe(0);

    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptNoMeter)!;
    const sub = row.subRows.find((s) => s.listingId === roomNoMeter)!;
    expect(sub.ratePerKwh).toBe("0.6000");
    expect(sub.rateConfigured).toBe(false);

    const after = await prisma.aircondMeter.count({ where: { organizationId: t5Org, unitId: roomNoMeter } });
    expect(after).toBe(0); // the READ must never write a meter row
  });

  it("B13: a RETIRED (isActive:false) AircondMeter still reports rateConfigured:true (meter-parity — a real configured meter, just off)", async () => {
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptRetired)!;
    const sub = row.subRows.find((s) => s.listingId === roomRetired)!;
    expect(sub.rateConfigured).toBe(true);
    expect(sub.ratePerKwh).toBe("0.5500");
  });

  it("B7: row.isWholeUnit is true for a WHOLE apartment and false for a PARTITIONED apartment", async () => {
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    expect(r.data.rows.find((x) => x.apartmentId === aptWhole)!.isWholeUnit).toBe(true);
    expect(r.data.rows.find((x) => x.apartmentId === aptPartitioned)!.isWholeUnit).toBe(false);
  });

  it("B3 (via row-dto-mappers.test.ts too): entry.rental is absent from getGrid's wire response", async () => {
    await saveEntryService({ orgId: t5Org, userId: t5Actor, role: "editor" }, aptOcc, { period: T5_PERIOD_STR, cleaning: "10.00" });
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptOcc)!;
    expect(row.entry).not.toBeNull();
    expect(row.entry).not.toHaveProperty("rental");
  });

  it("B6/B12/B14/B15: negative consumption → NEGATIVE_CONSUMPTION{listingId}, amount='0.00'; a null-current room is NOT misreported; a healthy sibling is unaffected; a co-existing ZERO_PAX_TENANCY warning is NOT suppressed", async () => {
    await saveEntryService({ orgId: t5Org, userId: t5Actor, role: "editor" }, aptNeg, { period: T5_PERIOD_STR, tnbTotal: "500.00", airSelangor: "20.00" });
    const e = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: t5Org, apartmentId: aptNeg, periodMonth: T5_PERIOD } } });

    // Negative: stored current(50) < previous(80) — directly injected (bypassing the
    // save-time 0-clamp) to simulate legacy/tampered data, mirroring this file's
    // existing "FINDING 2 (read)" pattern of injecting rows directly for read-path assertions.
    await prisma.gridMeterReading.create({
      data: { organizationId: t5Org, entryId: e.id, apartmentId: aptNeg, periodMonth: T5_PERIOD, listingId: roomNegative, tenancyId: null, partyId: null, previousKwh: "80.00", currentKwh: "50.00", amount: "0.00", createdBy: t5Actor },
    });
    // Not yet read: currentKwh null — must NOT be misreported as negative.
    await prisma.gridMeterReading.create({
      data: { organizationId: t5Org, entryId: e.id, apartmentId: aptNeg, periodMonth: T5_PERIOD, listingId: roomNotYetRead, tenancyId: null, partyId: null, previousKwh: "10.00", currentKwh: null, amount: null, createdBy: t5Actor },
    });
    // Healthy sibling: positive consumption.
    await prisma.gridMeterReading.create({
      data: { organizationId: t5Org, entryId: e.id, apartmentId: aptNeg, periodMonth: T5_PERIOD, listingId: roomHealthy, tenancyId: null, partyId: null, previousKwh: "10.00", currentKwh: "30.00", amount: "12.00", createdBy: t5Actor },
    });
    // Zero-pax room: a reading tied to a zero-pax tenancy — must ALSO warn, coexisting with the negative-consumption warning above.
    await prisma.gridMeterReading.create({
      data: { organizationId: t5Org, entryId: e.id, apartmentId: aptNeg, periodMonth: T5_PERIOD, listingId: roomZeroPax, tenancyId: tenancyZeroPax, partyId: t5Party, previousKwh: "5.00", currentKwh: "15.00", amount: "6.00", createdBy: t5Actor },
    });

    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptNeg)!;

    // Exactly one NEGATIVE_CONSUMPTION, keyed to roomNegative — not to any sibling room.
    const negWarnings = row.warnings.filter((w) => w.code === "NEGATIVE_CONSUMPTION");
    expect(negWarnings).toEqual([{ code: "NEGATIVE_CONSUMPTION", listingId: roomNegative }]);
    expect(row.subRows.find((s) => s.listingId === roomNegative)!.amount).toBe("0"); // Decimal#toString, no trailing zeros (matches B5's existing "60" convention)

    // The null-current room is NOT flagged negative.
    expect(row.warnings.some((w) => w.code === "NEGATIVE_CONSUMPTION" && w.listingId === roomNotYetRead)).toBe(false);
    // The healthy sibling is untouched.
    expect(row.warnings.some((w) => w.code === "NEGATIVE_CONSUMPTION" && w.listingId === roomHealthy)).toBe(false);
    expect(row.subRows.find((s) => s.listingId === roomHealthy)!.amount).toBe("12");

    // ZERO_PAX_TENANCY coexists — NOT suppressed by the negative-consumption warning.
    expect(row.warnings.some((w) => w.code === "ZERO_PAX_TENANCY" && w.tenancyId === tenancyZeroPax)).toBe(true);
    expect(negWarnings).toHaveLength(1); // still exactly one negative warning despite the sibling anomaly

    await prisma.gridMeterReading.deleteMany({ where: { entryId: e.id } });
  });

  it("B16: months>1 — NEGATIVE_CONSUMPTION derives ONLY from the CURRENT period's entry, never a prior month's reading", async () => {
    // Seed a PRIOR month (one month back) with its OWN negative reading on a fresh room.
    const priorPeriodStr = "2026-07-01";
    const priorPeriod = new Date(`${priorPeriodStr}T00:00:00.000Z`);
    await saveEntryService({ orgId: t5Org, userId: t5Actor, role: "editor" }, aptNeg, { period: priorPeriodStr, tnbTotal: "500.00" });
    const priorEntry = await prisma.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: t5Org, apartmentId: aptNeg, periodMonth: priorPeriod } } });
    await prisma.gridMeterReading.create({
      data: { organizationId: t5Org, entryId: priorEntry.id, apartmentId: aptNeg, periodMonth: priorPeriod, listingId: roomHealthy, tenancyId: null, partyId: null, previousKwh: "90.00", currentKwh: "10.00", amount: "0.00", createdBy: t5Actor },
    });

    // Current month (T5_PERIOD): roomHealthy has a POSITIVE reading (from the B6 test above, still on file) or none — either way, no negative reading exists THIS period.
    const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 2 }); // months:2 pulls the prior month into priorMonths[]
    if (!r.ok) throw new Error("expected 200");
    const row = r.data.rows.find((x) => x.apartmentId === aptNeg)!;
    // The CURRENT row's warnings must not carry a NEGATIVE_CONSUMPTION for roomHealthy —
    // its negative reading lives only in the PRIOR month's entry, which this row never reads.
    expect(row.warnings.some((w) => w.code === "NEGATIVE_CONSUMPTION" && w.listingId === roomHealthy)).toBe(false);
    expect(row.priorMonths).toHaveLength(1); // months:2 → one prior strip, R6

    await prisma.gridMeterReading.deleteMany({ where: { entryId: priorEntry.id } });
    await prisma.unitBillsGridEntry.delete({ where: { id: priorEntry.id } });
  });

  it("B5: a page of 10 apartments issues a BOUNDED, constant number of rate/rent queries — never one-per-subRow", async () => {
    const meterSpy = spyCallthrough(prisma.aircondMeter, "findMany");
    const tenancySpy = spyCallthrough(prisma.tenancy, "findMany");
    const rcSpy = spyCallthrough(prisma.recurringCharge, "findMany");
    try {
      const r = await getGridService({ orgId: t5Org }, { period: T5_PERIOD_STR, months: 1 });
      if (!r.ok) throw new Error("expected 200");
      expect(r.data.rows.filter((x) => spyApts.includes(x.apartmentId))).toHaveLength(10);
      // ONE aircondMeter.findMany for rates (resolveRoomRatesBatch) across ALL apartments'
      // rooms on the page — never one call per apartment or per subRow. tenancy/recurringCharge
      // findMany (resolveRoomRentsBatch) are similarly bounded — a small constant, NOT
      // proportional to the 10-apartment page or its room count.
      expect(meterSpy.spy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(tenancySpy.spy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(rcSpy.spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      meterSpy.restore();
      tenancySpy.restore();
      rcSpy.restore();
    }
  });
});
