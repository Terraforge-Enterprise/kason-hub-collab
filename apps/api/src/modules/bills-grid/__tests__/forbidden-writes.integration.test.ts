// Task 8 — the forbidden-write snapshot. The last line of defence for HARD
// CONSTRAINT 2 + C5 + C6 + C8: the bills-grid module owns a STANDALONE store and
// must NEVER write OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation, NEVER
// reach buildComputeInputs (the UnitUtilityBill-reading helper shared with the
// charge path, C6), and NEVER persist a shaped pool back onto UnitUtilityBill
// (C5 / C8). If this test is ever weakened, the grid can silently corrupt the
// real bill. NEVER delete it.
//
// TASK-4 EXCEPTION (spec 2026-07-17-bills-grid-bill-issues-invoices §R1/R2), WIDENED
// BY TASK 6 (grid-scoped grouped invoice issuance): the module has exactly TWO
// grid→money seam files — `service.ts`'s flag-gated (ENABLE_PHASE2_BILLING_DOCS)
// issuance phase (mints `Charge` rows) and `issue-grouped.ts` (`issueGroupedGridInvoiceTx`,
// which reads the minted charges by id and issues them via the immutable
// `../billing-documents/issue.service` core — the SAME path the meter charge flow
// uses). The guard below is NARROWED, NOT weakened: the `charge` delegate + the
// `billing-documents` import are permitted ONLY in these two named files; the three
// other money delegates, the meter/service·charges·owner-ledger writer imports, the
// raw-SQL hatch and the buildComputeInputs ban ALL stay absolute in EVERY file
// (both of these included). Flag OFF the seam never runs — the runtime snapshot
// (flag-dark) still asserts a Save+Bill writes ZERO Charge rows.
//
// The static invariant is STRONGER than "no forbidden write": the standalone grid
// touches NONE of the four money delegates AT ALL (read or write, dot / bracket /
// alias), imports NO money-writing module (only the PURE meter/compute engine),
// uses NO raw-SQL escape hatch, and references buildComputeInputs NOWHERE. A false
// positive here is a live hazard, so every clause below was verified to pass on the
// current CORRECT module (esp. against the C5/C6 prose, which names the delegates in
// Pascal case — the delegate-access clause is CASE-SENSITIVE precisely so
// `UnitUtilityBill.tnbTotal` in a comment never masquerades as the `unitUtilityBill`
// delegate). Adversarial-reviewer holes closed in this pass: out-of-module money-
// writer imports, aliased/bracket delegate receivers, raw SQL, buildComputeInputs
// via variable indirection, and a `//`-inside-a-string comment-mangle that could
// hide a real write from a comment-STRIPPED scan.
//
// ACCEPTED RESIDUAL (out of static-text scope, documented not closed): a nested-
// relation write such as `unitBillsGridEntry.create({ data: { charge: { create: … } } })`
// would need a grid→money Prisma relation that does NOT exist in schema.prisma; it
// cannot compile, and it would surface in schema review rather than a text grep.
//
// TWO layers of proof:
//  1. STATIC (always runs, no DB — the mechanical, loud gate): grep the module's
//     OWN source. The delegate-access, money-writer-import and raw-SQL clauses run
//     on UN-STRIPPED source (those tokens never appear in this module's prose in the
//     matched form — verified — so a `//` hidden in a string literal cannot mangle a
//     line to hide a real write). Only the buildComputeInputs clause strips comments
//     first (its 4 legit mentions are all prose).
//  2. RUNTIME (opt-in, RUN_INTEGRATION=1): a real Save + Bill over an apartment-
//     month leaves count(Charge)/count(OwnerLedgerEntry)/count(UnitUtilityBill)/
//     count(UtilityAllocation) identical, and a P2-absorbed run leaves an existing
//     UnitUtilityBill's tnbTotal/airSelangor byte-unchanged.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, saveEntryService } from "../service";
import { cleanupGridFixtures } from "./cleanup";

