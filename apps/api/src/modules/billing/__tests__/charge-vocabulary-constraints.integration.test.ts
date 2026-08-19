/**
 * charge-vocabulary-constraints.integration.test.ts
 *
 * DRIFT GUARD for the column-vocabulary CHECK constraints added in migration
 * 20260727130000_charge_nature_fundedby_checks.
 *
 * Prisma cannot express a CHECK constraint, so the constraint lives only in hand-
 * authored SQL while the vocabulary it encodes lives in a TypeScript `as const`
 * array. Nothing links them. This test reads the constraint back out of Postgres
 * and asserts BOTH its value set AND its expression shape still match.
 *
 * WHAT THIS PROTECTS — stated honestly. CI does NOT run this: no workflow sets
 * RUN_INTEGRATION (grep .github/workflows), master has no CI at all, ci.yml's
 * quality job has no Postgres service, and vitest.config.ts:11-13 aliases
 * @kason/db to a mock unless RUN_INTEGRATION=1. So this is a DEVELOPER CHECK you
 * run deliberately, not a gate that blocks a merge. Wiring it into CI needs a
 * Postgres service container on the quality job.
 *
 * It also only ever describes the database the runner points at — pinned to
 * localhost below. It can say NOTHING about whether UAT or production carry these
 * constraints; that is the higher-consequence drift and is not covered here.
 *
 * Run explicitly:
 *   set -a; . ./.env; set +a; RUN_INTEGRATION=1 npx --workspace @kason/api vitest run \
 *     src/modules/billing/__tests__/charge-vocabulary-constraints.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import { getDb } from "@kason/db";
import { bearer, COMMISSION_SST_BEARER, FUNDED_BY, PROFIT_EXPENSE } from "@kason/shared";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing non-local DB host: ${host}`);
  }
}

interface ConstraintRow {
  conname: string;
  convalidated: boolean;
  def: string;
}

/**
 * Fetch a CHECK constraint SCOPED TO one table.
 *
 * conname is NOT unique across tables — a constraint of the same name on any other
 * table (verified: a temp table happily takes "Charge_nature_check") makes an
 * unscoped `WHERE conname = $1` return multiple rows, and picking rows[0] is
 * arbitrary. Scoping by conrelid is what makes this assertion mean anything.
 */
async function constraintOn(table: string, name: string): Promise<ConstraintRow> {
  const rows = await getDb().$queryRaw<ConstraintRow[]>`
    SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = ${`"${table}"`}::regclass AND conname = ${name}`;
  if (rows.length !== 1) {
    throw new Error(`expected exactly 1 constraint named ${name} on "${table}", found ${rows.length} — migration not applied, or dropped`);
  }
  return rows[0];
}

const chargeConstraint = (name: string) => constraintOn("Charge", name);

/**
 * Every column-vocabulary CHECK, paired with the SINGLE SOURCE OF TRUTH it must match.
 *
 * `bearer` (owner|tenant) and `commissionSstBearer` (owner|KAEN) are deliberately
 * listed against DIFFERENT vocabularies. They share a name suffix and a conceptual
 * family, but the tenant never bears the SST on KAEN's own letting commission —
 * constraining commissionSstBearer to owner|tenant would break that feature. Swept
 * data would not have caught it either: only {owner} exists so far, because 'kaen'
 * has not been exercised yet. Keep these rows apart.
 */
const OWNER_TENANT = [...bearer.options].sort();
const BEARER_CONSTRAINTS: Array<{ table: string; column: string; expected: string[] }> = [
  { table: "UnitUtilityBill", column: "indahWaterBearer", expected: OWNER_TENANT },
  { table: "UnitUtilityBill", column: "cleaningBearer", expected: OWNER_TENANT },
  { table: "UnitUtilityBill", column: "wifiBearer", expected: OWNER_TENANT },
  { table: "UnitBillsGridEntry", column: "cleaningBearer", expected: OWNER_TENANT },
  { table: "UnitBillsGridEntry", column: "wifiBearer", expected: OWNER_TENANT },
  { table: "UnitBillsGridEntry", column: "maintenanceFeeBearer", expected: OWNER_TENANT },
  { table: "UnitBillsBearerConfig", column: "cleaningBearer", expected: OWNER_TENANT },
  { table: "UnitBillsBearerConfig", column: "wifiBearer", expected: OWNER_TENANT },
  { table: "UnitBillsBearerConfig", column: "maintenanceFeeBearer", expected: OWNER_TENANT },
  { table: "GridExpense", column: "bearer", expected: OWNER_TENANT },
  { table: "RecurringChargeRevision", column: "bearer", expected: OWNER_TENANT },
  { table: "GridEntryRecurringLine", column: "bearer", expected: OWNER_TENANT },
  { table: "Tenancy", column: "commissionSstBearer", expected: [...COMMISSION_SST_BEARER].sort() },
];

