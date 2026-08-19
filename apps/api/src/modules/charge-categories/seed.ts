// apps/api/src/modules/charge-categories/seed.ts
// Idempotent per-org seeding of DocumentSeries + ChargeCategory defaults —
// same lazy-ensure pattern as the M6 owner_statement DocumentTemplate seeding
// (apps/api/src/modules/document-templates/service.ts listTemplatesService):
// read existing rows first, then create ONLY what's missing.
//
// Genuinely create-only — never upsert/update an existing row. Prisma's
// @updatedAt stamps `updatedAt = now()` on ANY upsert match (even with
// `update: {}`), and repository.ts's guardedUpdateChargeCategory /
// guardedUpdateDocumentSeries use `updatedAt` equality as the
// optimistic-concurrency token. Since this seeder is called lazily from GET
// routes, an upsert-based implementation would churn `updatedAt` on every
// already-seeded row on every call and cause false 409s on ordinary
// GET-then-PATCH admin flows.
//
// Called from the module's GET routes; also reused by
// scripts/backfill-charge-categories.ts.
import { getDb } from "@kason/db";
import { SEED_CHARGE_CATEGORIES, SEED_DOCUMENT_SERIES } from "@kason/shared";

export async function ensureChargeCategorySeeds(orgId: string): Promise<void> {
  const db = getDb();

  // 1) Series: create only the codes this org doesn't have yet.
  const existingSeries = await db.documentSeries.findMany({
    where: { organizationId: orgId },
    select: { code: true },
  });
  const existingSeriesCodes = new Set(existingSeries.map((s) => s.code));

  for (const s of SEED_DOCUMENT_SERIES) {
    if (existingSeriesCodes.has(s.code)) continue; // never touch an existing row
    try {
      await db.documentSeries.create({
        data: { organizationId: orgId, code: s.code, prefix: s.prefix },
      });
    } catch (e) {
      // (organizationId, code) collision — another request created it
      // between the read above and this write. Skip, never fail the request.
      // Duck-typed (not instanceof) so unit tests can mock @kason/db wholesale.
      if ((e as { code?: string }).code === "P2002") continue;
      throw e;
    }
  }

  // Re-read (existing + just-created) to resolve category.seriesId by code.
  const series = await db.documentSeries.findMany({
    where: { organizationId: orgId },
    select: { id: true, code: true },
  });
  const seriesIdByCode = new Map(series.map((s) => [s.code, s.id]));

  // 2) Categories: create only the codes this org doesn't have yet.
  const existingCategories = await db.chargeCategory.findMany({
    where: { organizationId: orgId },
    select: { code: true },
  });
  const existingCategoryCodes = new Set(existingCategories.map((c) => c.code));

  for (const c of SEED_CHARGE_CATEGORIES) {
    if (existingCategoryCodes.has(c.code)) continue; // never touch an existing row
    const seriesId = seriesIdByCode.get(c.seriesCode);
    if (!seriesId) continue; // unreachable after the series creates above
    try {
      await db.chargeCategory.create({
        data: {
          organizationId: orgId,
          code: c.code,
          name: c.name,
          family: c.family,
          docType: c.docType,
          seriesId,
          defaultSstRate: c.defaultSstRate ?? "0",
          eInvoiceEligible: c.eInvoiceEligible ?? false,
          ledgerCategory: c.ledgerCategory ?? null,
          isSystem: c.isSystem ?? false,
          active: c.active ?? true,
          sortOrder: c.sortOrder,
        },
      });
    } catch (e) {
      // @@unique(organizationId, name) collision with an admin-created row,
      // or (organizationId, code) collision from a concurrent seed race:
      // the org already has that row — skip, never fail the request.
      // Duck-typed (not instanceof) so unit tests can mock @kason/db wholesale.
      if ((e as { code?: string }).code === "P2002") continue;
      throw e;
    }
  }
}
