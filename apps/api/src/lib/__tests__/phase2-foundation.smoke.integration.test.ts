/**
 * Schema smoke integration test for the phase2 foundation tables.
 *
 * Requires a real local Postgres with the 20260611105334_phase2_foundation
 * migration applied + at least one seeded Organization, Party, and Listing
 * row (any seeded dev DB qualifies).
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="<local>" \
 *     npx vitest run apps/api/src/lib/__tests__/phase2-foundation.smoke.integration.test.ts
 *
 * Creates and reads one row per new table inside a transaction that is
 * deliberately rolled back, so the test leaves zero residue.
 */
import { describe, expect, it } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

class RollbackSentinel extends Error {}

// Requires the local dev DB (root .env DATABASE_URL) with at least one
// Organization, Party, and Listing row (any seeded dev DB qualifies).
dn("phase2 foundation schema smoke", () => {
  it("creates and reads one row per new table, then rolls back", async () => {
    const db = getDb();
    const org = await db.organization.findFirst({ select: { id: true } });
    const party = await db.party.findFirst({ select: { id: true } });
    const unit = await db.listing.findFirst({ select: { id: true } });
    if (!org || !party || !unit) {
      console.warn("smoke skipped: dev DB missing org/party/listing seed");
      return;
    }
    const FAKE_USER = "00000000-0000-0000-0000-000000000000"; // plain column, no FK

    await expect(
      db.$transaction(async (tx) => {
        const invoice = await tx.invoice.create({
          data: {
            organizationId: org.id, invoiceNumber: "SMOKE-1", partyId: party.id,
            invoiceType: "tenant_rental", invoiceDate: new Date(), totalAmount: "100.00",
          },
        });
        expect(invoice.status).toBe("draft");

        const meter = await tx.aircondMeter.create({
          data: { organizationId: org.id, unitId: unit.id },
        });
        expect(meter.ratePerKwh.toString()).toBe("0.6");

        const reading = await tx.meterReading.create({
          data: {
            organizationId: org.id, meterId: meter.id, unitId: unit.id,
            periodMonth: new Date(Date.UTC(2026, 5, 1)), previousReading: "100.00",
            currentReading: "150.00", consumption: "50.00", ratePerKwh: "0.6000",
            computedAmount: "30.00", submittedBy: FAKE_USER,
          },
        });
        expect(reading.status).toBe("submitted");

        await tx.managementFeeConfig.create({
          data: { organizationId: org.id, ownerPartyId: party.id, feeType: "percent", feeValue: "10.00" },
        });

        await tx.task.create({
          data: { organizationId: org.id, title: "smoke", createdBy: FAKE_USER },
        });

        const ticket = await tx.ticket.create({
          data: { organizationId: org.id, unitId: unit.id, title: "smoke", createdBy: FAKE_USER },
        });
        await tx.ticketHistory.create({
          data: {
            organizationId: org.id, ticketId: ticket.id, unitId: unit.id,
            entry: "smoke entry", actorUserId: FAKE_USER, occurredOn: new Date(),
          },
        });

        await tx.deviceToken.create({
          data: { organizationId: org.id, token: "smoke-token", platform: "web" },
        });

        await tx.draftConfig.create({ data: { organizationId: org.id } });
        await tx.invoiceDraftRun.create({
          data: { organizationId: org.id, periodMonth: new Date(Date.UTC(2026, 5, 1)), runDate: new Date() },
        });
        const importRun = await tx.importRun.create({ data: { organizationId: org.id } });
        expect(importRun.dryRun).toBe(true);

        // new nullable columns readable on existing tables
        const charge = await tx.charge.findFirst({ select: { invoiceId: true, billingMonth: true } });
        if (charge) expect(charge.invoiceId).toBeNull();

        throw new RollbackSentinel("rollback");
      }),
    ).rejects.toThrow(RollbackSentinel);
  });
});
