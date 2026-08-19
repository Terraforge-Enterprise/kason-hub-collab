import { describe, it, expect } from "vitest";
import {
  categoriesToRepoint,
  pickRentalBillSeries,
  RENTAL_BILL_CATEGORY_CODES,
} from "./backfill-rental-carpark-to-ivren";
import { SEED_DOCUMENT_SERIES, SEED_CHARGE_CATEGORIES } from "@kason/shared";

const RB = "series-rb";
const IVREN = "series-ivren";
const DEP = "series-dep";

describe("categoriesToRepoint (P2 rental/carpark → Rental Bill series)", () => {
  it("selects rental + carpark that are NOT yet on the Rental-Bill series", () => {
    const out = categoriesToRepoint(
      [
        { id: "c1", code: "rental", seriesId: DEP },
        { id: "c2", code: "carpark", seriesId: DEP },
      ],
      RB,
    );
    expect(out).toEqual([
      { id: "c1", code: "rental" },
      { id: "c2", code: "carpark" },
    ]);
  });

  it("is idempotent — skips rows already on the Rental-Bill series (re-run yields nothing)", () => {
    const out = categoriesToRepoint(
      [
        { id: "c1", code: "rental", seriesId: RB },
        { id: "c2", code: "carpark", seriesId: RB },
      ],
      RB,
    );
    expect(out).toEqual([]);
  });

  it("never touches other pay_back_landlord codes (aircond, utilities, deposits stay on DEP)", () => {
    const out = categoriesToRepoint(
      [
        { id: "c1", code: "rental", seriesId: DEP },
        { id: "c3", code: "aircond", seriesId: DEP },
        { id: "c4", code: "utility_tnb", seriesId: DEP },
        { id: "c5", code: "security_deposit", seriesId: DEP },
      ],
      RB,
    );
    expect(out).toEqual([{ id: "c1", code: "rental" }]);
  });

  it("only rental + carpark are Rental-Bill codes", () => {
    expect([...RENTAL_BILL_CATEGORY_CODES]).toEqual(["rental", "carpark"]);
  });
});

// ─── The rename trap that made this script a silent no-op ────────────────────
// From the IVREN→RB rename until 2026-08-01 this script looked up code "IVREN"
// while the seeder only ever created "RB". It found nothing, printed
// "SKIP — no IVREN series after seed (unexpected)", repointed 0 rows and exited 0.
// Rent kept minting on the shared DEP debit-note series, which is how a monthly
// rent charge surfaced to a tenant as "Debit Note · DEP-0001".

describe("pickRentalBillSeries — survives the IVREN→RB rename", () => {
  it("picks RB, the code the seeder actually creates today", () => {
    const picked = pickRentalBillSeries([
      { id: DEP, code: "DEP" },
      { id: RB, code: "RB" },
    ]);
    expect(picked?.id).toBe(RB);
  });

  it("still accepts legacy IVREN so a pre-rename org is not repointed twice", () => {
    const picked = pickRentalBillSeries([
      { id: DEP, code: "DEP" },
      { id: IVREN, code: "IVREN" },
    ]);
    expect(picked?.id).toBe(IVREN);
  });

  it("prefers RB when BOTH exist (RB is the live series; IVREN is history)", () => {
    const picked = pickRentalBillSeries([
      { id: IVREN, code: "IVREN" },
      { id: RB, code: "RB" },
    ]);
    expect(picked?.id).toBe(RB);
  });

  it("returns null when neither exists, so the caller can fail loudly", () => {
    expect(pickRentalBillSeries([{ id: DEP, code: "DEP" }])).toBeNull();
  });

  // THE REGRESSION GUARD. Ties this script to the seed constant it depends on, so
  // the next rename breaks a test instead of silently disabling the backfill.
  it("resolves against a series the SEEDER actually creates", () => {
    const seeded = SEED_DOCUMENT_SERIES.map((s) => ({ id: s.code, code: s.code }));
    const picked = pickRentalBillSeries(seeded);
    expect(picked).not.toBeNull();
  });

  // And that the seed points rent at that same series — the two halves of the fix.
  it("agrees with the seed's own rental category series", () => {
    const rental = SEED_CHARGE_CATEGORIES.find((c) => c.code === "rental");
    expect(rental).toBeDefined();
    const seeded = SEED_DOCUMENT_SERIES.map((s) => ({ id: s.code, code: s.code }));
    expect(pickRentalBillSeries(seeded)?.code).toBe(rental!.seriesCode);
  });
});
