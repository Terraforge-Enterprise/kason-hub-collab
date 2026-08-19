/**
 * Integration tests for the series-number minting util (accounting docs P2).
 * Requires local Postgres. Run explicitly:
 *   RUN_INTEGRATION=1 npx vitest run src/lib/reference-codes/__tests__/series-numbers.integration.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import type { DocumentSeries } from "@kason/db";
import { mintDocumentNumberTx } from "../series-numbers";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const TEST_ORG = "12121212-1212-4121-8121-121212121212";

function makeSeries(overrides: Partial<DocumentSeries> = {}): DocumentSeries {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    organizationId: TEST_ORG,
    code: "IVTEN",
    prefix: "IVTEN",
    padding: 4,
    includeYear: false,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DocumentSeries;
}

async function cleanOrg() {
  const db = getDb();
  await db.billingDocument.deleteMany({ where: { organizationId: TEST_ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: TEST_ORG } });
  await db.organization.deleteMany({ where: { id: TEST_ORG } });
}

/** An already-issued document occupying `documentNumber`. seriesId/partyId/issuedById are
 * PLAIN columns (no FK — see the BillingDocument model comment), so synthetic ids are fine. */
async function seedIssuedDocument(documentNumber: string) {
  await getDb().billingDocument.create({
    data: {
      organizationId: TEST_ORG,
      docType: "invoice",
      documentNumber,
      seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      issuedById: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      counterpartyType: "tenant",
      partyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      subtotal: "100.00",
      total: "100.00",
    },
  });
}

/** Force the counter BEHIND reality, exactly as an out-of-band reset/partial restore does. */
async function setCounter(seriesCode: string, nextValue: number, year = 0) {
  await getDb().referenceSequence.upsert({
    where: { organizationId_docType_year: { organizationId: TEST_ORG, docType: `series:${seriesCode}`, year } },
    create: { organizationId: TEST_ORG, docType: `series:${seriesCode}`, year, nextValue },
    update: { nextValue },
  });
}

