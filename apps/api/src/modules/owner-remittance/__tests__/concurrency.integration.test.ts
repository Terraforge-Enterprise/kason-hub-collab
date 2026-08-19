/**
 * Task 11 (CAPSTONE) — real-Postgres concurrency battery for owner-remittance
 * money invariants under GENUINE contention. Calls the ALREADY-SHIPPED
 * services from Tasks 6/8/9 (recordRemittanceService, recordOffsetService,
 * reverseRemittanceService, reverseOffsetService) DIRECTLY — no HTTP/Hono
 * layer — every one of them is guarded by the SAME per-owner advisory lock
 * (owner-remittance.repository.ts:lockOwnerPayable ->
 * pg_advisory_xact_lock(hashtext('owner-remittance:<org>:<owner>'))) inside
 * ONE getDb().$transaction. authz (role/flag/cross-owner) is a router-layer
 * concern, tested separately in authz.integration.test.ts.
 *
 * ⚠️ HOW GENUINE OVERLAP IS PROVEN (raceWithOverlapProof, below) — the crux
 * of this whole file:
 *
 *   1. Both racer calls run through the SAME shared `getDb()` pool
 *      (packages/db/src/client.ts: poolMax=5 in dev/test — comfortably >=2),
 *      fired via `Promise.allSettled([callA(), callB()])`. JS/Node semantics
 *      guarantee both start running synchronously (up to their own first
 *      `await`, i.e. each service's internal `BEGIN`) before either can
 *      finish — this is the SAME mechanism the pre-existing, shipped CI2 test
 *      (remittance.integration.test.ts) already relies on for "true
 *      concurrency", reused here verbatim because the service functions
 *      hard-code `getDb()` internally (there is no way to inject a
 *      caller-supplied PrismaClient into them without changing production
 *      code, which this task forbids) — so "two independent PrismaClient
 *      instances" from the task brief is not applicable to the racer calls
 *      themselves; it only matters for third-party observation, below.
 *
 *   2. That alone is necessary but NOT sufficient proof — Promise.allSettled
 *      merely PROVES both calls were *initiated* concurrently; it does not
 *      prove Postgres itself ever held them open at the same instant (a
 *      starved connection pool, or a freak scheduling order, could still let
 *      callA fully run BEGIN..COMMIT before callB's BEGIN is even flushed to
 *      the wire, at which point the "race" would be a silent no-op — exactly
 *      the false-positive this task warns about).
 *
 *   3. So, WHILE the race is in flight, a THIRD, independent polling loop
 *      (also over the shared pool — a plain non-transactional query, so it
 *      never competes with the two held transaction connections for a slot)
 *      repeatedly queries `pg_locks` for any OTHER backend genuinely WAITING
 *      (`granted = false`) on THE EXACT advisory lock key lockOwnerPayable
 *      itself takes for (ORG, OWNER) —
 *      `hashtext('owner-remittance:<org>:<owner>')` promoted to bigint via
 *      Postgres's implicit int4->bigint cast (the SAME promotion
 *      `pg_advisory_xact_lock(hashtext(...))` triggers in production),
 *      decomposed into the SAME (classid, objid, objsubid=1) triple
 *      `pg_locks` exposes for that overload — see
 *      `countWaitersOnOwnerRemittanceLock` below for the exact SQL and why
 *      it stays in bigint arithmetic throughout (never a signed `::int`
 *      downcast, which a negative `hashtext()` result could overflow).
 *      Scoping to this precise key (rather than the coarser
 *      `pg_stat_activity.wait_event = 'advisory'`, which matches ANY
 *      advisory-lock waiter regardless of key — this file's mechanism
 *      before Task-11 dual-review FIX-2) matters because a SECOND,
 *      unrelated advisory-lock family exists in this codebase
 *      (owner-ledger sync's per-(owner,month) lock, `owner-ledger.sync.ts`).
 *      Under `RUN_INTEGRATION=1`, `vitest.config.ts`'s
 *      `fileParallelism: false` means no other integration FILE ever runs
 *      concurrently with this one, so that family is never actually a
 *      waiter in practice while this file's race is in flight — but scoping
 *      to the exact key makes the proof airtight rather than
 *      practice-dependent. Observing a genuine ungranted wait on THIS key is
 *      STRUCTURAL proof (not a timing inference) that one racer's
 *      transaction was genuinely alive and blocked on lockOwnerPayable's
 *      exact lock for THIS (org, owner) while the OTHER racer's transaction
 *      was still open, holding it — i.e. the two transactions truly
 *      overlapped inside Postgres, and the advisory lock (not accidental
 *      ordering) is what serialized them.
 *
 *   4. Every racing test below asserts `overlap.sawAdvisoryWait === true`.
 *      This makes each test SELF-VERIFYING: if a future change ever caused
 *      the two calls to stop genuinely overlapping (pool shrunk to 1, an
 *      app-level mutex short-circuited before either reached Postgres, ...),
 *      the test would FAIL LOUDLY on that assertion — never silently
 *      degrade into the "ran sequentially, still happened to pass" shape
 *      this task explicitly calls out as a false positive.
 *
 * Local-DB safety guard + fixed disjoint org uuid ("20" prefix — grep-verified
 * absent from every other integration suite in this repo; siblings in this
 * SAME module: 15=repo,16=create,17=allocate,18=offset,19=reverse) mirrors
 * every sibling suite in apps/api/src/modules/owner-remittance/__tests__/.
 *
 * Run:
 *   export DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')
 *   export SESSION_SECRET=$(grep -E '^SESSION_SECRET=' .env | head -1 | sed -E 's/^SESSION_SECRET=//; s/^"//; s/"$//')
 *   RUN_INTEGRATION=1 npx vitest run apps/api/src/modules/owner-remittance/__tests__/concurrency.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { RemittanceCreateInput, OffsetCreateInput, ReverseInput } from "@kason/shared";
import {
  recordRemittanceService,
  recordOffsetService,
  reverseRemittanceService,
  reverseOffsetService,
} from "../owner-remittance.service";
import type { RemittanceActorCtx } from "../owner-remittance.service";
import { computeAvailableOwnerPayableC } from "../owner-remittance.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration tests must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ─── Fixed disjoint UUIDs ("20" prefix; 15=repo,16=create,17=allocate,18=offset,19=reverse) ──

const ORG = "20000000-0000-4000-8000-0000000000a1";
const ACTOR = "20000000-0000-4000-8000-0000000000a2";
const OWNER = "20000000-0000-4000-8000-0000000000a4";
const PROPERTY = "20000000-0000-4000-8000-0000000000a6";
const IVOWN_SERIES = "20000000-0000-4000-8000-0000000000b1";

const EFFECTIVE_DATE = "2026-01-01";
const PERIOD_MONTH = new Date(Date.UTC(2026, 0, 1));

// ─── Cleanup / seed (FK-safe order — reverse.integration.test.ts precedent:
// offset allocations before ledger AND before charge; remittance allocations
// before ledger AND before period; AuditLog.actor is onDelete:Restrict) ────

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerReceivableOffsetAllocation.deleteMany({ where: org });
  await db.ownerRemittanceAllocation.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.ownerStatementPeriod.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org }); // must stay empty — cleaned defensively
  await db.auditLog.deleteMany({ where: org }); // before user (Restrict FK)
  await db.property.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedOrg(currency = "MYR") {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T11 Concurrency Org",
      slug: "t11-concurrency-org",
      status: "active",
      defaultCurrency: currency,
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
}

async function seedBase() {
  const db = getDb();
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "T11 Owner", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: ACTOR,
      organizationId: ORG,
      email: "t11-actor@example.test",
      fullName: "T11 Actor",
      status: "active",
      role: "manager",
      userType: "operator",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "T11 Property",
      propertyCode: "T11-P1",
      propertyType: "apartment",
      addressLine1: "1 T11 St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.documentSeries.create({
    data: { id: IVOWN_SERIES, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
}

/** Raw-seed an active OwnerLedgerEntry income row so computeAvailableOwnerPayableC has payable to draw from (Task-5/6 precedent). */
function ledgerRowData(
  overrides: Partial<Prisma.OwnerLedgerEntryUncheckedCreateInput> &
    Pick<Prisma.OwnerLedgerEntryUncheckedCreateInput, "direction" | "category" | "amount">,
): Prisma.OwnerLedgerEntryUncheckedCreateInput {
  return {
    organizationId: ORG,
    ownerPartyId: OWNER,
    propertyId: PROPERTY,
    statementMonth: PERIOD_MONTH,
    transactionDate: PERIOD_MONTH,
    paidBy: "kaen",
    status: "active",
    createdById: ACTOR,
    updatedById: ACTOR,
    ...overrides,
  };
}

