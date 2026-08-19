/**
 * STATIC GUARD — every `PaymentAllocation` read must declare what it means.
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 * Portal payments mint `PaymentAllocation` rows at INITIATE, before the bank has
 * confirmed anything, and expiry/failure/rejection never remove them. So the row
 * "an allocation exists on this charge" does NOT mean "money arrived" — and any
 * reader that assumes it does silently counts cash that never showed up.
 *
 * That mistake has been made repeatedly and expensively. It reached:
 *   - the bills grid (false part-paid, locked rows, blocked re-Bill),
 *   - the owner ledger (a landlord paid out on rent that was never collected),
 *   - the refund path (a Refund Note booked against a payment that never settled),
 *   - and R5 reconciliation itself, where a phantom made both sides of the
 *     identity agree on a wrong number — so the check PASSED on a broken charge,
 *     which is worse than failing, because reconciliation is the thing that is
 *     supposed to catch exactly this.
 *
 * Fixing the sites one at a time does not hold: the next new reader reintroduces
 * it. `CASH_ALLOCATION_WHERE` gives the predicate one definition; this test makes
 * USING it (or consciously not) mandatory, by failing the moment an unclassified
 * read appears.
 *
 * ── How to satisfy it ────────────────────────────────────────────────────────
 * A read passes if it does one of these, all of which are visible at the call:
 *   CASH        — spreads `CASH_ALLOCATION_WHERE`, or filters the payment status
 *                 inline. Means "money that actually arrived".
 *   CLAIM       — spreads `AWAITING_VERIFICATION_WHERE`, or deliberately selects
 *                 non-posted payments. Means "an unverified claim on money".
 *   PER_PAYMENT — scoped by `paymentId`/`id`, so the caller already knows and has
 *                 checked which payment it is holding.
 *   BROAD_SET   — deliberately unfiltered because the id set feeds a reversal
 *                 lookup that must span every allocation; the cash filter is then
 *                 applied per-row in code. Requires `select`ing the payment status
 *                 so the filtering is actually possible.
 *
 * If you are adding a read and none of these fit, that is the signal to stop and
 * decide what your read MEANS — not to widen this test.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..", "..", "..");
/**
 * Shared packages are scanned too. Nothing there reads allocations TODAY, but
 * `@kason/db` is exactly where a "helpful" shared query helper would land, and a
 * guard that stops at the app boundary would never see it.
 */
const PACKAGES_SRC = join(API_SRC, "..", "..", "..", "packages");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist" || entry === "generated") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Slice out the text of a `paymentAllocation.<method>(...)` call by walking
 * braces/parens from the call site. Good enough to see the `where`/`select` of a
 * single call without pulling in a parser.
 */
