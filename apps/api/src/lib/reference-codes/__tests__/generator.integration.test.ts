/**
 * Race-condition integration test for the atomic reference-code generator.
 *
 * Requires a real local Postgres with the 20260514001000_add_reference_sequence
 * migration applied + an Organization row with id matching TEST_ORG.
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/lib/reference-codes/__tests__/generator.integration.test.ts
 *
 * The scenarios verify that:
 *   - sequential calls produce sequential codes,
 *   - 100 concurrent calls serialize via Postgres row lock (no duplicates),
 *   - empty refPrefix throws RefPrefixUnconfiguredError,
 *   - year-segmentation rotates the counter cleanly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@kason/db";
import { generateReferenceCodeTx } from "../generator";
import { RefPrefixUnconfiguredError } from "../errors";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

async function seedTemplate(orgId: string, docType: string, overrides: Partial<{ refPrefix: string; refSeparator: string; refPadding: number; refIncludeYear: boolean }> = {}) {
  await getDb().documentTemplate.upsert({
    where: { organizationId_docType: { organizationId: orgId, docType } },
    create: {
      organizationId: orgId,
      docType,
      title: "T",
      refPrefix: overrides.refPrefix ?? "RES",
      refSeparator: overrides.refSeparator ?? "-",
      refPadding: overrides.refPadding ?? 5,
      refIncludeYear: overrides.refIncludeYear ?? false,
      headerFields: {},
      orgAddressLines: [],
    },
    update: {
      refPrefix: overrides.refPrefix ?? "RES",
      refSeparator: overrides.refSeparator ?? "-",
      refPadding: overrides.refPadding ?? 5,
      refIncludeYear: overrides.refIncludeYear ?? false,
    },
  });
}

async function cleanOrg(orgId: string) {
  const db = getDb();
  await db.referenceSequence.deleteMany({ where: { organizationId: orgId } });
  await db.documentTemplate.deleteMany({ where: { organizationId: orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
}

async function createOrg(orgId: string) {
  await getDb().organization.create({
    data: {
      id: orgId,
      name: "Test Org",
      slug: `org-${orgId}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

const TEST_ORG = "11111111-1111-1111-1111-111111111111";

dn("generateReferenceCodeTx — integration", () => {
  beforeEach(async () => {
    await cleanOrg(TEST_ORG);
    await createOrg(TEST_ORG);
  });

  it("returns sequential codes for the same (org, docType)", async () => {
    await seedTemplate(TEST_ORG, "reservation_form");
    const db = getDb();
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await db.$transaction(async (tx) => {
        codes.push(await generateReferenceCodeTx(tx, TEST_ORG, "reservation_form"));
      });
    }
    expect(codes).toEqual(["RES-00001", "RES-00002", "RES-00003"]);
  });

  it("year-segmented format", async () => {
    await seedTemplate(TEST_ORG, "reservation_form", { refIncludeYear: true });
    const db = getDb();
    const code = await db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form"));
    const yyyy = new Date().getFullYear();
    expect(code).toBe(`RES-${yyyy}-00001`);
  });

  it("honours padding, separator, and prefix", async () => {
    await seedTemplate(TEST_ORG, "reservation_form", {
      refPrefix: "KAEN RES",
      refSeparator: " ",
      refPadding: 3,
    });
    const db = getDb();
    const code = await db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form"));
    expect(code).toBe("KAEN RES 001");
  });

  it("padding is minimum — overflows beyond the padding width are allowed", async () => {
    await seedTemplate(TEST_ORG, "reservation_form", { refPadding: 3 });
    await getDb().referenceSequence.create({
      data: { organizationId: TEST_ORG, docType: "reservation_form", year: 0, nextValue: 1000 },
    });
    const db = getDb();
    const code = await db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form"));
    expect(code).toBe("RES-1000");
  });

  it("throws RefPrefixUnconfiguredError when prefix is empty", async () => {
    await seedTemplate(TEST_ORG, "reservation_form", { refPrefix: "" });
    const db = getDb();
    await expect(
      db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form")),
    ).rejects.toBeInstanceOf(RefPrefixUnconfiguredError);
  });

  it("year reset: switching includeYear toggles uses a new sequence row", async () => {
    await seedTemplate(TEST_ORG, "reservation_form", { refIncludeYear: false });
    const db = getDb();
    await db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form")); // RES-00001
    await db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form")); // RES-00002

    await seedTemplate(TEST_ORG, "reservation_form", { refIncludeYear: true });
    const code = await db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form"));
    const yyyy = new Date().getFullYear();
    expect(code).toBe(`RES-${yyyy}-00001`);
  });

  it("100 concurrent calls produce 100 unique sequential codes", async () => {
    await seedTemplate(TEST_ORG, "reservation_form");
    const db = getDb();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        db.$transaction((tx) => generateReferenceCodeTx(tx, TEST_ORG, "reservation_form")),
      ),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(100);

    const nums = results
      .map((c) => parseInt(c.split("-")[1]!, 10))
      .sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });
});