async function seedIncomeRow(amount: string) {
  const db = getDb();
  return db.ownerLedgerEntry.create({
    data: ledgerRowData({ direction: "income", category: "rental_income", amount }),
  });
}

/** Raw-seed an OwnerStatementPeriod (combined scope — apartmentId:null, this
 *  suite doesn't exercise propertyId derivation, already covered by Task 6's
 *  own suite — no real Apartment row is needed). netPayoutC defaults
 *  generous so a scenario that isn't targeting ALLOCATION_EXCEEDS_PERIOD
 *  never trips it by accident. */
async function seedPeriod(overrides: Partial<Prisma.OwnerStatementPeriodUncheckedCreateInput> = {}) {
  const db = getDb();
  return db.ownerStatementPeriod.create({
    data: {
      organizationId: ORG,
      ownerPartyId: OWNER,
      apartmentId: null,
      periodMonth: PERIOD_MONTH,
      netPayoutC: 100000,
      idempotencyKey: `t11-period-${randomUUID()}`,
      sourceMaxUpdatedAt: PERIOD_MONTH,
      ...overrides,
    },
  });
}

let chargeSeq = 0;
let docSeq = 0;

/** Raw-seed an IVOWN owner-receivable invoice: docType "invoice",
 *  ledgerTreatment "MANAGER_REVENUE", IVOWN series, partyId=OWNER, with
 *  charge-backed lines (offset.integration.test.ts precedent). */
