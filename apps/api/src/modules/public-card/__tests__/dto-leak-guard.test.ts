// Leak-guard for the public-card DTO mapper (per spec §9.4 #11, #12).
//
// The mapper is the single allowed path from internal Prisma rows to the
// public response. These tests bind that contract:
//   1. Output keys equal the whitelist EXACTLY (no extras, no missing).
//   2. Forbidden internal IDs (partyId, organizationId, ownerId, …) NEVER
//      appear at any nesting level of the output.
//   3. Listings expose ONLY the whitelisted public fields — no photoUrl, no
//      displayPrice. (Both removed: the public card no longer surfaces
//      listing photos or rental prices.)
//
// Field-name notes for fixture authors: this fixture uses the REAL Unit
// schema fields (publishedTitle / unitCode / sizeSqft). The earlier plan
// mentioned fictional `address` / `askingPrice` / `sqft` fields that don't
// exist on Unit — see dto.ts for the reconciliation table.

import { describe, it, expect } from "vitest";
import {
  toPublicCardDto,
  PUBLIC_CARD_DTO_KEYS,
  PUBLIC_CARD_ORG_KEYS,
  PUBLIC_CARD_LISTING_KEYS,
} from "../dto";

const FORBIDDEN_KEYS = [
  "partyId",
  "organizationId",
  "submittedById",
  "reviewedById",
  "publicToken",
  "rejectionReason",
  "ownerId",
  "status",
  "approvedAt",
  // Removed surfaces — explicitly forbidden so a regression that re-adds
  // them to the DTO would fail this test.
  "photoUrl",
  "displayPrice",
  "coverPhotoKey",
  "rentalRate",
];

const fixture = {
  version: {
    displayName: "Kason Khoo",
    title: "Founder",
    primaryEmail: "kason@example.com",
    primaryPhone: "012-3828967",
    expiresAt: new Date("2026-08-05T00:00:00Z"),
  },
  party: { whatsappPhone: "60123828967" },
  org: {
    agencyName: "EUM Realty",
    agencyLicense: "E(1) 1708",
    agencyPhone: null,
    agencyFax: null,
    addressLine1: "Line 1",
    addressLine2: "Line 2",
    addressLine3: null,
    addressLine4: null,
  },
  listings: [
    {
      id: "u-1",
      unitCode: "A-12-3",
      publishedTitle: "12 Jalan Test",
      unitType: "condo",
      bedrooms: 2,
      bathrooms: 1,
      sizeSqft: 850,
      // The next two are deliberately injected to prove they CANNOT escape
      // the mapper. The DTO interface narrows them away; runtime only sees
      // the whitelisted picks.
      ownerId: "leaked-owner-id",
      organizationId: "leaked-org-id",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ],
};

describe("toPublicCardDto — leak guard", () => {
  it("output has exactly the whitelisted top-level keys", () => {
    const dto = toPublicCardDto(fixture);
    expect(Object.keys(dto).sort()).toEqual([...PUBLIC_CARD_DTO_KEYS].sort());
  });

  it("org has exactly the whitelisted keys", () => {
    const dto = toPublicCardDto(fixture);
    expect(Object.keys(dto.org).sort()).toEqual([...PUBLIC_CARD_ORG_KEYS].sort());
  });

  it("listing has exactly the whitelisted keys (no photoUrl, no displayPrice)", () => {
    const dto = toPublicCardDto(fixture);
    expect(Object.keys(dto.listings[0]).sort()).toEqual(
      [...PUBLIC_CARD_LISTING_KEYS].sort(),
    );
    // The whitelist is exactly 6 keys — id + the public meta row.
    expect(PUBLIC_CARD_LISTING_KEYS.length).toBe(6);
    // `id` is intentionally exposed (React key prop). All other forbidden
    // fields (including the removed photoUrl / displayPrice) must be absent.
    for (const f of FORBIDDEN_KEYS.filter((k) => k !== "id")) {
      expect(Object.keys(dto.listings[0])).not.toContain(f);
    }
  });

  it("does not include any forbidden internal IDs at top level", () => {
    const dto = toPublicCardDto(fixture);
    for (const f of FORBIDDEN_KEYS) {
      expect(Object.keys(dto)).not.toContain(f);
    }
  });

  it("address array filters nulls and empty strings", () => {
    const dto = toPublicCardDto(fixture);
    expect(dto.org.address).toEqual(["Line 1", "Line 2"]);
  });
});