/** Literal values out of `CHECK ((col = ANY (ARRAY['a'::text, ...])))`. */
function literals(def: string): string[] {
  return [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/**
 * Assert the constraint MEANS what we intend, not merely that it mentions the right
 * words. A literal-only comparison cannot distinguish these, all verified against
 * real Postgres:
 *   CHECK ((nature  =  ANY (ARRAY['expense','profit'])))   <- intended
 *   CHECK ((nature <> ALL (ARRAY['expense','profit'])))    <- permits ONLY invalid values
 *   CHECK (("fundedBy" = ANY (ARRAY['expense','profit']))) <- right values, wrong column
 *   CHECK ((nature IS NOT NULL AND nature = ANY (...)))    <- rejects every legacy NULL row
 */
function expectShape(def: string, column: string): void {
  // Postgres quotes an identifier in pg_get_constraintdef ONLY when it needs to:
  //   nature      (all-lowercase) renders BARE   -> CHECK ((nature = ANY (...)))
  //   "fundedBy"  (camelCase)     renders QUOTED -> CHECK (("fundedBy" = ANY (...)))
  // Requiring quotes unconditionally fails on every snake_case/lowercase column.
  expect(def).toMatch(new RegExp(`(?:"${column}"|\\b${column}\\b)\\s*=\\s*ANY`));
  expect(def).not.toContain("<>");
  expect(def).not.toContain("ALL (");
  expect(def.toUpperCase()).not.toContain("IS NOT NULL");
}

dn("Charge column-vocabulary CHECK constraints", () => {
  it("Charge_nature_check: on Charge, validated, right shape, matches PROFIT_EXPENSE", async () => {
    const c = await chargeConstraint("Charge_nature_check");
    expect(c.convalidated).toBe(true);
    expectShape(c.def, "nature");
    expect(literals(c.def)).toEqual([...PROFIT_EXPENSE].sort());
  });

  it("Charge_fundedBy_check: on Charge, validated, right shape, matches FUNDED_BY", async () => {
    const c = await chargeConstraint("Charge_fundedBy_check");
    expect(c.convalidated).toBe(true);
    expectShape(c.def, "fundedBy");
    expect(literals(c.def)).toEqual([...FUNDED_BY].sort());
  });

  it("NULL remains permitted — legacy rows are unaffected", async () => {
    // Row-independent. Asserting a COUNT is >= 0 would be a tautology; asserting the
    // expression carries no NULL rejection is the real invariant, and it holds on an
    // empty table. `expectShape` already forbids IS NOT NULL; this pins it explicitly
    // because migration.sql promises legacy null rows keep working.
    for (const name of ["Charge_nature_check", "Charge_fundedBy_check"]) {
      const { def } = await chargeConstraint(name);
      expect(def.toUpperCase()).not.toContain("IS NOT NULL");
    }
  });

  it("rejects a value outside the vocabulary (skipped when Charge is empty)", async () => {
    // Guarded on row existence: an UPDATE matching zero rows returns "UPDATE 0"
    // WITHOUT raising, so an unguarded probe fails on a fresh database.
    const existing = await getDb().charge.findFirst({ select: { id: true } });
    if (!existing) return; // shape + convalidated assertions above already cover meaning

    // The callback ALWAYS throws, so Prisma always rolls back. Without this, a
    // MISSING constraint means the UPDATE succeeds, the callback resolves, and
    // Prisma COMMITS 'not_a_nature' onto a real Charge row — corrupting data in
    // exactly the scenario this probe exists to detect.
    const NEVER_COMMIT = "vocab-probe-rollback";
    await expect(
      getDb().$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "Charge" SET "nature" = 'not_a_nature' WHERE id = $1::uuid`, existing.id);
        throw new Error(NEVER_COMMIT); // unreachable when the constraint is present
      }),
    ).rejects.toThrow(/Charge_nature_check/); // NOT the sentinel — sentinel means the constraint failed to fire

    const still = await getDb().charge.findUnique({ where: { id: existing.id }, select: { nature: true } });
    expect(still?.nature).not.toBe("not_a_nature");
  });
});

dn("bearer column-vocabulary CHECK constraints", () => {
  it.each(BEARER_CONSTRAINTS)(
    "$table.$column: on the right table, validated, right shape, right vocabulary",
    async ({ table, column, expected }) => {
      const c = await constraintOn(table, `${table}_${column}_check`);
      expect(c.convalidated).toBe(true);
      expectShape(c.def, column);
      expect(literals(c.def)).toEqual(expected);
    },
  );

  it("commissionSstBearer is owner|kaen, NOT owner|tenant — the two families stay apart", async () => {
    // Pins the near-miss so a later 'tidy-up' cannot quietly merge these vocabularies.
    const sst = literals((await constraintOn("Tenancy", "Tenancy_commissionSstBearer_check")).def);
    const grid = literals((await constraintOn("GridExpense", "GridExpense_bearer_check")).def);
    expect(sst).toContain("kaen");
    expect(sst).not.toContain("tenant");
    expect(grid).toContain("tenant");
    expect(grid).not.toContain("kaen");
  });
});
