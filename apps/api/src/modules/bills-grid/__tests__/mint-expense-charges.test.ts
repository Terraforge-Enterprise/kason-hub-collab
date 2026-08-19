import { describe, it, expect, vi, beforeEach } from "vitest";

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("../../../lib/feature-flags", () => ({
  isPhase2FlagEnabled: (f: string) => (f === "ENABLE_BILL_EXPENSES_AS_CHARGES" ? flag.on : false),
}));
vi.mock("../../charge-categories/seed", () => ({ ensureChargeCategorySeeds: vi.fn().mockResolvedValue(undefined) }));

import { mintExpenseChargesTx } from "../service";

function makeTx(opts: { expenses: any[]; tenancy?: any; owner?: any; pickedCats?: any[] }) {
  const created: any[] = [];
  return {
    created,
    tx: {
      gridExpense: { findMany: vi.fn().mockResolvedValue(opts.expenses) },
      chargeCategory: { findMany: vi.fn().mockResolvedValue([
        { id: "cat-oe-t", code: "other_expense_tenant", family: "tenant_income", docType: "invoice" },
        { id: "cat-oe-o", code: "other_expense_owner", family: "owner_income", docType: "invoice" },
        ...(opts.pickedCats ?? []),
      ]) },
      tenancy: { findFirst: vi.fn().mockResolvedValue(opts.tenancy ?? null) },
      apartment: { findFirst: vi.fn().mockResolvedValue(opts.owner ? { listings: [{ id: "L-owner", ownerPartyId: "P-owner" }] } : { listings: [] }) },
      charge: { create: vi.fn(async ({ data, select }: any) => { created.push(data); return { id: `c${created.length}` }; }) },
    } as any,
  };
}
const session = { orgId: "org1", userId: "u1", role: "manager" };
const entry = { id: "entry1", apartmentId: "apt1" } as any;

beforeEach(() => { flag.on = false; });

it("flag off no-op", async () => {
  const { tx, created } = makeTx({ expenses: [] });
  const r = await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(r).toEqual({ tenantChargeIds: [], ownerChargeIds: [] });
  expect(created).toHaveLength(0);
});

it("tenant expense stamps co-group keys", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "250.00", withSST: false, description: "Aircon repair", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
  });
  const r = await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(r.tenantChargeIds).toHaveLength(1);
  expect(created[0]).toMatchObject({ unitId: "unitA", partyId: "partyA", sourceGridExpenseId: "e1", sourceGridEntryId: "entry1", sstRate: "0", categoryId: "cat-oe-t", description: "Aircon repair" });
});

it("sstRate from withSST", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "100.00", withSST: true, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
  });
  await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(created[0].sstRate).toBe("8");
});

it("tenant unattributed fails closed", async () => {
  flag.on = true;
  const { tx } = makeTx({ expenses: [{ id: "e1", bearer: "tenant", tenancyId: null, amount: "10.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }] });
  await expect(mintExpenseChargesTx(tx, session, entry, "202607", 0)).rejects.toThrow("EXPENSE_TENANT_UNRESOLVED");
});

it("owner unresolved fails closed", async () => {
  flag.on = true;
  const { tx } = makeTx({ expenses: [{ id: "e1", bearer: "owner", tenancyId: null, amount: "80.00", withSST: false, description: "Fire ext", chargeCategoryId: null, status: "active" }], owner: false });
  await expect(mintExpenseChargesTx(tx, session, entry, "202607", 0)).rejects.toThrow("OWNER_UNRESOLVED");
});

it("tenant expense uses a matching-family picked category over the fallback", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "50.00", withSST: false, description: "X", chargeCategoryId: "cat-tenant-picked", status: "active" }],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
    pickedCats: [{ id: "cat-tenant-picked", code: "misc_tenant", family: "tenant_income", docType: "invoice" }],
  });
  await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(created[0].categoryId).toBe("cat-tenant-picked");
});

it("bearer wins over picked category", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "50.00", withSST: false, description: "X", chargeCategoryId: "cat-owner-picked", status: "active" }],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
    pickedCats: [{ id: "cat-owner-picked", code: "cleaning_owner", family: "owner_income", docType: "invoice" }],
  });
  await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(created[0].categoryId).toBe("cat-oe-t"); // fell back, not the owner-family pick
});

it("void expense skipped", async () => {
  flag.on = true;
  const { tx, created } = makeTx({ expenses: [] }); // findMany filters status:"active", so a void row never returns
  await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(created).toHaveLength(0);
  expect(tx.chargeCategory.findMany).not.toHaveBeenCalled(); // short-circuits before resolving fallback categories
});

it("multi-expense mixed bearers stay scoped to their own tenant/owner", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [
      { id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "20.00", withSST: false, description: "Tenant one", chargeCategoryId: null, status: "active" },
      { id: "e2", bearer: "owner", tenancyId: null, amount: "30.00", withSST: false, description: "Owner one", chargeCategoryId: null, status: "active" },
    ],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
    owner: true,
  });
  const r = await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(r.tenantChargeIds).toHaveLength(1);
  expect(r.ownerChargeIds).toHaveLength(1);
  expect(created).toHaveLength(2);
  expect(created[0]).toMatchObject({ sourceGridExpenseId: "e1", unitId: "unitA", partyId: "partyA", categoryId: "cat-oe-t" });
  expect(created[1]).toMatchObject({ sourceGridExpenseId: "e2", unitId: "L-owner", partyId: "P-owner", categoryId: "cat-oe-o" });
});

