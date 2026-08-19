/**
 * Integration test for the sign-service "≥1 ID document" gate plus the
 * fill-service profile-field persistence (Task 5).
 *
 * Hits a real Postgres. Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/reservations/__tests__/reservation-sign-gate.test.ts
 *
 * `htmlToPdf` (real Chromium via puppeteer-core) and Supabase Storage
 * (`putObject`/`createSignedDownloadUrl`) are mocked — this test proves the
 * doc-count gate + fill persistence, not PDF rendering or blob storage
 * (those are covered, or known-environmentally-gapped, elsewhere; see
 * apps/api/src/lib/document-templates/__tests__/pdf.test.ts and the
 * reservations/unsigned-pdf integration suite).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/document-templates/pdf", () => ({
  htmlToPdf: vi.fn(async () => Buffer.from("fake-pdf-bytes")),
}));

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => {}),
  createSignedDownloadUrl: vi.fn(async (k: string) => `https://sb/view/${k}`),
  deleteObject: vi.fn(async () => {}),
  requireBucket: vi.fn(() => "bucket"),
}));

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "22222222-2222-2222-2222-222222222222";
const AGENT_PARTY = "33333333-3333-3333-3333-333333333333";
const AGENT_USER = "44444444-4444-4444-4444-444444444444";
const PROPERTY = "55555555-5555-5555-5555-555555555555";
const APARTMENT = "77777777-7777-7777-7777-777777777777";
const UNIT = "66666666-6666-6666-6666-666666666666";

// 40x20 noisy dark PNG (random per-pixel RGB, generated once via sharp —
// see below) — decodes to ~2.1KB (comfortably over validateSignaturePng's
// 200-byte floor; a solid-color PNG compresses under that floor) and has a
// channel mean (~49) far below the blank-signature threshold (>250), so it
// passes as a "real" (non-blank) signature drawing.
//   node -e "const sharp=require('sharp');const w=40,h=20,c=3;const raw=Buffer.alloc(w*h*c);
//   for(let i=0;i<raw.length;i++)raw[i]=Math.floor(Math.random()*100);
//   sharp(raw,{raw:{width:w,height:h,channels:c}}).png().toBuffer().then(b=>console.log(b.toString('base64')))"
const VALID_SIGNATURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAIBUlEQVR4nAXBh4KBAAAA0IzMUGSVFEWyJSMrKXvFFWXT///DvQeA23vxXB/2ywhkNZaTH2gla4fbSkgidMCZzxer+ISYps8szL4rIUUsNCe2JJY4LbU1JMc51lEf8ccPPHYzh0hcEV/o7G6VOnG2kKMsvFiU3EnIFyLfXCod6PHF2tS4h9c/N+19ADGRpFFLzZVpZP+kgIA9RbRtP9mgWqbDecqnmqEpM8luRoUSdimrBjZ45j3nuy9t2+lkz/vqZC2qetAv5Lde/C1C2AxBiwuhLgUoy+fKMeD41t7XjUAszIcfDRZeTOuRXFujsh9ABwRp4x+fhMPL+PuMUoOq16/i0BmDCYUsqqlXaj6wpuFmKKgalzzojab23YP4Kp3ey5bVjykqOk4Z0OPqS+3y5GzK2b2Oel9Rd8eXi++vUTivBSCIqOczXmCSFYg3w7lYF+OfAaYnelvwPJl2L+pj2n/cBMp6bjP5W8xLHtc9oq0fxVY1vTkks5lztu9c2L317E3aebKr2NmF3tJv1YiZ1cZcafSL4qNTp6Q8IhqOddDd6xixbOf+AXCx+uIXQUTf1WAS07A9/wAUEJ+OmbGImyboV5sb/6DGGYwuKD6w2A+n7/R5LWX2y9fIUaUcz04pafmX0agqtkxoJ5g6M/j1akR1ayE1dz1YbO0nC/fVEn91hYjg6bh4H9FmuVl3gV+ajkRAI92LYCS3/z0jIaCrFWb2rLUyBRuMLu+RW7+dOesfGQ1sN5U4ac6yjvnfwy356Hxr12DGQ5mZvALt0FX03gt3KjDxtyxsVCplttfs+2WmR+pzH14eCghzBS+vrJzX+Sl7PT5awii2g4nsZnFqtJczHhiGmBOfS0kXLBG/XoFf90p1H7hUrk8Nj3qRowBXWfcWSrw0X8HNdE34kcU0VZ8pnwt/LfjrD7SIDILByS06lLxfsqLYnlLOvmc2pZQbqM7Zy5N1TgZQiAterj8Cq5dgd4Qwrq42UJxuWXX1cHoqY/omxo1vOKBCKh9EIrVt+C2GF++z73LFP5eg3XtJwEqHkuUStmnsiR/ekNVJKAP3JqfPrtaP4b1Xj4dMLCrtppnkB1RqNwnRzxHb3XuvFyI8237+bvUnGyWRRgJQ8mDm4lYO16G+p/1muJX8EB1v8zmU05/32Zj+wXE04YPz20Vj4WxBrXqZJTZPsgrtyjsrIUrXvkAm+Dedv0DQYevAAvzlLzubwythcY0P3oLz5ubS958Cwy+0czNDhSXRiVsYAWw2LzsUPp6wXMQlhwjj0ntHna0nW9w1Xw75KgwRdG4v9tGKBXmSVKy/6h7u37L2bVIvGNLX7CgW8E4C6iz7Tv61mKvo9D4w1kdHImIohJO2yogKd89BXrV2H6bBOItIfWe95rAB3HfWaPNu68xlpfJwJ7f4pm4nezSMflhtxmYaGcdp9e3F9lH/B6HkHfCGbqxmR53Lr/Oniqfw9Ye+bGeeXbJSYTf2Px6wR10nkxqsq7xgPE6fzRZveAnSXKZSB+8wWx0IlUEqArRPUUUk3758YrRqIj8XWHNRwipNhbjxvrdz3OVRc9px8OEN0iK+Qzx7Pg+tgu/EVXKiEa/uXj2kWtSVnABRib+9UiUcMTRRuyXIhFXwBMPzv5ATKm1KC7D3CWYITjcDJuqI3c5d4Jx2jGVaLCoJbMUOG7TBgbWig3cF245DMnVu6ToLBS7Ux8uVKnJXuBleur2s0rdj9H3KA02MgLunt5GyNyjeA2XhYJWqel3ImGcE/giTaqdg46BauODOznxrX6l9e+EflrHBAOARnJE1uW/EnnM0CS51EU3s1Oh86Htb/N3AGBTvhqPMPnmebg6pSnf2hqTDrH/ZPgMBjHF3cbIV6LsSiYWKOg/r4nEqIQdbFoutAtaZfvv7oRpA0ykNSyzCfSnzGvNtX8maExcApd4cAICyf4q54Yf2cRyiKxkeZ8dyWJl+RXAW5e8YIqB+Fxps3J+XlvgImjnZzlm6bz39PeUe6VCUEZjpD0zJgDJ+d8c94pkgPeQNGkmI2qkhCP3ACAbOP3Z+IpZhbfDXLMYBRXZLWGkujx5G80m/fUeN9b0GFeNUTvpjroLmqW5tgDdFrpld0oelZYUTOm5ubptYr1JyhEwDSJZrrX4gz430nZqLNZVC+/w6DO0jsS+qziDn9XjG720hmbGldk/2147XTnUetACf3j68FS6y09J/R6aVtKYg6qGczr44Yj92gGYJI2Uz3J32NEhPGuVSV3TMrqWUxF7AR96Nitd2Pf0p5+LWsON/Mj8ET+hMPJrGs8FU2cJDfhgaHpKJ+ej27S8V4gQ8lfmMWpFA06WuOKg76q+64Oi5LDJBMd0KpzrrQZpWvCyf7kHnYuRxE+HC5IUTX2L86eL28V3w6IyKCuZ36UtZnsrj88TDvxNyE8KOZqWZzaMFopGPa42vCtFKftQjJ4bDNZwUJpM7bJZYN9DaadVEZVe4vcowQe9yTqokqe7dScbLtXyImfnWbvlUCbOdVm1/rhCvT027/0I5b+jy6zf/SJ2dzHOnyxY5bI/rcNyBJY7bDyrNmh7nuRqjdwPu1uEaarA28DxoOfZoTzqj9kD2LYBsmoc1/O33sGun4yfk9Q316lXwM/ZODHM2lVw/SakiT5O/x2y6dnfXvr4sTOaB4bMdcwqIs1ft3XP+FBAtn2e7HzWRIqPMtM3zmOkpvlxgvWF/qxFlnvn7as5Ct2MUKmNnR6vsyX+q2NR2hxXu/gAAAABJRU5ErkJggg==";

const SECTION_A = {
  propertyId: PROPERTY,
  unitId: UNIT,
  carPark: null,
  proposedMoveIn: "2026-06-01T00:00:00Z",
  proposedMoveOut: null,
  specialRemarks: null,
  reservationDeposit: "500.00",
  documentationFee: "100.00",
  rentalDeposit: "2400.00",
  utilityDeposit: "300.00",
  accessCardDeposit: "50.00",
  agreedMonthlyRent: "2200.00",
  customerEmail: "customer@example.com",
};

function validSectionB() {
  return {
    applicantFullName: "John Tan",
    applicantNric: "900101011234",
    applicantContact: "+60123456789",
    applicantEmail: "john@example.com",
    applicantAddressLine1: "12, Jalan Bukit Bintang",
    applicantAddressLine2: undefined,
    applicantCity: "Kuala Lumpur",
    applicantPostcode: "55100",
    applicantState: "Wilayah Persekutuan Kuala Lumpur",
    applicantCountry: "Malaysia",
    nationality: "Malaysian",
    emergencyContactName: "Jane Doe",
    emergencyContactPhone: "+60123456789",
    emergencyContactRelation: "Sister",
    occupation: "Engineer",
    monthlyIncome: "8000.00",
  };
}

function validSign() {
  return {
    typedName: "John Tan",
    agreementTicked: true,
    signaturePngBase64: `data:image/png;base64,${VALID_SIGNATURE_PNG_BASE64}`,
  };
}

dn("reservation sign-gate + fill profile fields (integration)", () => {
  let getDb: typeof import("@kason/db").getDb;
  let createReservationService: typeof import("../service").createReservationService;
  let fillReservationByTokenService: typeof import("../service").fillReservationByTokenService;
  let signReservationByTokenService: typeof import("../service").signReservationByTokenService;

  beforeEach(async () => {
    vi.resetModules();
    ({ getDb } = await import("@kason/db"));
    ({
      createReservationService,
      fillReservationByTokenService,
      signReservationByTokenService,
    } = await import("../service"));
    await cleanup();
    await seedOrgWithUnit();
  });

  async function seedOrgWithUnit() {
    const db = getDb();
    await db.organization.create({
      data: {
        id: ORG,
        name: "Test",
        slug: "t",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
        reservationLinkExpiryDays: 7,
      },
    });
    await db.documentTemplate.create({
      data: {
        organizationId: ORG,
        docType: "reservation_form",
        title: "Unit Reservation Form",
        refPrefix: "RES",
        refSeparator: "-",
        refPadding: 5,
        refIncludeYear: false,
        headerFields: {},
        orgAddressLines: [],
      },
    });
    await db.party.create({
      data: {
        id: AGENT_PARTY,
        organizationId: ORG,
        displayName: "Agent",
        partyType: "agent",
        status: "active",
      },
    });
    await db.property.create({
      data: {
        id: PROPERTY,
        organizationId: ORG,
        name: "Test Property",
        propertyCode: "TP-1",
        propertyType: "residential",
        addressLine1: "1 Test St",
        city: "Kuala Lumpur",
        country: "MY",
        status: "active",
        publishStatus: "draft",
      },
    });
    await db.apartment.create({
      data: {
        id: APARTMENT,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitCode: "A-101",
        listingMode: "WHOLE",
      },
    });
    await db.listing.create({
      data: {
        id: UNIT,
        organizationId: ORG,
        apartmentId: APARTMENT,
        listingType: "apartment",
        occupancyStatus: "vacant",
        listingStatus: "active",
        currency: "MYR",
        readyNow: true,
        ownerPartyId: AGENT_PARTY,
      },
    });
  }

  async function cleanup() {
    const db = getDb();
    await db.unitReservationDocument.deleteMany({ where: { organizationId: ORG } });
    await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
    await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
    await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
    await db.documentTemplate.deleteMany({ where: { organizationId: ORG } });
    await db.listing.deleteMany({ where: { organizationId: ORG } });
    await db.apartment.deleteMany({ where: { organizationId: ORG } });
    await db.property.deleteMany({ where: { organizationId: ORG } });
    await db.party.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
  }

  async function seedReservation() {
    const created = await createReservationService(
      { orgId: ORG, userId: AGENT_USER, partyId: AGENT_PARTY, role: "agent" },
      SECTION_A,
    );
    if (!created.ok) throw new Error("setup failed: " + created.error);
    return { token: created.data.publicToken, id: created.data.id };
  }

  it("fill persists profile fields (nationality, emergency contact, occupation, income)", async () => {
    const { token, id } = await seedReservation();

    const result = await fillReservationByTokenService(token, validSectionB());
    expect(result.ok).toBe(true);

    const row = await getDb().unitReservation.findUniqueOrThrow({ where: { id } });
    expect(row.nationality).toBe("Malaysian");
    expect(row.emergencyContactName).toBe("Jane Doe");
    expect(row.emergencyContactPhone).toBe("+60123456789");
    expect(row.emergencyContactRelation).toBe("Sister");
    expect(row.occupation).toBe("Engineer");
    expect(row.monthlyIncome?.toString()).toBe("8000");
  });

  it("fill persists profile fields with the optional trio omitted (null)", async () => {
    const { token, id } = await seedReservation();
    const input = validSectionB();
    delete (input as Record<string, unknown>).emergencyContactRelation;
    delete (input as Record<string, unknown>).occupation;
    delete (input as Record<string, unknown>).monthlyIncome;

    const result = await fillReservationByTokenService(token, input);
    expect(result.ok).toBe(true);

    const row = await getDb().unitReservation.findUniqueOrThrow({ where: { id } });
    expect(row.emergencyContactRelation).toBeNull();
    expect(row.occupation).toBeNull();
    expect(row.monthlyIncome).toBeNull();
  });

  it("blocks sign without doc", async () => {
    const { token, id } = await seedReservation();
    await fillReservationByTokenService(token, validSectionB());

    const r = await signReservationByTokenService(token, validSign(), {
      ip: "0.0.0.0",
      userAgent: "t",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("ID_DOCUMENT_REQUIRED");

    const row = await getDb().unitReservation.findUnique({ where: { id } });
    expect(row?.status).toBe("pending_customer");
  });

  it("allows sign with doc", async () => {
    const { token, id } = await seedReservation();
    await fillReservationByTokenService(token, validSectionB());

    await getDb().unitReservationDocument.create({
      data: {
        organizationId: ORG,
        reservationId: id,
        kind: "ic_front",
        fileKey: `reservations/${ORG}/${id}/id-docs/ic_front`,
        filename: "ic-front.jpg",
      },
    });

    const r = await signReservationByTokenService(token, validSign(), {
      ip: "0.0.0.0",
      userAgent: "t",
    });
    expect(r.ok).toBe(true);

    const row = await getDb().unitReservation.findUnique({ where: { id } });
    expect(row?.status).toBe("signed");
  });

  it("blocks sign when the ID doc is deleted between the pre-gate check and the sign transaction (TOCTOU)", async () => {
    // Simulates: customer fires POST /sign (pre-gate count reads 1, passes,
    // begins the slow non-transactional PDF/storage work) while a concurrent
    // DELETE /documents/ic_front removes the last doc before the sign
    // transaction commits. The pre-transaction count (fast-fail, ~service.ts:608)
    // is a separate query from the in-transaction re-count that must gate the
    // final status flip. We simulate the race deterministically via a Prisma
    // `$extends` query-middleware on `unitReservationDocument.count`: the
    // FIRST call (the pre-gate, outside any transaction) returns 1 (doc still
    // there); the SECOND call (the in-transaction re-count, once the fix
    // exists) returns 0 (doc gone) — same interleaving a concurrent delete
    // would produce, without needing real concurrent requests or timing.
    const { token, id } = await seedReservation();
    await fillReservationByTokenService(token, validSectionB());

    await getDb().unitReservationDocument.create({
      data: {
        organizationId: ORG,
        reservationId: id,
        kind: "ic_front",
        fileKey: `reservations/${ORG}/${id}/id-docs/ic_front`,
        filename: "ic-front.jpg",
      },
    });

    const rawDb = getDb();
    let countCalls = 0;
    const extended = rawDb.$extends({
      query: {
        unitReservationDocument: {
          async count({ args, query }) {
            countCalls++;
            if (countCalls === 1) return 1; // pre-gate: doc still present
            return 0; // in-transaction re-count: doc gone (race landed)
          },
        },
      },
    });
    // getDb() caches on global.__kasonPrisma; swap the cached singleton for
    // the extended client so the service's own getDb() calls route through
    // our count-call-counting middleware for the duration of this test.
    (global as unknown as { __kasonPrisma: unknown }).__kasonPrisma = extended;

    try {
      const r = await signReservationByTokenService(token, validSign(), {
        ip: "0.0.0.0",
        userAgent: "t",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("ID_DOCUMENT_REQUIRED");
      expect(countCalls).toBeGreaterThanOrEqual(2);

      const row = await rawDb.unitReservation.findUnique({ where: { id } });
      expect(row?.status).toBe("pending_customer");
    } finally {
      (global as unknown as { __kasonPrisma: unknown }).__kasonPrisma = rawDb;
    }
  });
});
