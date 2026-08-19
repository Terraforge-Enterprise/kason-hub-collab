export { db, getDb } from "./client";
export { Prisma } from "@prisma/client";
// DocumentSeries: model type needed by mintDocumentNumberTx's signature
// (series-numbers.ts) — Prisma generates it as a top-level @prisma/client
// export, not under the Prisma namespace, so it needs an explicit re-export.
export type { DocumentSeries } from "@prisma/client";
// OwnerStatementPeriod: model type consumed by the owner-statement period
// repository (owner-billing) — same top-level-export reason as DocumentSeries.
export type { OwnerStatementPeriod } from "@prisma/client";