async function seedIvownInvoice(opts: {
  lines: { amount: string }[];
}): Promise<{ documentId: string; lineIds: string[]; chargeIds: string[] }> {
  const db = getDb();
  docSeq += 1;
  const subtotal = opts.lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(2);
  const doc = await db.billingDocument.create({
    data: {
      organizationId: ORG,
      docType: "invoice",
      documentNumber: `IVOWN-T11-${docSeq}`,
      seriesId: IVOWN_SERIES,
      counterpartyType: "owner",
      partyId: OWNER,
      propertyId: PROPERTY,
      issuedById: ACTOR,
      subtotal,
      total: subtotal,
      ledgerTreatment: "MANAGER_REVENUE",
      commercialDocumentType: "OWNER_SERVICE_INVOICE",
    },
    select: { id: true },
  });
  const chargeIds: string[] = [];
  const lineIds: string[] = [];
  for (const l of opts.lines) {
    chargeSeq += 1;
    const charge = await db.charge.create({
      data: {
        organizationId: ORG,
        chargeNumber: `T11-CHG-${chargeSeq}`,
        partyId: OWNER,
        chargeType: "management_fee",
        status: "posted",
        dueDate: new Date(EFFECTIVE_DATE),
        amount: l.amount,
        currency: "MYR",
        outstandingAmount: l.amount,
        attachmentKeys: [],
      },
      select: { id: true },
    });
    chargeIds.push(charge.id);
    const line = await db.billingDocumentLine.create({
      data: { documentId: doc.id, chargeId: charge.id, description: "Management fee", amount: l.amount },
      select: { id: true },
    });
    lineIds.push(line.id);
  }
  return { documentId: doc.id, lineIds, chargeIds };
}

// Number(), not raw .toString() — Prisma's Decimal.toString() strips
// trailing zeros ("0"/"60", not "0.00"/"60.00"); offset/reverse integration
// suite precedent (matches applyAllocationToChargeTx's own read convention).
async function chargeOutstanding(chargeId: string): Promise<number> {
  const db = getDb();
  const c = await db.charge.findUniqueOrThrow({ where: { id: chargeId }, select: { outstandingAmount: true } });
  return Number(c.outstandingAmount.toString());
}

async function availableC(): Promise<number> {
  return getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
}

const actor: RemittanceActorCtx = {
  orgId: ORG,
  actorUserId: ACTOR,
  actorRole: "manager",
  ip: "127.0.0.1",
  userAgent: "vitest-t11-concurrency",
};

// ─── Genuine-overlap racing harness — see this file's header docstring for
// the full mechanism + why it's sound. ─────────────────────────────────────

interface OverlapProof<A, B> {
  results: [PromiseSettledResult<A>, PromiseSettledResult<B>];
  /** True iff the poll loop observed >=1 OTHER backend genuinely BLOCKED
   *  (pg_locks.granted=false) waiting to acquire THIS EXACT advisory lock
   *  key while the race was in flight — the structural proof that the two
   *  calls truly overlapped in Postgres on lockOwnerPayable's own lock,
   *  never a foreign advisory-lock family. */
  sawAdvisoryWait: boolean;
  samples: number;
}

/**
 * Server-side count of OTHER backends genuinely WAITING
 * (`pg_locks.granted = false` — not merely "some wait_event is set", which
 * the OLD `pg_stat_activity.wait_event = 'advisory'` poll this file used
 * before Task-11 dual-review FIX-2 could not distinguish between DIFFERENT
 * advisory keys) to acquire the EXACT advisory lock key `lockOwnerPayable`
 * itself takes for (orgId, ownerPartyId) —
 * `hashtext('owner-remittance:<org>:<owner>')`
 * (owner-remittance.repository.ts:34-40, `lockOwnerPayable`), reproduced
 * HERE via the IDENTICAL template-string construction so the hash is
 * guaranteed byte-identical to production's.
 *
 * hashtext() returns `integer` (int4); `pg_advisory_xact_lock(bigint)` is
 * the overload Postgres resolves it to (int4->bigint is an implicit numeric
 * promotion). That overload decomposes its 64-bit key into
 * `pg_locks.classid = key>>32`, `pg_locks.objid = key & 0xFFFFFFFF`,
 * `objsubid=1` (vs `objsubid=2` for the separate two-int4-arg overload —
 * verified empirically against a live lock, not assumed: source comments in
 * some Postgres references state it the other way around) — both
 * `classid`/`objid` are `oid` (UNSIGNED 32-bit, NOT `integer`). Every
 * mask below stays in bigint arithmetic and is NEVER cast down to a signed
 * `::int`: hashtext() can return a negative int4, whose sign-extended
 * bigint form would make a naive `(h & 4294967295)::int` cast overflow
 * int4's signed range roughly half the time (any hash whose low 32 bits
 * have the top bit set — a real "integer out of range" runtime error, not a
 * hypothetical). Instead, `pg_locks.classid`/`objid` are widened UP to
 * `::bigint` (safe — bigint holds oid's full unsigned range 0..4294967295)
 * for the comparison, and our own computed classid/objid are masked with
 * `& 4294967295` (never downcast), which is likewise always representable
 * as a non-negative bigint.
 *
 * Scoping to this precise key (rather than "any advisory-lock waiter in the
 * DB") matters because a SECOND, unrelated advisory-lock family exists in
 * this codebase (owner-ledger sync's per-(owner,month) lock,
 * `owner-ledger.sync.ts`) — without this scoping, a coincidental wait on
 * THAT lock would count as a false-positive "genuine overlap" for THIS
 * suite's claim about `lockOwnerPayable` specifically, even though it
 * proves nothing about it.
 */