// ── PART 1 · STATIC GUARD (no DB; ALWAYS runs, incl. CI without Postgres) ─────
const MODULE_DIR = join(__dirname, "..");

/**
 * Every module source EXCEPT the tests themselves — the tests (this file included)
 * legitimately NAME the forbidden tokens in strings/regexes. Recursive so a future
 * subdirectory of the module is covered automatically; a NEW file with a forbidden
 * write is caught the moment it lands. The glob spans `.ts/.mts/.cts/.tsx` so a
 * forbidden write cannot hide behind a non-plain-`.ts` extension.
 */
function moduleSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...moduleSources(full));
    else if (/\.(ts|mts|cts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Drop block/JSDoc and line comments so the buildComputeInputs guard matches CODE,
 * never prose. shape.ts:4 and service.ts:6/84/172 document the C6 rule by writing
 * `... calls buildComputeInputs (meter/service.ts:435 ...`. Stripping is used ONLY
 * for that clause; the delegate-access / import / raw-SQL clauses run UN-STRIPPED so
 * a `//` hidden inside a string literal cannot mangle a real write out of view.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

// ── Task-4 SCOPED ALLOWANCE (bills-grid Bill → invoice, flag-gated) ───────────
// bills-grid now has ONE grid→money seam: `service.ts`'s flag-gated issuance phase
// (ENABLE_PHASE2_BILLING_DOCS) mints `Charge` rows and issues them via the
// immutable `../billing-documents/issue.service` core — the SAME path the meter
// charge flow uses. This is DELIBERATE (spec 2026-07-17-bills-grid-bill-issues-
// invoices §R1/R2) and NARROWLY scoped: ONLY `service.ts`, ONLY the `charge`
// delegate + the `billing-documents` import. The other three money delegates
// (OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation), the `meter/service` /
// `charges` / `owner-ledger` writer imports, the raw-SQL hatch and the
// buildComputeInputs ban ALL stay absolute — in service.ts too. Flag OFF the
// issuance never runs; the RUNTIME snapshot below (flag-dark) still asserts ZERO
// Charge rows are written by a Save+Bill.
// The ONLY files allowed the `charge`/billing-documents seam — service.ts (Task 4,
// mints charges) and issue-grouped.ts (Task 6, groups + issues them).
const ALLOWED_MONEY_SEAM_FILES = new Set(["service.ts", "issue-grouped.ts"]);

// A write to any money-engine delegate, HOWEVER the client is obtained
// (`prisma.`, `tx.`, `getDb().`, …) — receiver-agnostic on purpose, strictly
// stronger than the plan's `prisma\.`/`tx\.` grep. `(create|update|upsert|delete)\w*`
// covers EVERY Prisma write verb — create, createMany, createManyAndReturn, update,
// updateMany, updateManyAndReturn, upsert, delete, deleteMany — while never matching
// a read (find*/count/aggregate/groupBy). billService itself writes grid rows via
// `updateMany`, so a forbidden `tx.charge.updateMany(...)` is a real style that MUST bite.
// `charge` is split into its OWN capture group so the Task-4 allowance can exempt it
// in service.ts WITHOUT loosening the three always-forbidden delegates.
const FORBIDDEN_WRITE =
  /\.\s*(charge|ownerLedgerEntry|unitUtilityBill|utilityAllocation)\s*\.\s*(create|update|upsert|delete)\w*\s*\(/g;
// The three delegates that stay ABSOLUTELY forbidden in EVERY file, service.ts included.
const ALWAYS_FORBIDDEN_DELEGATES = new Set(["ownerLedgerEntry", "unitUtilityBill", "utilityAllocation"]);

// ANY access — read OR write — to a money delegate, in dot (`tx.charge`), bracket
// (`tx["charge"]`, `x['ownerLedgerEntry']`) or aliased-receiver (`const c = tx.charge`)
// form. Strictly SUPERSETS FORBIDDEN_WRITE, and it is the un-stripped clause that
// closes the comment-mangle hole (a real `tx.charge.create()` on a line whose earlier
// string held `//` is still caught here even though comment-stripping would blank it).
// CASE-SENSITIVE by design: the camelCase delegate tokens must NOT match the Pascal-
// case MODEL names in the C5/C6 prose (`UnitUtilityBill.tnbTotal`, `OwnerLedgerEntry`).
// The trailing `(?![A-Za-z0-9_])` is a token boundary so `airconCharge` / `chargeType`
// never match, while `.charge`, `.charge.`, `["charge"]` and `.charge;` all do. `charge`
// captures separately so the Task-4 allowance can exempt it in service.ts alone.
const DELEGATE_ACCESS =
  /[.[]\s*["']?(charge|ownerLedgerEntry|unitUtilityBill|utilityAllocation)["']?(?![A-Za-z0-9_])/g;

// Money-WRITER module imports. The grid legitimately imports the PURE `../meter/compute`
// engine; it must NEVER import `../meter/service` (writes UnitUtilityBill/Charge/
// UtilityAllocation) nor any charge / owner-ledger module. We extract every
// import/require/dynamic-import specifier (un-stripped: no comment names an import in
// this `from "…"` form) and flag any whose path resolves to a money-writer module.
// FORBIDDEN_MODULE anchors on a path SEGMENT so `../meter/compute` and the grid's own
// `./service` are NOT flagged, while `../meter/service`, `../charges`, `../charge`,
// `../owner-ledger*` (and deeper paths into them) are. `billing(?:-documents)?` is
// captured SEPARATELY so the Task-4 issuance import is exempt in service.ts alone —
// meter/service / charges / owner-ledger stay forbidden EVERYWHERE.
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;
const FORBIDDEN_MODULE = /(?:^|\/)(?:meter\/service|charges?|owner-ledger[\w-]*)(?:\/|$)/;
const BILLING_DOCS_MODULE = /(?:^|\/)billing(?:-documents)?(?:\/|$)/;
// R1 (closed-period integrity) SCOPED ALLOWANCE. `owner-ledger/assert-period-open` is
// the shared closed-period write GUARD: a PURE READ (reads OwnerStatementPeriod, throws
// ClosedPeriodError) that writes NONE of the four money delegates. It is wired into the
// flag-gated owner-borne charge mint (service.ts's mintItemizedCharges) so a grid Bill
// dated into a FROZEN owner month is rejected at creation. Its import is exempt ONLY in
// the seam files (service.ts) — matched BEFORE FORBIDDEN_MODULE (which owner-ledger[\w-]*
// would otherwise catch) — exactly like the billing-documents issuance import. EVERY
// OTHER owner-ledger import (repository, service, sync-hook, …) stays forbidden
// everywhere: the pattern anchors on the exact `assert-period-open` leaf, nothing else.
const CLOSED_PERIOD_GUARD_MODULE = /(?:^|\/)owner-ledger\/assert-period-open$/;

// GRID→OWNER-LEDGER SYNC SEAM (2026-07-29) — the SECOND scoped owner-ledger allowance, same
// shape and same narrowness as the closed-period one above.
//
// WHY THIS IS NOT A WEAKENING. HARD CONSTRAINT 2 exists so the grid never writes
// OwnerLedgerEntry *inside its own money transaction*, where a bad write could corrupt the real
// bill. `syncOwnerLedgerForApartmentMonth` is called POST-COMMIT and opens its OWN transaction:
// it asks the owner-ledger module to RE-DERIVE from charges that are already committed — the
// identical seam meter/service.ts, payments/payments.service.ts and inventory/apartment.service.ts
// all use. The grid still writes none of the four money delegates itself; the delegate-write
// clauses below stay absolute and untouched.
//
// WHY IT IS NEEDED. Before this, every syncOwnerLedgerFor* trigger was a payment, an adjustment
// or a statement generation — so billing tenant + owner left the Owner Ledger empty ("No owners
// found") and no statement could be derived from it.
//
// The pattern anchors on the exact `owner-ledger.sync-hook` leaf, and the allowance is granted
// ONLY in the seam file (service.ts). Every other owner-ledger import stays forbidden everywhere.
const OWNER_LEDGER_SYNC_MODULE = /(?:^|\/)owner-ledger\/owner-ledger\.sync-hook$/;

// Raw-SQL escape hatch: a `$executeRaw*` / `$queryRaw*` could write a money table
// invisibly to a delegate-based guard. The module uses none (verified).
const RAW_SQL = /\$(?:execute|query)Raw(?:Unsafe)?\b/g;

// buildComputeInputs reached ANY way (import, call, or variable/namespace indirection
// like `const fn = svc.buildComputeInputs`) — C6. Comment-STRIPPED (the 4 legit
// mentions are all prose); after stripping it must appear ZERO times.
const BCI_ANY = /\bbuildComputeInputs\b/g;

describe("bills-grid static guard — no forbidden write reaches the money engine", () => {
  const sources = moduleSources(MODULE_DIR);

  it("scans the whole module (fails loudly if the module ever empties)", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("no file writes OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation anywhere, nor Charge outside the flag-gated seam (HARD CONSTRAINT 2 · C5 · C8 persist-back)", () => {
    const hits: string[] = [];
    for (const f of sources) {
      const rel = relative(MODULE_DIR, f);
      for (const m of stripComments(readFileSync(f, "utf8")).matchAll(FORBIDDEN_WRITE)) {
        const delegate = m[1];
        // `charge` write is the Task-4/Task-6 issuance seam — allowed ONLY in
        // service.ts and issue-grouped.ts (ALLOWED_MONEY_SEAM_FILES).
        // The other three delegates are forbidden EVERYWHERE (both included).
        const allowed = delegate === "charge" && ALLOWED_MONEY_SEAM_FILES.has(rel);
        if (!allowed) hits.push(`${rel} → ${m[0].replace(/\s+/g, " ").trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no file ACCESSES OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation in ANY form, nor Charge outside the flag-gated seam (HARD CONSTRAINT 2 · standalone store)", () => {
    // UN-STRIPPED + CASE-SENSITIVE: closes the comment-mangle hole and never false-
    // positives on the Pascal-case C5/C6 prose or on `airconCharge`.
    const hits: string[] = [];
    for (const f of sources) {
      const rel = relative(MODULE_DIR, f);
      for (const m of readFileSync(f, "utf8").matchAll(DELEGATE_ACCESS)) {
        const delegate = m[1];
        const allowed = delegate === "charge" && ALLOWED_MONEY_SEAM_FILES.has(rel);
        if (!allowed) hits.push(`${rel} → ${m[0].replace(/\s+/g, " ").trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no file imports meter/service, charges or owner-ledger anywhere; the billing-documents issuance core is imported ONLY by the flag-gated seam", () => {
    const hits: string[] = [];
    for (const f of sources) {
      const rel = relative(MODULE_DIR, f);
      for (const m of readFileSync(f, "utf8").matchAll(IMPORT_SPECIFIER)) {
        if (CLOSED_PERIOD_GUARD_MODULE.test(m[1]) || OWNER_LEDGER_SYNC_MODULE.test(m[1])) {
          // TWO scoped owner-ledger allowances, both narrow, both seam-file-only (service.ts):
          //  • assert-period-open  — R1 closed-period write GUARD (a pure read)
          //  • owner-ledger.sync-hook — the POST-COMMIT re-derive seam (2026-07-29)
          // Checked FIRST because FORBIDDEN_MODULE's owner-ledger[\w-]* clause would otherwise
          // catch both. EVERY other owner-ledger import (repository, service, …) is still caught
          // by FORBIDDEN_MODULE below, in every file.
          if (!ALLOWED_MONEY_SEAM_FILES.has(rel)) hits.push(`${rel} → ${m[1]}`);
        } else if (FORBIDDEN_MODULE.test(m[1])) {
          hits.push(`${rel} → ${m[1]}`);
        } else if (BILLING_DOCS_MODULE.test(m[1]) && !ALLOWED_MONEY_SEAM_FILES.has(rel)) {
          // billing-documents is the Task-4/Task-6 issuance import — allowed ONLY in
          // service.ts and issue-grouped.ts.
          hits.push(`${rel} → ${m[1]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("no file uses a raw-SQL escape hatch ($executeRaw* / $queryRaw*) that could write a money table invisibly", () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const m of readFileSync(f, "utf8").matchAll(RAW_SQL)) {
        hits.push(`${relative(MODULE_DIR, f)} → ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("buildComputeInputs appears NOWHERE in code — import, call, or variable indirection (C6)", () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const m of stripComments(readFileSync(f, "utf8")).matchAll(BCI_ANY)) {
        hits.push(`${relative(MODULE_DIR, f)} → ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// ── NEGATIVE CONTROL — the narrowed guard STILL BITES ─────────────────────────
// Review fix #4: the Task-4 allowance exempts the `charge` seam in service.ts
// unconditionally (flag-blind). A guard that has been loosened but no longer
// catches a REAL violation is worthless. These synthetic-source assertions prove
// the regexes still fire on forbidden code — WITHOUT planting a real forbidden
// write in a module source (which the positive tests above would rightly fail on).
// If a future edit accidentally broadened the allowance to any-file or dropped a
// delegate from the ban, one of these flips and the loosening is caught here.
//
// `evaluate(...)` reproduces the EXACT allowance logic the positive scan uses
// (allowed = the `charge` delegate in service.ts only) so the control cannot drift
// from the real guard.
function evaluateWrite(rel: string, src: string): string[] {
  const hits: string[] = [];
  for (const m of stripComments(src).matchAll(FORBIDDEN_WRITE)) {
    const delegate = m[1];
    const allowed = delegate === "charge" && ALLOWED_MONEY_SEAM_FILES.has(rel);
    if (!allowed) hits.push(`${rel} → ${m[0].replace(/\s+/g, " ").trim()}`);
  }
  return hits;
}
function evaluateAccess(rel: string, src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(DELEGATE_ACCESS)) {
    const delegate = m[1];
    const allowed = delegate === "charge" && ALLOWED_MONEY_SEAM_FILES.has(rel);
    if (!allowed) hits.push(`${rel} → ${m[0].replace(/\s+/g, " ").trim()}`);
  }
  return hits;
}
/** Reproduces the EXACT import-clause allowance logic the positive scan uses, so the scoped
 * owner-ledger exemptions cannot drift from the real guard. BOTH allowances must be listed
 * here — adding one to the scanner and not to this mirror is precisely the drift this helper
 * exists to prevent (it happened while wiring the sync-hook allowance). */
function evaluateImport(rel: string, src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(IMPORT_SPECIFIER)) {
    if (CLOSED_PERIOD_GUARD_MODULE.test(m[1]) || OWNER_LEDGER_SYNC_MODULE.test(m[1])) {
      if (!ALLOWED_MONEY_SEAM_FILES.has(rel)) hits.push(`${rel} → ${m[1]}`);
    } else if (FORBIDDEN_MODULE.test(m[1])) {
      hits.push(`${rel} → ${m[1]}`);
    } else if (BILLING_DOCS_MODULE.test(m[1]) && !ALLOWED_MONEY_SEAM_FILES.has(rel)) {
      hits.push(`${rel} → ${m[1]}`);
    }
  }
  return hits;
}

describe("bills-grid static guard — NEGATIVE CONTROL (the narrowed guard still bites)", () => {
  it("a `charge` write in a NON-allowed grid file is STILL flagged (the allowance is scoped to service.ts + issue-grouped.ts, not global)", () => {
    const forbidden = "await tx.charge.create({ data: { amount: 1 } });";
    // In service.ts AND issue-grouped.ts the seam is allowed…
    for (const allowedFile of ALLOWED_MONEY_SEAM_FILES) {
      expect(evaluateWrite(allowedFile, forbidden)).toEqual([]);
    }
    // …but the SAME write in any other grid file is a violation.
    expect(evaluateWrite("repository.ts", forbidden)).toHaveLength(1);
    expect(evaluateWrite("shape.ts", forbidden)).toHaveLength(1);
  });

  it("OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation writes stay banned in EVERY file, service.ts and issue-grouped.ts included", () => {
    // ALWAYS_FORBIDDEN_DELEGATES (wired here — review fix #5): the three delegates
    // that the Task-4/Task-6 allowance NEVER exempts, anywhere.
    for (const delegate of ALWAYS_FORBIDDEN_DELEGATES) {
      const write = `await tx.${delegate}.create({ data: {} });`;
      // Banned even in the files that get the `charge` allowance.
      for (const allowedFile of ALLOWED_MONEY_SEAM_FILES) {
        expect(evaluateWrite(allowedFile, write)).toHaveLength(1);
        // …and its mere ACCESS (read or write) is banned there too.
        expect(evaluateAccess(allowedFile, `const x = tx.${delegate};`)).toHaveLength(1);
      }
      expect(evaluateWrite("repository.ts", write)).toHaveLength(1);
    }
  });

  it("a bracket-form / updateMany `charge` write outside service.ts is caught (receiver-agnostic, all write verbs)", () => {
    expect(evaluateWrite("repository.ts", 'await tx.charge.updateMany({ where: {} });')).toHaveLength(1);
    expect(evaluateAccess("repository.ts", 'const c = tx["charge"];')).toHaveLength(1);
  });

  it("the R1 closed-period-guard import allowance is NARROW: only owner-ledger/assert-period-open, only in the seam files (every other owner-ledger import stays forbidden)", () => {
    const guardImport = 'import { assertPeriodOpen } from "../owner-ledger/assert-period-open";';
    // Allowed in the seam files…
    for (const allowedFile of ALLOWED_MONEY_SEAM_FILES) {
      expect(evaluateImport(allowedFile, guardImport)).toEqual([]);
    }
    // …but the SAME import in a NON-seam grid file is still a violation.
    expect(evaluateImport("repository.ts", guardImport)).toHaveLength(1);
    // A NON-allowed owner-ledger import stays forbidden EVERYWHERE — including service.ts: the
    // allowances follow the exact `assert-period-open` / `owner-ledger.sync-hook` leaves, nothing
    // broader. (owner-ledger.service is the writer this guard most needs to keep out.)
    const otherOwnerLedger = 'import { x } from "../owner-ledger/owner-ledger.service";';
    for (const allowedFile of ALLOWED_MONEY_SEAM_FILES) {
      expect(evaluateImport(allowedFile, otherOwnerLedger)).toHaveLength(1);
    }
  });

  it("the sync-hook allowance is NARROW: only owner-ledger/owner-ledger.sync-hook, only in the seam files", () => {
    const syncImport = 'import { syncOwnerLedgerForApartmentMonth } from "../owner-ledger/owner-ledger.sync-hook";';
    for (const allowedFile of ALLOWED_MONEY_SEAM_FILES) {
      expect(evaluateImport(allowedFile, syncImport)).toEqual([]);
    }
    // The SAME import in a NON-seam grid file is still a violation.
    expect(evaluateImport("repository.ts", syncImport)).toHaveLength(1);
    // And the allowance does NOT extend to the owner-ledger repository/service writers.
    expect(evaluateImport("service.ts", 'import { y } from "../owner-ledger/owner-ledger.repository";')).toHaveLength(1);
  });
});

// ── PART 2 · RUNTIME SNAPSHOT (opt-in via RUN_INTEGRATION=1) ──────────────────
// getDb() (NOT `new PrismaClient()`): under Prisma 7 the datasource is adapter-
// only, so `new PrismaClient()` throws at construction — that top-level throw would
// break even the static guard above. The RUN_INTEGRATION gate, the non-local host
// guard, and the REAL ACTOR User.id all mirror service.integration.test.ts: a
// synthetic actor UUID violates AuditLog.actorUserId's `onDelete: Restrict` FK the
// moment recordAudit runs inside the Bill transaction. These are the proven Task-5
// deviations from the plan's literal `new PrismaClient()` + synthetic-UUID excerpt.
const prisma = getDb();
const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const PERIOD_STR = "2026-07-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);
const ORG = "a7740000-0000-4000-8000-000000000001";
const ACTOR = "a7740000-0000-4000-8000-000000000002";
const PROP = "a7740000-0000-4000-8000-000000000003";
const FIXTURE_APT = "a7740000-0000-4000-8000-000000000004";
let APT = "";
// Set ONLY when this run seeded its own guard bill (see beforeAll). afterAll deletes
// just that row so the self-seed leaves the shared dev DB as it found it; a pre-existing
// real bill is reused and NEVER deleted.
let seededBillId = "";
const editor = () => ({ orgId: ORG, userId: ACTOR, role: "editor" });
const manager = () => ({ orgId: ORG, userId: ACTOR, role: "manager" });

/** Snapshot of every table the grid is forbidden from touching.
 *
 * ORG-SCOPED, deliberately. These were unfiltered `count()`s over the whole database,
 * which made the assertion a race: vitest runs test FILES in parallel against one shared
 * Postgres, so a sibling suite minting charges between the two snapshots failed this test
 * with a diff that had nothing to do with the grid (observed: charge 6 -> 11, while this
 * file passes 12/12 in isolation). Scoping to this suite's own org keeps the guard exactly
 * as strong — the grid writing the money engine would write it HERE — without inheriting
 * every other suite's writes. */
const forbiddenCounts = async () => ({
  charge: await prisma.charge.count({ where: { organizationId: ORG } }),
  ownerLedgerEntry: await prisma.ownerLedgerEntry.count({ where: { organizationId: ORG } }),
  unitUtilityBill: await prisma.unitUtilityBill.count({ where: { organizationId: ORG } }),
  utilityAllocation: await prisma.utilityAllocation.count({ where: { organizationId: ORG } }),
});

async function rowsFor(ids: string[]) {
  const entries = await prisma.unitBillsGridEntry.findMany({
    where: { organizationId: ORG, periodMonth: PERIOD, apartmentId: { in: ids } },
  });
  return entries.map((e) => ({ apartmentId: e.apartmentId, expectedUpdatedAt: e.updatedAt.toISOString() }));
}

/** Total, org-scoped teardown. Safe to call before a run too. */
async function dropFixtureOrg() {
  await cleanupGridFixtures(prisma, ORG);
  await prisma.utilityAllocation.deleteMany({ where: { organizationId: ORG } });
  await prisma.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.apartment.deleteMany({ where: { organizationId: ORG } });
  await prisma.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await prisma.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

beforeAll(async () => {
  if (!RUN) return;
  // DEDICATED fixture org. This suite used to adopt `organization.findFirstOrThrow()` and
  // then pick `APT` from whatever real UnitUtilityBill it found. On a dev database that
  // resolved to a REAL apartment — and since PERIOD_STR here is 2026-07-01, the very month
  // an operator is likely to be working in, the suite deleted that unit's grid entry
  // (beforeAll), re-Saved it with tnbTotal 590.00, Billed it for real (minting charges and
  // IVTEN/IVOWN invoices), then deleted the lot again in teardown. Scoping the teardown was
  // not enough: when the adopted apartment IS the operator's, there is nothing to scope to.
  await dropFixtureOrg(); // clear anything a crashed prior run left behind
  await prisma.organization.create({
    data: { id: ORG, name: "Forbidden Writes", slug: "forbidden-writes", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await prisma.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "forbidden-writes@example.test", fullName: "FW Operator", status: "active", role: "manager", userType: "operator" },
  });
  await prisma.property.create({
    data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-FW", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await prisma.apartment.create({
    data: { id: FIXTURE_APT, organizationId: ORG, propertyId: PROP, unitCode: "FW-01", listingMode: "WHOLE" },
  });
  // Pick an apartment that has a UnitUtilityBill, so the C5 assertion has a real row to
  // guard. SELF-SEEDING (test isolation): on a freshly-cleaned shared dev DB the org may
  // have NO UnitUtilityBill, which would make findFirstOrThrow throw in this file-level
  // beforeAll and skip all 12 guard tests. If none exists, seed ONE minimal valid row for
  // one of the org's apartments (createdBy is a plain no-FK column; the other columns are
  // defaulted/nullable) and track it so afterAll removes exactly what we created.
  let bill = await prisma.unitUtilityBill.findFirst({ where: { organizationId: ORG } });
  if (!bill) {
    bill = await prisma.unitUtilityBill.create({
      data: {
        organizationId: ORG,
        apartmentId: FIXTURE_APT,
        periodMonth: new Date("2020-01-01T00:00:00.000Z"), // distinct historical fixture period
        billingMode: "whole",
        tnbTotal: "500.00",
        createdBy: ACTOR,
      },
    });
    seededBillId = bill.id;
  }
  APT = bill.apartmentId;
  await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } });
});

// Children → entry → config. UnitBillsGridEntry.apartment is onDelete: Restrict,
// so grid rows must go before anything that removes an apartment.
afterAll(async () => {
  if (!RUN) return;
  await dropFixtureOrg();
  // Remove ONLY the guard bill THIS run seeded (never a pre-existing real bill). The
  // minimal row has no allocations/attachments, so a plain delete is safe.
  if (seededBillId) await prisma.unitUtilityBill.delete({ where: { id: seededBillId } }).catch(() => {});
});

d("HARD CONSTRAINT 2 — the grid never writes the money engine (runtime)", () => {
  it("row counts of Charge / OwnerLedgerEntry / UnitUtilityBill / UtilityAllocation are identical before and after Save+Bill", async () => {
    const before = await forbiddenCounts();
    await saveEntryService(editor(), APT, { period: PERIOD_STR, tnbTotal: "590.00", airSelangor: "40.00" });
    await billService(manager(), { period: PERIOD_STR, rows: await rowsFor([APT]) });
    expect(await forbiddenCounts()).toEqual(before);
  });

  it("C5: a P2-absorbed run leaves an existing UnitUtilityBill's tnbTotal/airSelangor byte-unchanged", async () => {
    const bill0 = await prisma.unitUtilityBill.findFirstOrThrow({ where: { organizationId: ORG, apartmentId: APT } });
    await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } });
    await saveEntryService(editor(), APT, { period: PERIOD_STR, tnbTotal: "590.00", airSelangor: "40.00" });
    await prisma.unitBillsGridEntry.update({
      where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: PERIOD } },
      data: { tnbPattern: "absorbed", airPattern: "absorbed" },
    });
    await billService(manager(), { period: PERIOD_STR, rows: await rowsFor([APT]) });

    const bill1 = await prisma.unitUtilityBill.findUniqueOrThrow({ where: { id: bill0.id } });
    expect(String(bill1.tnbTotal)).toBe(String(bill0.tnbTotal));
    expect(String(bill1.airSelangor)).toBe(String(bill0.airSelangor));
  });
});
