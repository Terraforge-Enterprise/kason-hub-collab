/**
 * Bills-grid tenant-expense OWNER NAME resolution (Item 1, R1/R7).
 *
 * listExpensesService must surface each line's owner `partyName`, resolved from the
 * stored `partyId` snapshot ORG-SCOPED — a foreign-org / unresolvable id yields
 * `null` (never leaks a name), mirroring the `chargeCategory` org-scoped include in
 * the same mapper. Same integration harness as expense-category.integration.test.ts.
 *
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *     && RUN_INTEGRATION=1 npm run test -w @kason/api -- expense-owner-name
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listExpensesService } from "../service";
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

const PERIOD_STR = "2026-11-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
let ORG = "";
let ACTOR = "";
let APT = "";
let OWN_PARTY = "";
let OTHER_ORG = "";
let FOREIGN_PARTY = "";

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  ACTOR = (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG } })).id;
  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  APT = (await prisma.apartment.create({
    data: { organizationId: ORG, propertyId: prop.id, unitCode: `OWNNAME-${Date.now()}`, listingMode: "WHOLE" },
  })).id;

  OWN_PARTY = (await prisma.party.create({
    data: { organizationId: ORG, partyType: "individual", displayName: "Leo Ownername", status: "active" },
  })).id;

  const other = await prisma.organization.create({
    data: { name: "Other Org (own-name)", slug: `other-ownname-${Date.now()}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  OTHER_ORG = other.id;
  FOREIGN_PARTY = (await prisma.party.create({
    data: { organizationId: OTHER_ORG, partyType: "individual", displayName: "Foreign Tenant SHOULD-NOT-LEAK", status: "active" },
  })).id;

  // One entry, three tenant-expense lines: two owned by OWN_PARTY (proves batched
  // multi-owner resolution), one carrying a FOREIGN_PARTY snapshot (leak guard).
  await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } });
  const entry = await prisma.unitBillsGridEntry.create({
    data: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: ACTOR },
  });
  const line = (partyId: string | null, description: string, amount: string) =>
    prisma.gridExpense.create({
      data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, bearer: "tenant", description, amount, partyId, createdBy: ACTOR },
    });
  await line(OWN_PARTY, "Aircon service", "80.00");
  await line(OWN_PARTY, "Cleaning", "30.00");
  await line(FOREIGN_PARTY, "Foreign-owned line", "45.00");
});

afterAll(async () => {
  if (!RUN) return;
  await cleanupGridFixtures(prisma, ORG, { apartmentIds: [APT].filter(Boolean) });
  if (APT) await prisma.apartment.deleteMany({ where: { id: APT } });
  if (OWN_PARTY) await prisma.party.deleteMany({ where: { id: OWN_PARTY } });
  if (OTHER_ORG) await prisma.organization.delete({ where: { id: OTHER_ORG } }); // cascades FOREIGN_PARTY
});

d("bills-grid tenant-expense owner name (Item 1)", () => {
  it("R1: listExpensesService surfaces partyName resolved from the stored partyId (own org)", async () => {
    const r = await listExpensesService({ orgId: ORG }, { apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const own = r.data.items.filter((i) => i.partyId === OWN_PARTY);
    expect(own.length).toBe(2);
    for (const i of own) expect(i.partyName).toBe("Leo Ownername");
  });

  it("R7: a foreign-org partyId snapshot resolves to partyName null — never leaks the foreign name", async () => {
    const r = await listExpensesService({ orgId: ORG }, { apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const foreign = r.data.items.find((i) => i.partyId === FOREIGN_PARTY);
    expect(foreign).toBeDefined();
    expect(foreign!.partyName).toBeNull();
    expect(r.data.items.some((i) => i.partyName === "Foreign Tenant SHOULD-NOT-LEAK")).toBe(false);
  });
});