async function countWaitersOnOwnerRemittanceLock(orgId: string, ownerPartyId: string): Promise<number> {
  const db = getDb();
  const rows = await db.$queryRaw<{ n: number }[]>`
    WITH k AS (
      SELECT hashtext(${`owner-remittance:${orgId}:${ownerPartyId}`})::bigint AS h
    )
    SELECT count(*)::int AS n
    FROM pg_locks l, k
    WHERE l.locktype = 'advisory'
      AND l.granted = false
      AND l.pid <> pg_backend_pid()
      AND l.objsubid = 1
      AND l.classid::bigint = (k.h >> 32) & 4294967295
      AND l.objid::bigint = k.h & 4294967295
  `;
  return rows[0]?.n ?? 0;
}

async function raceWithOverlapProof<A, B>(
  callA: () => Promise<A>,
  callB: () => Promise<B>,
  orgId: string = ORG,
  ownerPartyId: string = OWNER,
): Promise<OverlapProof<A, B>> {
  let sawAdvisoryWait = false;
  let samples = 0;
  let stop = false;
  const deadline = Date.now() + 15_000; // defensive cap — never poll past this regardless

  const poll = (async () => {
    while (!stop && Date.now() < deadline) {
      samples++;
      const n = await countWaitersOnOwnerRemittanceLock(orgId, ownerPartyId);
      if (n > 0) {
        sawAdvisoryWait = true;
        break;
      }
    }
  })();

  const results = (await Promise.allSettled([callA(), callB()])) as [PromiseSettledResult<A>, PromiseSettledResult<B>];
  stop = true;
  await poll;
  return { results, sawAdvisoryWait, samples };
}

function fulfilledValue<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

