import { describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { ensureChargeCategorySeeds } from "../seed";

const RUN = process.env.RUN_INTEGRATION === "1";

/**
 * OEA series provisioning. Org series coverage in the wild is genuinely uneven (EB
 * exists in 8 orgs, DEP in 10), and issueDocumentTx throws SERIES_NOT_FOUND for a
 * missing code — which would abort a whole Bill. ensureChargeCategorySeeds creates
 * the series lazily per org (create-only, idempotent) exactly as it does for
 * RCPT/EXP/EB, so a Bill can never fail for want of the series.
 */
describe.skipIf(!RUN)("OEA series seeding", () => {
  it("creates the OEA series for an org that lacks it, and is idempotent", async () => {
    const db = getDb();
    const org = await db.organization.findFirstOrThrow({ select: { id: true } });
    await db.documentSeries.deleteMany({ where: { organizationId: org.id, code: "OEA" } });

    await ensureChargeCategorySeeds(org.id);
    const first = await db.documentSeries.findMany({ where: { organizationId: org.id, code: "OEA" } });
    expect(first).toHaveLength(1);
    expect(first[0].prefix).toBe("OEA");

    // Second run must not duplicate the row nor throw.
    await ensureChargeCategorySeeds(org.id);
    const second = await db.documentSeries.findMany({ where: { organizationId: org.id, code: "OEA" } });
    expect(second).toHaveLength(1);
  });
});
