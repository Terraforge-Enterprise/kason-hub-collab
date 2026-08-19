// apps/api/src/lib/reference-codes/series-numbers.ts
//
// Series-minted document numbers for the accounting-documents core (spec §4.1
// DocumentSeries). Generalizes the EXISTING ReferenceSequence engine (see
// generator.ts) instead of adding a new one (§4.8 reuse manifest): counters
// live in ReferenceSequence rows keyed docType = "series:" + DocumentSeries.code
// — the existing @@unique(organizationId, docType, year) makes this safe next
// to the DocumentTemplate-driven counters ("reservation_form", …), which never
// contain a colon.
//
// MUST be called inside the ISSUING transaction: a rollback burns nothing
// (no gaps), and the Postgres row lock on the upsert serialises concurrent
// mints on the same (org, series, year) key.

import type { DocumentSeries, Prisma } from "@kason/db";

/**
 * How many already-taken numbers the mint will step over before giving up. Real drift is a
 * handful (a demo wipe, a partial restore); anything past this is a corrupt counter that
 * wants a human, not a longer loop.
 */
const MAX_COLLISION_SKIPS = 1000;

export async function mintDocumentNumberTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  series: DocumentSeries,
  issuedAt: Date,
): Promise<string> {
  const year = series.includeYear ? issuedAt.getUTCFullYear() : 0;
  const seqDocType = `series:${series.code}`;
  const prefix = series.prefix || series.code; // display prefix defaults to code
  const format = (n: number) => {
    const padded = String(n).padStart(series.padding, "0");
    return series.includeYear ? `${prefix}-${year}-${padded}` : `${prefix}-${padded}`;
  };

  // Consume one counter value. Atomic upsert + increment in a single statement (same idiom as
  // generateReferenceCodeTx). RETURNING gives the value just consumed. The Postgres row lock
  // taken here is held for the REST of the transaction, so the skip loop below stays
  // serialised against concurrent minters exactly as a single call always was.
  const consume = async (): Promise<number> => {
    const row = await tx.$queryRaw<{ nextValue: number }[]>`
      INSERT INTO "ReferenceSequence" ("id", "organizationId", "docType", "year", "nextValue")
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${seqDocType}, ${year}, 2)
      ON CONFLICT ("organizationId", "docType", "year")
      DO UPDATE SET "nextValue" = "ReferenceSequence"."nextValue" + 1
      RETURNING "nextValue" - 1 AS "nextValue"
    `;
    if (row.length !== 1) {
      throw new Error("mintDocumentNumberTx: expected exactly 1 row from RETURNING");
    }
    return row[0].nextValue;
  };

  // ── Skip numbers that are already taken ────────────────────────────────────────────────
  // The counter is NOT self-evidently the truth about what has been issued. Anything that
  // resets ReferenceSequence while BillingDocuments survive — a partial restore, a demo wipe
  // (scripts/demo-reset.mjs resets it BY DESIGN), hand-run SQL — leaves it BEHIND reality, and
  // the next mint hands back a number a document already holds.
  //
  // That used to be unrecoverable. `@@unique([organizationId, documentNumber])` threw INSIDE
  // the caller's issuing transaction, so for the bills-grid the whole Bill rolled back and the
  // admin saw the uncoded "couldn't issue the invoice — try again or contact support". And
  // "try again" could never work: the increment rolls back with the transaction, so every
  // attempt regenerated the SAME colliding number and the unit was permanently unbillable
  // (2026-08-03, A-01-02 — IVTEN/IVOWN counters sat at 2 with IVTEN-0002/IVOWN-0002 issued).
  //
  // So step over what is taken. Skipping forward is the safe direction: the numbering already
  // tolerates gaps (a rolled-back issue burns none, but a deleted document leaves one), while
  // REUSING a number would put two documents on one legal reference. The existence check is a
  // point lookup on that same unique index, and only ever repeats while the counter is behind.
  for (let skips = 0; skips <= MAX_COLLISION_SKIPS; skips++) {
    const candidate = format(await consume());
    const taken = await tx.billingDocument.findFirst({
      where: { organizationId: orgId, documentNumber: candidate },
      select: { id: true },
    });
    if (!taken) {
      if (skips > 0) {
        // Never silent: the counter WAS corrupt, and the operator should know the series
        // skipped numbers even though the document issued cleanly.
        console.warn(
          `[series-numbers] ${seqDocType} counter was behind issued documents — skipped ${skips} taken number(s) to mint ${candidate}`,
          { orgId, series: series.code, year },
        );
      }
      return candidate;
    }
  }

  throw new Error(
    `mintDocumentNumberTx: ${seqDocType} counter is more than ${MAX_COLLISION_SKIPS} numbers behind issued documents (org ${orgId}) — reseat ReferenceSequence."nextValue" past the highest issued ${prefix} number`,
  );
}
