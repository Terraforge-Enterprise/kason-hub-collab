/**
 * Fast mocked-DB test for getOwnerPropertyView's under-management gate (R6).
 *
 * The pre-existing `portal.owner-ledger.property-view.test.ts` covers the
 * cross-owner leak with a real DB but is RUN_INTEGRATION-gated (skipped by
 * default). This file mocks @kason/db so the under-management gate is
 * verified on every default `vitest run`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  listing: { findFirst: vi.fn() },
  property: { findFirst: vi.fn() },
  managementFeeConfig: { findFirst: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { getOwnerPropertyView } from "../portal.owner-ledger.repository";

beforeEach(() => {
  dbMock.listing.findFirst.mockReset();
  dbMock.property.findFirst.mockReset();
  dbMock.managementFeeConfig.findFirst.mockReset().mockResolvedValue(null);
});

describe("getOwnerPropertyView — under-management gate (R6)", () => {
  it("gates the ownership check on underManagement", async () => {
    dbMock.listing.findFirst.mockResolvedValue({ id: "l1" });
    dbMock.property.findFirst.mockResolvedValue({ id: "P", name: "P", apartments: [], managerId: null });

    await getOwnerPropertyView("org-1", "owner-1", "P");

    expect(dbMock.listing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apartment: { propertyId: "P", underManagement: true } }),
      }),
    );
  });

  it("gates the apartments relation select on underManagement", async () => {
    dbMock.listing.findFirst.mockResolvedValue({ id: "l1" });
    dbMock.property.findFirst.mockResolvedValue({ id: "P", name: "P", apartments: [], managerId: null });

    await getOwnerPropertyView("org-1", "owner-1", "P");

    const sel = dbMock.property.findFirst.mock.calls[0][0].select.apartments;
    expect(sel.where).toEqual({ underManagement: true });
  });

  it("returns null when the owner owns no managed listing in the property", async () => {
    dbMock.listing.findFirst.mockResolvedValue(null);

    const res = await getOwnerPropertyView("org-1", "owner-1", "P");

    expect(res).toBeNull();
    expect(dbMock.property.findFirst).not.toHaveBeenCalled();
  });
});