it("mid-loop throw halts and propagates, leaving earlier creates uncommitted-by-caller", async () => {
  flag.on = true;
  // e2 is bearer:"owner" (not a second tenant row): post-fallback, a tenant row with
  // no tenancyId/partyId now resolves via the apartment's whole-unit tenancy (see the
  // "historical tenant expense" test below), so it's no longer a reliable failure mode
  // for this test. Owner-unresolved is a still-genuine, Change-A-independent throw that
  // exercises the same mid-loop halt-and-propagate mechanics.
  const { tx, created } = makeTx({
    expenses: [
      { id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "20.00", withSST: false, description: "OK first", chargeCategoryId: null, status: "active" },
      { id: "e2", bearer: "owner", tenancyId: null, amount: "30.00", withSST: false, description: "Fails second", chargeCategoryId: null, status: "active" },
    ],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
    owner: false,
  });
  await expect(mintExpenseChargesTx(tx, session, entry, "202607", 0)).rejects.toThrow("OWNER_UNRESOLVED");
  expect(created).toHaveLength(1); // e1's create already ran before e2 threw — the caller's own $transaction rolls this back on throw
  expect(created[0].sourceGridExpenseId).toBe("e1");
});

it("chargeNumber suffix reflects revision", async () => {
  flag.on = true;
  const { tx: tx0, created: created0 } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "20.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
  });
  await mintExpenseChargesTx(tx0, session, entry, "202607", 0);
  expect(created0[0].chargeNumber).toBe("GRIDEXP-202607-e1");

  const { tx: tx1, created: created1 } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "20.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
  });
  await mintExpenseChargesTx(tx1, session, entry, "202607", 1);
  expect(created1[0].chargeNumber).toBe("GRIDEXP-202607-e1-r1");
});

it("non-positive amount skipped, siblings in the same call still mint", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [
      { id: "e1", bearer: "tenant", tenancyId: "ten1", amount: "0.00", withSST: false, description: "RM0", chargeCategoryId: null, status: "active" },
      { id: "e2", bearer: "tenant", tenancyId: "ten1", amount: "15.00", withSST: false, description: "Real one", chargeCategoryId: null, status: "active" },
    ],
    tenancy: { id: "ten1", unitId: "unitA", tenantPartyId: "partyA" },
  });
  const r = await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(r.tenantChargeIds).toHaveLength(1);
  expect(created).toHaveLength(1);
  expect(created[0].sourceGridExpenseId).toBe("e2");
});

it("historical tenant expense (null tenancyId, partyId set) resolves via the active tenancy for that party", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: null, partyId: "P-t", amount: "50.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "T-1", unitId: "U-1", tenantPartyId: "P-t" },
  });
  const r = await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(r.tenantChargeIds).toHaveLength(1);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ tenancyId: "T-1", unitId: "U-1", partyId: "P-t" });
});

it("tenant expense with tenancyId set resolves via the id fast path", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "T-1", partyId: null, amount: "50.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "T-1", unitId: "U-1", tenantPartyId: "P-t" },
  });
  const r = await mintExpenseChargesTx(tx, session, entry, "202607", 0);
  expect(r.tenantChargeIds).toHaveLength(1);
  expect(created[0]).toMatchObject({ tenancyId: "T-1", unitId: "U-1", partyId: "P-t" });
});

it("tenant expense recording neither tenancyId nor partyId is genuinely unattributable", async () => {
  flag.on = true;
  const { tx } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: null, partyId: null, amount: "10.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: null,
  });
  await expect(mintExpenseChargesTx(tx, session, entry, "202607", 0)).rejects.toThrow("EXPENSE_TENANT_UNRESOLVED");
});

it("SET-but-unresolvable tenancyId fails closed — does NOT fall through to a resolvable partyId (review #3)", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: "GONE", partyId: "P-t", amount: "50.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: { id: "T-other", unitId: "U-other", tenantPartyId: "P-t" },
  });
  // where-aware: the explicit id lookup misses (deleted/cross-org); a party lookup WOULD match
  // T-other — which must NOT be used, else the admin's explicit attribution is silently overridden.
  tx.tenancy.findFirst = vi.fn(async ({ where }: any) => (where.id ? null : { id: "T-other", unitId: "U-other", tenantPartyId: "P-t" }));
  await expect(mintExpenseChargesTx(tx, session, entry, "202607", 0)).rejects.toThrow("EXPENSE_TENANT_UNRESOLVED");
  expect(created).toHaveLength(0); // nothing billed — never fell through to T-other
});

it("historical partyId whose tenancy is no longer active fails closed — never bills a different current tenant (review #1)", async () => {
  flag.on = true;
  const { tx, created } = makeTx({
    expenses: [{ id: "e1", bearer: "tenant", tenancyId: null, partyId: "P-gone", amount: "50.00", withSST: false, description: "X", chargeCategoryId: null, status: "active" }],
    tenancy: null, // P-gone has no active tenancy; there is NO whole-unit fall-through to the current occupant
  });
  await expect(mintExpenseChargesTx(tx, session, entry, "202607", 0)).rejects.toThrow("EXPENSE_TENANT_UNRESOLVED");
  expect(created).toHaveLength(0);
});
