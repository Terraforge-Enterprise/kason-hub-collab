// Vitest stub for @kason/db — prevents Prisma client from being instantiated in tests.
// Services that import getDb directly will receive this stub; the actual DB calls
// are exercised only through mocked repository functions.
import Decimal from "decimal.js";

export const db = {} as never;
export function getDb() {
  return db;
}

// Minimal Prisma namespace stub. Services that translate Prisma errors (e.g. P2002
// unique-violation -> 409) use `instanceof Prisma.PrismaClientKnownRequestError`
// + `err.code === "P2002"`. Tests construct these with `new Prisma.PrismaClientKnownRequestError(msg, { code, clientVersion })`.
class PrismaClientKnownRequestError extends Error {
  code: string;
  clientVersion: string;
  meta?: Record<string, unknown>;
  constructor(message: string, opts: { code: string; clientVersion: string; meta?: Record<string, unknown> }) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = opts.code;
    this.clientVersion = opts.clientVersion;
    this.meta = opts.meta;
  }
}
// ⚠️ MONEY — `Decimal` must be the REAL decimal.js, not a hand-rolled stub. The genuine
// `@kason/db` does `export { Prisma } from "@prisma/client"`, and Prisma's `Prisma.Decimal`
// IS decimal.js — apps/api already depends on it directly (decimal.js ^10.6.0). Re-exporting
// the real class keeps money arithmetic in unit tests byte-identical to production; a stub
// with approximate rounding would let a rounding defect pass a green suite.
//
// Added because owner-statement-sections.ts constructs `new Prisma.Decimal(...)` for the
// adjustment-netted owner receivable. Without it every test touching that path died with
// `TypeError: Prisma.Decimal is not a constructor`.
export const Prisma = {
  PrismaClientKnownRequestError,
  Decimal,
};
