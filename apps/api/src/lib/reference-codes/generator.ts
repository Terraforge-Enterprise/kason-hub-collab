// apps/api/src/lib/reference-codes/generator.ts

import type { Prisma } from "@kason/db";
import type { DocType } from "../document-templates/types";
import { RefPrefixUnconfiguredError } from "./errors";

export async function generateReferenceCodeTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  docType: DocType,
): Promise<string> {
  const template = await tx.documentTemplate.findUniqueOrThrow({
    where: { organizationId_docType: { organizationId: orgId, docType } },
    select: {
      refPrefix: true,
      refSeparator: true,
      refPadding: true,
      refIncludeYear: true,
    },
  });

  if (!template.refPrefix) {
    throw new RefPrefixUnconfiguredError(docType);
  }

  const year = template.refIncludeYear ? new Date().getFullYear() : 0;

  // Atomic upsert + increment in a single statement.
  // Postgres row lock serialises concurrent invocations on the same
  // (organizationId, docType, year) key. RETURNING gives us the value
  // we just consumed.
  const row = await tx.$queryRaw<{ nextValue: number }[]>`
    INSERT INTO "ReferenceSequence" ("id", "organizationId", "docType", "year", "nextValue")
    VALUES (gen_random_uuid(), ${orgId}::uuid, ${docType}, ${year}, 2)
    ON CONFLICT ("organizationId", "docType", "year")
    DO UPDATE SET "nextValue" = "ReferenceSequence"."nextValue" + 1
    RETURNING "nextValue" - 1 AS "nextValue"
  `;

  if (row.length !== 1) {
    throw new Error("generateReferenceCodeTx: expected exactly 1 row from RETURNING");
  }

  const seq = row[0].nextValue;
  const padded = String(seq).padStart(template.refPadding, "0");
  const parts =
    template.refIncludeYear
      ? [template.refPrefix, String(year), padded]
      : [template.refPrefix, padded];
  return parts.join(template.refSeparator);
}