function extractCall(source: string, startIndex: number): string {
  let depth = 0;
  let i = source.indexOf("(", startIndex);
  if (i === -1) return "";
  const from = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

type Classification = "CASH" | "CLAIM" | "PER_PAYMENT" | "BROAD_SET" | "UNCLASSIFIED";

/**
 * Slice out a `<key>: { ... }` block with real brace matching.
 *
 * The classifier used to reach into blocks with `[^}]*`, which cannot cross a
 * nested `}`. That cut both ways: a genuine cash read whose `payment: {` block
 * happened to contain any nested object BEFORE `status` was reported as
 * unclassified (a false alarm the guard would have been blamed for), and a
 * dangerous predicate sitting after a nested object was invisible.
 */
function extractBlock(source: string, key: string, open = "{", close = "}"): string | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*\\${open}`).exec(source);
  if (!m) return null;
  let depth = 0;
  const from = source.indexOf(open, m.index);
  for (let i = from; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return source.slice(from);
}

/**
 * The whole negated region, whichever form it takes. Prisma accepts `NOT` as an
 * object OR an array, and matching only the object form left the array spelling
 * classifying as CASH — the same inversion the object-form fix targeted.
 */
function extractNegated(call: string): string | null {
  return extractBlock(call, "NOT") ?? extractBlock(call, "NOT", "[", "]");
}

function classify(call: string): Classification {
  if (call.includes("CASH_ALLOCATION_WHERE")) return "CASH";
  if (call.includes("AWAITING_VERIFICATION_WHERE")) return "CLAIM";
  // "A claim exists that the tenant must not pay over the top of" — the
  // double-submit guard. Broader than AWAITING_VERIFICATION_WHERE by one status
  // (`needs_reconciliation`, where the gateway confirmed the payment and the
  // payer has almost certainly been debited).
  if (call.includes("BLOCKS_FURTHER_PAYMENT_WHERE")) return "CLAIM";
  // A `posted` predicate sitting under a NOT means the EXACT OPPOSITE of cash —
  // it selects everything that never settled. Reading that as CASH was the worst
  // misclassification available: the guard would have blessed a read counting
  // only phantom money, and the per-file CASH pin below would have accepted it.
  // So the negated region is cut out BEFORE looking for the predicate, and only
  // what survives can earn a CASH verdict.
  const negated = extractNegated(call);
  const unnegated = negated ? call.replace(negated, "") : call;

  // BROAD_SET must be tested BEFORE the generic inline-status check: selecting
  // `payment: { select: { status } }` also matches "payment object mentioning
  // status", and being read as a CLAIM would hide a deliberate broad fetch.
  const paymentBlock = extractBlock(unnegated, "payment");
  if (paymentBlock && /\bselect\s*:\s*\{/.test(paymentBlock) && /\bstatus\b/.test(paymentBlock)) {
    return "BROAD_SET";
  }
  // An inline payment-status PREDICATE (a where clause), either direction.
  if (paymentBlock && /\bstatus\b/.test(paymentBlock)) {
    return /status:\s*["']posted["']/.test(paymentBlock) ? "CASH" : "CLAIM";
  }
  // Only a NEGATED payment predicate — deliberately not-cash.
  if (negated && /payment:\s*\{/.test(negated) && /\bstatus\b/.test(negated)) return "CLAIM";
  // Scoped to one payment the caller already resolved.
  //
  // Anchored to the `where`. The rule is "the caller has already resolved and
  // checked WHICH payment this is", and only a predicate can establish that —
  // `select: { paymentId: true }` merely reads the column back, so letting it
  // satisfy this rule waved through org-wide unfiltered cash reads.
  const whereBlock = extractBlock(call, "where");
  if (whereBlock && /\bpaymentId\b\s*:/.test(whereBlock)) {
    // A BULK id set is not a per-payment scope. The rule's justification is "the
    // caller already knows and has CHECKED which payment it is holding", and
    // `paymentId: { in: [...] }` does not establish that — it is an unbounded set
    // of payments whose statuses nobody looked at, i.e. a cash read wearing a
    // per-payment label.
    if (/\bpaymentId\b\s*:\s*\{\s*in\b/.test(whereBlock)) return "UNCLASSIFIED";
    return "PER_PAYMENT";
  }
  return "UNCLASSIFIED";
}

const READ_METHODS = ["findMany", "findFirst", "findUnique", "groupBy", "aggregate", "count"];

/**
 * Allocations reached through a RELATION rather than the delegate — e.g.
 * `charge.findMany({ include: { allocations: {...} } })`. The walker used to
 * match only `paymentAllocation.<method>`, so every one of these was invisible
 * to the guard even though the rows they return are exactly the same rows.
 *
 * The classification rule is structural, not a list that goes stale: allocations
 * nested inside a `payment.<read>` are PER_PAYMENT by construction — they are
 * being read as the children of their own payment, so whoever consumes them has
 * that payment's status in hand and cannot mistake a claim for cash. Nested
 * under anything else (a charge, an invoice, a party) the payment status is NOT
 * in scope, and the read has to say what it means like any other.
 */
function findEnclosingDelegate(source: string, at: number): string | null {
  const head = source.slice(Math.max(0, at - 4000), at);
  const matches = [...head.matchAll(/\b(?:db|tx|prisma)\.([A-Za-z]+)\.(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|groupBy|aggregate|count|update|updateMany|create|createMany|delete|deleteMany|upsert)\s*\(/g)];
  return matches.length ? (matches[matches.length - 1][1] as string) : null;
}

function collectReads() {
  const found: { file: string; classification: Classification; snippet: string }[] = [];
  const files = [...walk(API_SRC), ...walk(PACKAGES_SRC)];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const label = file.startsWith(API_SRC) ? file.slice(API_SRC.length + 1) : file.slice(file.indexOf("packages"));

    for (const method of READ_METHODS) {
      // Substring match, so findFirstOrThrow / findUniqueOrThrow are caught too.
      const needle = `paymentAllocation.${method}`;
      let idx = source.indexOf(needle);
      while (idx !== -1) {
        const call = extractCall(source, idx);
        found.push({ file: label, classification: classify(call), snippet: call.replace(/\s+/g, " ").slice(0, 160) });
        idx = source.indexOf(needle, idx + needle.length);
      }
    }

    // Relation reads. `allocations` is a relation name on THREE unrelated models
    // (SupplierExpense → SupplierExpenseAllocation, UnitUtilityBill →
    // UtilityAllocation, and the two below), so matching the field name alone
    // conflates domains by name similarity. Per schema.prisma, exactly these
    // models own a `PaymentAllocation[]`:
    //   Charge.allocations, Payment.allocations, Organization.paymentAllocations
    // Payment's is skipped — PER_PAYMENT by construction, see above.
    for (const m of source.matchAll(/\b(allocations|paymentAllocations)\s*:\s*\{/g)) {
      const field = m[1] as string;
      const model = findEnclosingDelegate(source, m.index);
      const owns =
        (field === "allocations" && model === "charge") ||
        (field === "paymentAllocations" && model === "organization");
      if (!owns) continue;
      const block = extractBlock(source.slice(m.index), field) ?? "";
      // A type annotation (`allocations: { chargeId: string }[]`) is not a query;
      // only a block carrying Prisma query keys is.
      if (!/\b(select|include|where|orderBy|some|every|none|take|skip)\s*:/.test(block)) continue;
      found.push({
        file: label,
        classification: classify(block),
        snippet: `via ${model}.${field} relation: ${block.replace(/\s+/g, " ").slice(0, 140)}`,
      });
    }

    // Raw SQL over the table. Invisible to every rule above, and the one place
    // where "just add a join" quietly bypasses the whole predicate. Scoped to
    // statements that actually read or write ROWS — a bare table name in a
    // TRUNCATE list (the seed's reset) touches no allocation semantics.
    for (const m of source.matchAll(/"PaymentAllocation"/g)) {
      const head = source.slice(Math.max(0, m.index - 400), m.index);
      if (!/\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/.test(head)) continue;
      if (!/\b(FROM|JOIN|UPDATE|INSERT\s+INTO)\s*$/i.test(head.replace(/\s+$/, "") + " ")) continue;
      const stmt = source.slice(m.index, m.index + 600);
      const meansCash = /status\s*=\s*'posted'/i.test(stmt);
      found.push({
        file: label,
        classification: meansCash ? "CASH" : "UNCLASSIFIED",
        snippet: `raw SQL: ${stmt.replace(/\s+/g, " ").slice(0, 140)}`,
      });
    }
  }
  return found;
}

/**
 * The classifier's OWN behaviour, pinned against inline fixtures.
 *
 * A static guard's real failure mode is not a false alarm — it is passing
 * because it silently matches nothing, or because it reads a dangerous call as a
 * safe one. The sweep below can only ever report on the code that exists today;
 * these fixtures are the ones that must stay caught even when no such call is in
 * the tree. Each was a demonstrated hole in the previous version.
 */
describe("the classifier itself", () => {
  it("does NOT let `select: { paymentId }` pose as a per-payment scope", () => {
    // The rule means "the caller already knows WHICH payment this is", and only
    // a predicate establishes that. Reading the column back does not — this is
    // an org-wide unfiltered cash read and must be rejected.
    expect(
      classify(`({ where: { organizationId: orgId }, select: { paymentId: true, allocatedAmount: true } })`),
    ).toBe("UNCLASSIFIED");
    expect(classify(`({ where: { paymentId: id } })`)).toBe("PER_PAYMENT");
  });

  it("reads a NEGATED posted predicate as a CLAIM, never as cash", () => {
    // `NOT: { payment: { status: "posted" } }` selects everything that never
    // settled — the exact opposite of cash. Classifying it CASH would have let
    // the per-file pin below bless a read that counts only phantom money.
    expect(classify(`({ where: { NOT: { payment: { status: "posted" } } } })`)).toBe("CLAIM");
    // Prisma accepts NOT as an ARRAY too, and matching only the object form left
    // the array spelling classifying as CASH — the same inversion, respelled.
    expect(classify(`({ where: { NOT: [{ payment: { status: "posted" } }] } })`)).toBe("CLAIM");
    expect(classify(`({ where: { payment: { status: "posted" } } })`)).toBe("CASH");
  });

  it("does NOT let a BULK paymentId set pose as a per-payment scope", () => {
    // The rule means the caller has already checked WHICH payment it holds. An
    // unbounded id set establishes nothing of the sort — it is a cash read
    // wearing a per-payment label.
    expect(classify(`({ where: { paymentId: { in: ids } } })`)).toBe("UNCLASSIFIED");
    expect(classify(`({ where: { paymentId: id } })`)).toBe("PER_PAYMENT");
  });

  it("sees a status predicate that sits AFTER a nested object", () => {
    // The old `[^}]*` reach could not cross a nested `}`, so a genuine cash read
    // was reported as unclassified purely because of key order.
    expect(
      classify(`({ where: { payment: { organization: { id: orgId }, status: "posted" } } })`),
    ).toBe("CASH");
  });

  it("still recognises the shared predicates by name", () => {
    expect(classify(`({ where: { ...CASH_ALLOCATION_WHERE } })`)).toBe("CASH");
    expect(classify(`({ where: { ...AWAITING_VERIFICATION_WHERE } })`)).toBe("CLAIM");
    expect(classify(`({ where: { ...BLOCKS_FURTHER_PAYMENT_WHERE } })`)).toBe("CLAIM");
    expect(classify(`({ select: { payment: { select: { status: true } } } })`)).toBe("BROAD_SET");
  });
});

describe("PaymentAllocation reads — every one declares what it means", () => {
  it("finds the reads at all (guards against the walker silently matching nothing)", () => {
    const reads = collectReads();
    // A regex/path change that quietly stops matching would make this whole file
    // a no-op that still reports green. Require a realistic floor.
    expect(reads.length).toBeGreaterThanOrEqual(15);
  });

  it("has ZERO unclassified reads", () => {
    const unclassified = collectReads().filter((r) => r.classification === "UNCLASSIFIED");

    // Printed rather than counted, so a failure names the exact call to fix
    // instead of just moving a number.
    expect(
      unclassified.map((r) => `${r.file}\n      ${r.snippet}`),
      "An allocation read must say whether it means CASH (spread CASH_ALLOCATION_WHERE), " +
        "a CLAIM (AWAITING_VERIFICATION_WHERE), one PER_PAYMENT row (scope by paymentId), " +
        "or a deliberate BROAD_SET (select payment.status and filter in code).",
    ).toEqual([]);
  });

  it("keeps the owner-money and correction paths on the cash predicate", () => {
    // The four sites that were unfiltered and moved real money or hid a real
    // break. Pinned by name so a refactor cannot quietly drop the filter.
    const byFile = new Map<string, Classification[]>();
    for (const r of collectReads()) {
      byFile.set(r.file, [...(byFile.get(r.file) ?? []), r.classification]);
    }

    const mustBeCashOrBroad = [
      "modules/owner-ledger/prior-period-collection.ts",
      "modules/owner-ledger/reconciliation/source-to-ledger.ts",
      "modules/owner-ledger/reconciliation/preflight.ts",
      "modules/billing-documents/correction-replace.service.ts",
      "modules/billing-documents/credit-notes.service.ts",
      // The commission write-lock. Reading a phantom allocation as cash here
      // freezes firstMonthIsCommission/commissionSstBearer on money that never
      // arrived — and until 2026-08-18 that lock had no in-app release.
      "modules/tenancy/commission-guard.ts",
    ];

    for (const file of mustBeCashOrBroad) {
      const classifications = byFile.get(file);
      expect(classifications, `${file} should still contain a PaymentAllocation read`).toBeDefined();
      for (const c of classifications ?? []) {
        expect(["CASH", "BROAD_SET"], `${file} read must mean cash, got ${c}`).toContain(c);
      }
    }
  });
});