async function createOrg() {
  await getDb().organization.create({
    data: {
      id: TEST_ORG,
      name: "Series Test Org",
      slug: `org-${TEST_ORG}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

dn("mintDocumentNumberTx — integration", () => {
  beforeEach(async () => {
    await cleanOrg();
    await createOrg();
  });

  it("mints sequential zero-padded numbers per series code", async () => {
    const db = getDb();
    const series = makeSeries();
    const issuedAt = new Date("2026-07-02T00:00:00.000Z");
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await db.$transaction(async (tx) => {
        codes.push(await mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt));
      });
    }
    expect(codes).toEqual(["IVTEN-0001", "IVTEN-0002", "IVTEN-0003"]);
  });

  it("year mode inserts the UTC year and segments the counter per year", async () => {
    const db = getDb();
    const series = makeSeries({ code: "DEP", prefix: "DEP", includeYear: true });
    const c2026 = await db.$transaction((tx) =>
      mintDocumentNumberTx(tx, TEST_ORG, series, new Date("2026-07-02T00:00:00.000Z")),
    );
    const c2027 = await db.$transaction((tx) =>
      mintDocumentNumberTx(tx, TEST_ORG, series, new Date("2027-01-15T00:00:00.000Z")),
    );
    const c2026b = await db.$transaction((tx) =>
      mintDocumentNumberTx(tx, TEST_ORG, series, new Date("2026-12-31T00:00:00.000Z")),
    );
    expect(c2026).toBe("DEP-2026-0001");
    expect(c2027).toBe("DEP-2027-0001");
    expect(c2026b).toBe("DEP-2026-0002");
  });

  it("different series codes keep independent counters", async () => {
    const db = getDb();
    const issuedAt = new Date("2026-07-02T00:00:00.000Z");
    const a = await db.$transaction((tx) => mintDocumentNumberTx(tx, TEST_ORG, makeSeries(), issuedAt));
    const b = await db.$transaction((tx) =>
      mintDocumentNumberTx(tx, TEST_ORG, makeSeries({ code: "IVOWN", prefix: "IVOWN" }), issuedAt),
    );
    expect(a).toBe("IVTEN-0001");
    expect(b).toBe("IVOWN-0001");
  });

  it("prefix falls back to code when prefix is empty", async () => {
    const db = getDb();
    const code = await db.$transaction((tx) =>
      mintDocumentNumberTx(tx, TEST_ORG, makeSeries({ code: "CN", prefix: "" }), new Date()),
    );
    expect(code).toBe("CN-0001");
  });

  it("a rolled-back transaction burns no numbers (no gaps for the next mint)", async () => {
    const db = getDb();
    const series = makeSeries();
    const issuedAt = new Date("2026-07-02T00:00:00.000Z");
    await expect(
      db.$transaction(async (tx) => {
        await mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const next = await db.$transaction((tx) => mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt));
    expect(next).toBe("IVTEN-0001");
  });

  // REGRESSION (2026-08-03, reported as A-01-02 "couldn't issue the invoice — try again or
  // contact support"): the counter is the SOLE source of truth for the next number, so an
  // out-of-band ReferenceSequence reset that leaves earlier BillingDocuments standing (a
  // partial restore, a demo wipe — scripts/demo-reset.mjs resets it BY DESIGN) makes the mint
  // hand back a number that is already taken. `@@unique([organizationId, documentNumber])`
  // then throws INSIDE the issuing transaction, rolling the whole grid Bill back and surfacing
  // as an uncoded `save_failed`. Retry can never clear it: the increment rolls back with the
  // tx, so every attempt regenerates the identical colliding number and the unit is
  // permanently unbillable. The mint must skip over numbers that already exist.
  it("skips a number an existing document already holds (counter behind reality)", async () => {
    const db = getDb();
    const series = makeSeries();
    const issuedAt = new Date("2026-08-03T00:00:00.000Z");
    // Reproduce the observed dev state exactly: IVTEN-0001/0002 exist, counter says 2.
    await seedIssuedDocument("IVTEN-0001");
    await seedIssuedDocument("IVTEN-0002");
    await setCounter("IVTEN", 2);

    const next = await db.$transaction((tx) => mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt));

    expect(next).toBe("IVTEN-0003");
    // And the number is genuinely free — the create that follows a mint must not collide.
    expect(await db.billingDocument.count({ where: { organizationId: TEST_ORG, documentNumber: next } })).toBe(0);
  });

  it("heals the drift — the mint after a skip continues from the corrected counter", async () => {
    const db = getDb();
    const series = makeSeries();
    const issuedAt = new Date("2026-08-03T00:00:00.000Z");
    await seedIssuedDocument("IVTEN-0001");
    await seedIssuedDocument("IVTEN-0002");
    await setCounter("IVTEN", 1); // two numbers behind — must skip BOTH, not just one

    const a = await db.$transaction((tx) => mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt));
    const b = await db.$transaction((tx) => mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt));

    expect([a, b]).toEqual(["IVTEN-0003", "IVTEN-0004"]);
  });

  // The skip must not leak across series or across years — it is scoped to the number it is
  // about to hand out, so an IVOWN document can never push the IVTEN counter along.
  it("an existing document in ANOTHER series does not perturb this series' counter", async () => {
    const db = getDb();
    await seedIssuedDocument("IVOWN-0001");
    const next = await db.$transaction((tx) =>
      mintDocumentNumberTx(tx, TEST_ORG, makeSeries(), new Date("2026-08-03T00:00:00.000Z")),
    );
    expect(next).toBe("IVTEN-0001");
  });

  it("50 concurrent mints produce 50 unique sequential numbers", async () => {
    const db = getDb();
    const series = makeSeries();
    const issuedAt = new Date("2026-07-02T00:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        db.$transaction((tx) => mintDocumentNumberTx(tx, TEST_ORG, series, issuedAt)),
      ),
    );
    expect(new Set(results).size).toBe(50);
    const nums = results.map((c) => parseInt(c.split("-")[1]!, 10)).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
