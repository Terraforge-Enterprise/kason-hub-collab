/**
 * Bills-grid expense create — persists `GridExpense.tenancyId` (Task 2, bill-expenses
 * spec R3). `createExpensesService` already derives `party.partyId` from
 * `body.tenancyId` via `resolveExpenseParty`; this task additionally snapshots the
 * raw `tenancyId` onto the row itself so Task 5's itemized-invoice co-grouping can
 * key off it directly instead of re-deriving it from `partyId`.
 *
 * Same integration harness as expense-category.integration.test.ts / expense-owner-
 * name.integration.test.ts (RUN_INTEGRATION=1 against the real local Postgres — under
 * Prisma 7 the datasource has no `url`, so the client is only constructible through
 * @kason/db's PrismaPg adapter).
 *
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *     && RUN_INTEGRATION=1 npm run test -w @kason/api -- expense-create-tenancy
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { createExpensesService } from "../service";
import { cleanupGridFixtures } from "./cleanup";

const prisma = getDb();

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const PERIOD_STR = "2026-12-01"; // distinct from sibling suites' periods; this file's own apartment anyway
let ORG = "";
let ACTOR = "";
let APT = "";
let TENANCY = "";
let FIX_APTS: string[] = [];

const session = (role: "editor" | "manager" | "admin") => ({ orgId: ORG, userId: ACTOR, role });

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  ACTOR = (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG } })).id;
  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  APT = (await prisma.apartment.create({
    data: { organizationId: ORG, propertyId: prop.id, unitCode: `TEN-CREATE-${Date.now()}`, listingMode: "WHOLE" },
  })).id;
  FIX_APTS = [APT];

  // Reuse an existing in-org Tenancy — this task only needs a valid tenancyId to
  // thread through, not a dedicated fixture (mirrors service.integration.test.ts's
  // SAME_ORG_TENANCY, but read-only here: this suite never mutates the tenancy).
  const tenancy = await prisma.tenancy.findFirstOrThrow({ where: { organizationId: ORG } });
  TENANCY = tenancy.id;
});

afterAll(async () => {
  if (!RUN) return;
  await cleanupGridFixtures(prisma, ORG, { apartmentIds: [APT].filter(Boolean) });
  if (FIX_APTS.length) await prisma.apartment.deleteMany({ where: { id: { in: FIX_APTS } } });
});

d("createExpensesService persists tenancyId", () => {
  it("persists tenancyId for a tenant expense", async () => {
    const r = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TENANCY,
      items: [{ description: "Aircon", amount: "250.00", withSST: false }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const row = await prisma.gridExpense.findUniqueOrThrow({ where: { id: r.data.ids[0] } });
    expect(row.tenancyId).toBe(TENANCY);
  });

  it("rejects a tenant expense created without a tenancyId", async () => {
    // The create-time guard is flag-gated (matches the mint that consumes it — review #5),
    // so enable the flag for this assertion and restore it afterwards.
    const prev = process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    try {
      const r = await createExpensesService(session("editor"), {
        apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant",
        items: [{ description: "Aircon", amount: "250.00", withSST: false }],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(400);
      expect(r.error).toBe("EXPENSE_TENANCY_REQUIRED");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
      else process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = prev;
    }
  });

  it("owner expense null tenancy: create with bearer:owner and no tenancyId stores tenancyId null", async () => {
    const r = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Repair", amount: "80.00", withSST: false }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const row = await prisma.gridExpense.findUniqueOrThrow({ where: { id: r.data.ids[0] } });
    expect(row.tenancyId).toBeNull();
  });
});