dn("owner-remittance — Task 11 concurrency battery (real Postgres, genuine overlap)", () => {
  beforeEach(async () => {
    process.env.ENABLE_PHASE2_OWNER_REMITTANCE = "true";
    await cleanup();
    await seedOrg();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── remit_vs_remit ────────────────────────────────────────────────────────

  it(
    "(remit_vs_remit) payable 500, two 400 remittances race — exactly one succeeds, the other OVER_REMITTANCE; final payable=100, no double-spend",
    async () => {
      await seedIncomeRow("500.00"); // availableC = 50000
      const period = await seedPeriod({ netPayoutC: 100000 }); // generous cap — isolates OVER_REMITTANCE from ALLOCATION_EXCEEDS_PERIOD

      const makeInput = (): RemittanceCreateInput => ({
        ownerPartyId: OWNER,
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        currency: "MYR",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }],
        idempotencyKey: randomUUID(), // DIFFERENT keys — two genuinely independent creates, not a replay race
      });

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => recordRemittanceService(actor, makeInput()),
        () => recordRemittanceService(actor, makeInput()),
      );
      expect(sawAdvisoryWait).toBe(true); // genuine-overlap proof (see file header)

      expect(results.every((r) => r.status === "fulfilled")).toBe(true); // never a crash — guard breach is a returned {ok:false}, not a throw
      const outcomes = results.map(fulfilledValue);
      const successes = outcomes.filter((o) => o?.ok === true);
      const failures = outcomes.filter((o) => o?.ok === false);
      expect(successes).toHaveLength(1); // exactly one succeeds
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok === false && failures[0].error).toBe("OVER_REMITTANCE");

      // Final DB state reflects EXACTLY ONE application — never negative, never both.
      expect(await availableC()).toBe(10000); // 50000 - 40000 = 100.00
      const db = getDb();
      expect(
        await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } }),
      ).toBe(1);
      expect(await db.ownerRemittanceAllocation.count({ where: { organizationId: ORG } })).toBe(1);
    },
    20_000,
  );

  // ── remit_vs_offset ───────────────────────────────────────────────────────

  it(
    "(remit_vs_offset) payable 100, a 100 remittance races a 100 offset on the SAME owner — exactly one succeeds, the loser's OWN over-payable guard rejects it",
    async () => {
      await seedIncomeRow("100.00"); // availableC = 10000
      const period = await seedPeriod({ netPayoutC: 100000 }); // generous — isolates the PAYABLE guard from ALLOCATION_EXCEEDS_PERIOD
      const inv = await seedIvownInvoice({ lines: [{ amount: "100.00" }] });

      const remitInput: RemittanceCreateInput = {
        ownerPartyId: OWNER,
        amount: "100.00",
        effectiveDate: EFFECTIVE_DATE,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        currency: "MYR",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
        idempotencyKey: randomUUID(),
      };
      const offsetInput: OffsetCreateInput = {
        ownerPartyId: OWNER,
        effectiveDate: EFFECTIVE_DATE,
        currency: "MYR",
        lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }],
        idempotencyKey: randomUUID(),
      };

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => recordRemittanceService(actor, remitInput),
        () => recordOffsetService(actor, offsetInput),
      );
      expect(sawAdvisoryWait).toBe(true);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const remitOutcome = fulfilledValue(results[0]);
      const offsetOutcome = fulfilledValue(results[1]);
      expect(remitOutcome).not.toBeNull();
      expect(offsetOutcome).not.toBeNull();

      // Exactly one of the two settlement types succeeded — never both, never neither.
      const bothSucceeded = remitOutcome?.ok === true && offsetOutcome?.ok === true;
      const bothFailed = remitOutcome?.ok === false && offsetOutcome?.ok === false;
      expect(bothSucceeded).toBe(false);
      expect(bothFailed).toBe(false);

      const db = getDb();
      if (remitOutcome?.ok === true) {
        // remittance won — offset must have lost to its OWN over-payable guard, charge untouched.
        expect(offsetOutcome?.ok === false && offsetOutcome.error).toBe("OFFSET_EXCEEDS_PAYABLE");
        expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(100); // untouched
        expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } })).toBe(1);
        expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(0);
      } else {
        // offset won — remittance must have lost to OVER_REMITTANCE, charge fully settled.
        expect(offsetOutcome?.ok).toBe(true);
        expect(remitOutcome?.ok === false && remitOutcome.error).toBe("OVER_REMITTANCE");
        expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
        expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } })).toBe(0);
        expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(1);
      }

      // Final payable — EXACTLY once-applied regardless of which side won. Never negative.
      expect(await availableC()).toBe(0);
    },
    20_000,
  );

  // ── offset_vs_offset ──────────────────────────────────────────────────────

  it(
    "(offset_vs_offset) one IVOWN line outstanding 100, two 100 offsets race it — exactly one settles the line, the other OFFSET_EXCEEDS_LINE_OUTSTANDING; no over-settle/negative",
    async () => {
      await seedIncomeRow("1000.00"); // availableC = 100000 — plenty; isolates the LINE guard from OFFSET_EXCEEDS_PAYABLE
      const inv = await seedIvownInvoice({ lines: [{ amount: "100.00" }] });

      const makeInput = (): OffsetCreateInput => ({
        ownerPartyId: OWNER,
        effectiveDate: EFFECTIVE_DATE,
        currency: "MYR",
        lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }],
        idempotencyKey: randomUUID(),
      });

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => recordOffsetService(actor, makeInput()),
        () => recordOffsetService(actor, makeInput()),
      );
      expect(sawAdvisoryWait).toBe(true);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const outcomes = results.map(fulfilledValue);
      const successes = outcomes.filter((o) => o?.ok === true);
      const failures = outcomes.filter((o) => o?.ok === false);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok === false && failures[0].error).toBe("OFFSET_EXCEEDS_LINE_OUTSTANDING");

      // The line settled EXACTLY once — never negative, never double-settled.
      expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
      const db = getDb();
      expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(1);
      expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(1);
      expect(await availableC()).toBe(90000); // 100000 - 10000, exactly once
    },
    20_000,
  );

  // ── offset_payable_contention (formerly partial_multi_offset) ────────────
  //
  // Task-11 dual-review FIX-1: the ORIGINAL version of this test seeded
  // netPayoutC-generous payable (1000.00) against a combined draw of only
  // 190.00 (60+80 disjoint-charge offset A + 50 disjoint-charge offset B) —
  // payable so hugely exceeded the draw that OFFSET_EXCEEDS_PAYABLE could
  // NEVER bind, under ANY interleaving, even with lockOwnerPayable removed
  // entirely. Both offsets ALWAYS succeeded regardless of locking, so the
  // test proved a tautology, not a concurrency invariant — its only tie to
  // lock-safety was the (unfalsifiable-by-money-state) sawAdvisoryWait flag.
  //
  // Re-dimensioned here so the two DISJOINT-charge offsets genuinely CONTEND
  // on the SHARED owner-level payable: seeded payable covers the larger of
  // the two offsets ALONE but never both combined — the classic lost-update
  // shape (two debits racing one shared resource), same family as
  // remit_vs_remit/offset_vs_offset above, just applied to
  // OFFSET_EXCEEDS_PAYABLE specifically rather than a per-charge/per-period
  // guard. See task-11-report.md's "Fix report" section for the RED/GREEN +
  // sabotage evidence this re-dimensioning was verified against.

  it(
    "(offset_payable_contention) two offsets on DISJOINT charges, payable covers exactly ONE — the other OFFSET_EXCEEDS_PAYABLE; winner's charge settled, loser's charge UNTOUCHED, no lost update",
    async () => {
      // Payable (140.00) covers A(140.00) ALONE or B(50.00) ALONE, but NEVER
      // both combined (190.00). The two offsets target DISJOINT charges (no
      // per-charge contention), so OFFSET_EXCEEDS_PAYABLE is the ONLY thing
      // that can reject either one — and it can only do so correctly if the
      // shared owner-level payable read is genuinely serialized against the
      // other call's write. WITHOUT lockOwnerPayable serializing
      // read+guard+write, both calls could read the SAME pre-drawdown
      // 140.00 concurrently, both pass their own amountC<=availableC check
      // (140<=140 and 50<=140), and BOTH would write — the money-state
      // assertions below (not just sawAdvisoryWait) are what catch that.
      await seedIncomeRow("140.00"); // availableC = 14000
      const invA = await seedIvownInvoice({ lines: [{ amount: "140.00" }] });
      const invB = await seedIvownInvoice({ lines: [{ amount: "50.00" }] });

      const inputA: OffsetCreateInput = {
        ownerPartyId: OWNER,
        effectiveDate: EFFECTIVE_DATE,
        currency: "MYR",
        lineAllocations: [{ billingDocumentLineId: invA.lineIds[0]!, allocatedAmount: "140.00" }],
        idempotencyKey: randomUUID(),
      };
      const inputB: OffsetCreateInput = {
        ownerPartyId: OWNER,
        effectiveDate: EFFECTIVE_DATE,
        currency: "MYR",
        // DISJOINT charge from A — the ONLY shared resource is the payable.
        lineAllocations: [{ billingDocumentLineId: invB.lineIds[0]!, allocatedAmount: "50.00" }],
        idempotencyKey: randomUUID(),
      };

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => recordOffsetService(actor, inputA),
        () => recordOffsetService(actor, inputB),
      );
      expect(sawAdvisoryWait).toBe(true); // genuine-overlap proof (see file header)

      expect(results.every((r) => r.status === "fulfilled")).toBe(true); // never a crash — guard breach is a returned {ok:false}, not a throw
      const aOutcome = fulfilledValue(results[0]);
      const bOutcome = fulfilledValue(results[1]);

      // *** Lock-removal-detectable on THEIR OWN, independent of
      // sawAdvisoryWait: without serialization BOTH would succeed here
      // (successes.length===2), not exactly one. (Verified by sabotage —
      // task-11-report.md.)
      const successes = [aOutcome, bOutcome].filter((o) => o?.ok === true);
      const failures = [aOutcome, bOutcome].filter((o) => o?.ok === false);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok === false && failures[0].error).toBe("OFFSET_EXCEEDS_PAYABLE");

      const db = getDb();
      const finalC = await availableC();
      // A removed lock would drive this to 14000-14000-5000 = -5000 (negative).
      expect(finalC).toBeGreaterThanOrEqual(0);
      if (aOutcome?.ok === true) {
        // A won — its charge settled; B (the loser) UNTOUCHED.
        expect(await chargeOutstanding(invA.chargeIds[0]!)).toBe(0);
        expect(await chargeOutstanding(invB.chargeIds[0]!)).toBe(50);
        expect(finalC).toBe(0); // 14000 - 14000, EXACTLY once
      } else {
        expect(bOutcome?.ok).toBe(true);
        expect(await chargeOutstanding(invB.chargeIds[0]!)).toBe(0);
        expect(await chargeOutstanding(invA.chargeIds[0]!)).toBe(140);
        expect(finalC).toBe(9000); // 14000 - 5000, EXACTLY once
      }

      // Exactly one OWNER_RECEIVABLE_OFFSET entry — a removed lock's
      // double-success would produce two.
      expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_RECEIVABLE_OFFSET" } })).toBe(1);
      expect(await db.ownerReceivableOffsetAllocation.count({ where: { organizationId: ORG } })).toBe(1);
    },
    20_000,
  );

  // ── reverse_exactly_once (remittance) ─────────────────────────────────────

  it(
    "(reverse_exactly_once) concurrent double-reverse of a remittance — exactly one succeeds, the other ALREADY_REVERSED; payable restored exactly once",
    async () => {
      await seedIncomeRow("1000.00");
      const period = await seedPeriod({ netPayoutC: 100000 });
      const create = await recordRemittanceService(actor, {
        ownerPartyId: OWNER,
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        currency: "MYR",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }],
        idempotencyKey: randomUUID(),
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;
      const originalId = create.data.entryId;
      expect(await availableC()).toBe(60000); // 100000 - 40000

      const makeReverse = (): ReverseInput => ({ reason: "T11 concurrent reverse", idempotencyKey: randomUUID() });

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => reverseRemittanceService(actor, originalId, makeReverse()),
        () => reverseRemittanceService(actor, originalId, makeReverse()),
      );
      expect(sawAdvisoryWait).toBe(true);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const outcomes = results.map(fulfilledValue);
      const successes = outcomes.filter((o) => o?.ok === true);
      const failures = outcomes.filter((o) => o?.ok === false);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok === false && failures[0].error).toBe("ALREADY_REVERSED");

      // Restored EXACTLY once — never double-restored to 140000.
      expect(await availableC()).toBe(100000);
      const db = getDb();
      expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } })).toBe(1);
    },
    20_000,
  );

  // ── reverse_exactly_once (offset) ─────────────────────────────────────────

  it(
    "(reverse_exactly_once) concurrent double-reverse of an offset — exactly one succeeds, the other ALREADY_REVERSED; payable AND line outstanding EACH restored exactly once",
    async () => {
      await seedIncomeRow("500.00");
      const inv = await seedIvownInvoice({ lines: [{ amount: "100.00" }] });
      const create = await recordOffsetService(actor, {
        ownerPartyId: OWNER,
        effectiveDate: EFFECTIVE_DATE,
        currency: "MYR",
        lineAllocations: [{ billingDocumentLineId: inv.lineIds[0]!, allocatedAmount: "100.00" }],
        idempotencyKey: randomUUID(),
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;
      const originalId = create.data.entryId;
      expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(0);
      expect(await availableC()).toBe(40000); // 50000 - 10000

      const makeReverse = (): ReverseInput => ({ reason: "T11 concurrent offset reverse", idempotencyKey: randomUUID() });

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => reverseOffsetService(actor, originalId, makeReverse()),
        () => reverseOffsetService(actor, originalId, makeReverse()),
      );
      expect(sawAdvisoryWait).toBe(true);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const outcomes = results.map(fulfilledValue);
      const successes = outcomes.filter((o) => o?.ok === true);
      const failures = outcomes.filter((o) => o?.ok === false);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok === false && failures[0].error).toBe("ALREADY_REVERSED");

      expect(await availableC()).toBe(50000); // restored exactly once
      expect(await chargeOutstanding(inv.chargeIds[0]!)).toBe(100); // restored exactly once — never 200
      const db = getDb();
      expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } })).toBe(1);
    },
    20_000,
  );

  // ── idempotency_mismatch ──────────────────────────────────────────────────

  it(
    "(idempotency_mismatch) SAME idempotencyKey + a DIFFERENT payload raced — exactly one succeeds, the other 409 IDEMPOTENCY_KEY_REUSED, nothing extra written",
    async () => {
      await seedIncomeRow("1000.00"); // availableC = 100000 — plenty for either amount alone (never confounds with OVER_REMITTANCE)
      const period = await seedPeriod({ netPayoutC: 100000 });
      const sharedKey = randomUUID();

      const inputA: RemittanceCreateInput = {
        ownerPartyId: OWNER,
        amount: "100.00",
        effectiveDate: EFFECTIVE_DATE,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        currency: "MYR",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "100.00" }],
        idempotencyKey: sharedKey,
      };
      const inputB: RemittanceCreateInput = {
        ...inputA,
        amount: "150.00", // genuinely DIFFERENT payload -> different fingerprint
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "150.00" }],
        idempotencyKey: sharedKey, // SAME key
      };

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => recordRemittanceService(actor, inputA),
        () => recordRemittanceService(actor, inputB),
      );
      expect(sawAdvisoryWait).toBe(true);

      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const outcomes = results.map(fulfilledValue);
      const successes = outcomes.filter((o) => o?.ok === true);
      const failures = outcomes.filter((o) => o?.ok === false);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.ok === false && failures[0].error).toBe("IDEMPOTENCY_KEY_REUSED");

      // Exactly ONE row under this idempotencyKey — never two, never zero.
      const db = getDb();
      expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, idempotencyKey: sharedKey } })).toBe(1);
    },
    20_000,
  );

  // ── create_vs_reverse ──────────────────────────────────────────────────────
  //
  // Task-11 dual-review FIX-3: lockOwnerPayable's own docstring
  // (owner-remittance.repository.ts:22-33) claims it "serializes ALL of an
  // owner's remittance/offset/reversal writes against each other" — but
  // until now this battery only ever raced create-vs-create
  // (remit_vs_remit/remit_vs_offset/offset_vs_offset/offset_payable_
  // contention) and reverse-vs-reverse (reverse_exactly_once ×2), never
  // create-vs-REVERSE. This closes that gap.

  it(
    "(create_vs_reverse) reverseRemittanceService(E) races a NEW 400 remittance F on the SAME owner — final payable matches EXACTLY ONE valid serialization order, never a torn third value",
    async () => {
      await seedIncomeRow("700.00"); // X = availableC = 70000
      const period = await seedPeriod({ netPayoutC: 100000 }); // generous — never the bottleneck in EITHER branch below (isolates OVER_REMITTANCE, the owner-level payable guard under test, from ALLOCATION_EXCEEDS_PERIOD)

      const create = await recordRemittanceService(actor, {
        ownerPartyId: OWNER,
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        currency: "MYR",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }],
        idempotencyKey: randomUUID(),
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;
      const originalId = create.data.entryId;
      expect(await availableC()).toBe(30000); // X - E = 70000 - 40000 — the pre-race state both racers start from

      // Amount choice is deliberate, not arbitrary — it makes F's own
      // OVER_REMITTANCE outcome a REAL function of which racer the advisory
      // lock admits first (proving genuine ordering-dependence, not a
      // tautology where F would succeed/fail the same way regardless of
      // order — the SAME rigor concern FIX-1 raised against the old
      // partial_multi_offset): F=400.00 EXCEEDS the pre-reversal payable
      // (30000) but FITS the post-reversal payable (70000) —
      // 30000 < 40000 <= 70000.
      //   - reverse-then-F: reverse restores payable to 70000 FIRST; F then
      //     sees 70000>=40000 -> F SUCCEEDS. Final payable=70000-40000=30000.
      //   - F-then-reverse: F sees the NOT-YET-restored 30000<40000 -> F
      //     FAILS (OVER_REMITTANCE, nothing written). reverse proceeds
      //     regardless — it never reads payable at all (reverseRemittanceService
      //     only checks the entry's OWN lifecycle state: active, not a
      //     reversal-of-a-reversal, not already reversed). Final payable=70000.
      // Both are valid outcomes of a genuinely serialized race — the
      // invariant under test is that the final state is ALWAYS EXACTLY one
      // of these two, never a third, torn value (e.g. F reading the stale
      // 30000 yet still being permitted to commit — a lost update).
      const newRemittanceInput: RemittanceCreateInput = {
        ownerPartyId: OWNER,
        amount: "400.00",
        effectiveDate: EFFECTIVE_DATE,
        settlementKind: "OWNER_REMITTANCE",
        paymentMethod: "cash",
        currency: "MYR",
        allocations: [{ ownerStatementPeriodId: period.id, allocatedAmount: "400.00" }],
        idempotencyKey: randomUUID(),
      };
      const reverseInput: ReverseInput = { reason: "T11 create-vs-reverse race", idempotencyKey: randomUUID() };

      const { results, sawAdvisoryWait } = await raceWithOverlapProof(
        () => reverseRemittanceService(actor, originalId, reverseInput),
        () => recordRemittanceService(actor, newRemittanceInput),
      );
      expect(sawAdvisoryWait).toBe(true); // genuine-overlap proof (see file header)

      expect(results.every((r) => r.status === "fulfilled")).toBe(true); // OVER_REMITTANCE is a returned {ok:false}, never a throw/crash
      const reverseOutcome = fulfilledValue(results[0]);
      const newRemitOutcome = fulfilledValue(results[1]);

      // The reversal has NO guard tied to payable (only its own lifecycle
      // state) — it must ALWAYS succeed, regardless of race order.
      expect(reverseOutcome?.ok).toBe(true);

      const db = getDb();
      // Reversal's effect applied EXACTLY once regardless of order.
      expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, reversalOfEntryId: originalId } })).toBe(1);

      const finalC = await availableC();
      expect(finalC).toBeGreaterThanOrEqual(0);
      expect(finalC === 30000 || finalC === 70000).toBe(true); // NEVER a torn third value

      if (newRemitOutcome?.ok === true) {
        // F won — evaluated AFTER the reversal had already committed.
        expect(finalC).toBe(30000); // 70000 (restored) - 40000 (F)
        expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } })).toBe(3); // E + reverse-of-E + F
        expect(
          await db.ownerRemittanceAllocation.count({ where: { organizationId: ORG, ownerStatementPeriodId: period.id } }),
        ).toBe(2); // E's + F's
      } else {
        // F lost — evaluated against the NOT-YET-restored payable, a
        // genuinely order-dependent OVER_REMITTANCE (not a fixed guard).
        expect(newRemitOutcome?.ok === false && newRemitOutcome.error).toBe("OVER_REMITTANCE");
        expect(finalC).toBe(70000); // fully restored; F drew nothing
        expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, settlementKind: "OWNER_REMITTANCE" } })).toBe(2); // E + reverse-of-E only
        expect(
          await db.ownerRemittanceAllocation.count({ where: { organizationId: ORG, ownerStatementPeriodId: period.id } }),
        ).toBe(1); // E's only
      }
    },
    20_000,
  );
});
