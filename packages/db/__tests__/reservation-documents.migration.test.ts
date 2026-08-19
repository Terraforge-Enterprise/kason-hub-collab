import { describe, it, expect } from "vitest";
import { getDb } from "../src";

// Integration check against the real Postgres (opt-in, RUN_INTEGRATION convention).
// Skipped in the default unit run so it stays DB-free; the migration acceptance
// command runs it with RUN_INTEGRATION=1.
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)("UnitReservationDocument schema", () => {
  it("exposes the unitReservationDocument delegate and the new UnitReservation columns", async () => {
    const db = getDb();
    // Delegate exists (Prisma client generated from the new model)
    expect(typeof db.unitReservationDocument.findMany).toBe("function");
    // New scalar columns are selectable without a Prisma validation error
    await expect(
      db.unitReservation.findFirst({
        select: {
          id: true,
          nationality: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          monthlyIncome: true,
          occupation: true,
          documents: { select: { id: true, kind: true, fileKey: true } },
        },
      }),
    ).resolves.not.toThrow();
  });
});
