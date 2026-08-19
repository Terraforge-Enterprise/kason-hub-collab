/**
 * Security regression guard for getReservationForOrg (agent horizontal-read).
 *
 * repo.findByIdInOrg is org-scoped only, so the SERVICE must additionally deny
 * an agent reading a reservation they did not issue — otherwise any
 * authenticated agent who learns another reservation's id could pull the full
 * applicant PII (NRIC, nationality, income, emergency contacts) and a
 * signed-PDF URL via toDto. Mirrors the ownership check already in
 * getUnsignedReservationPdfService.
 *
 * Runs by DEFAULT (no DB): the repository + storage seams are mocked and the
 * REAL getReservationForOrg is exercised, so the guarantee is verified on every
 * run rather than only under RUN_INTEGRATION.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReservationSession } from "../types";

vi.mock("../repository", () => ({
  findByIdInOrg: vi.fn(),
}));
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async (k: string) => `https://sb/view/${k}`),
  createSignedUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  putObject: vi.fn(),
  requireBucket: vi.fn(() => "bucket"),
}));

import * as repo from "../repository";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { getReservationForOrg } from "../service";

type Row = Awaited<ReturnType<typeof repo.findByIdInOrg>>;

const ORG = "org-1";
const OWNER_AGENT = "party-owner";
const OTHER_AGENT = "party-other";

/** A structurally-complete reservation row (the fields toDto reads). */
function makeRow(overrides: Record<string, unknown> = {}): Row {
  const d = new Date("2026-07-01T00:00:00.000Z");
  return {
    id: "res-1",
    referenceCode: "RES-1",
    status: "pending_customer",
    issuedAt: d,
    expiresAt: d,
    issuedByPartyId: OWNER_AGENT,
    property: { id: "prop-1", name: "Prop One" },
    unit: { id: "unit-1", unitCode: "U-1" },
    carPark: null,
    proposedMoveIn: d,
    proposedMoveOut: null,
    specialRemarks: null,
    reservationDeposit: "500.00",
    documentationFee: "100.00",
    rentalDeposit: "2400.00",
    utilityDeposit: "300.00",
    accessCardDeposit: "50.00",
    agreedMonthlyRent: "1200.00",
    applicantFullName: "Applicant One",
    applicantNric: "900101-14-2222",
    applicantContact: "+60111",
    applicantEmail: "a@example.test",
    applicantAddressLine1: "1 St",
    applicantAddressLine2: null,
    applicantCity: "KL",
    applicantPostcode: "50000",
    applicantState: "WP",
    applicantCountry: "Malaysia",
    nationality: "Malaysian",
    occupation: "Engineer",
    monthlyIncome: "6500.00",
    emergencyContactName: "EC Name",
    emergencyContactPhone: "+60122",
    emergencyContactRelation: "Sister",
    documents: [],
    signedAt: null,
    customTerms: [],
    approvalNote: null,
    publicToken: "tok-secret",
    signedPdfKey: null,
    ...overrides,
  } as unknown as Row;
}

function agentSession(partyId: string): ReservationSession {
  return { orgId: ORG, userId: "u", partyId, role: "agent" };
}
const adminSession: ReservationSession = {
  orgId: ORG,
  userId: "u",
  partyId: "p-admin",
  role: "admin",
  operatorRole: "admin",
};
const viewerSession: ReservationSession = {
  orgId: ORG,
  userId: "u",
  partyId: "p-viewer",
  role: "viewer",
};

describe("getReservationForOrg — agent horizontal-read guard (no DB)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("DENIES a non-owning agent → null, and never assembles PII (returns before toDto)", async () => {
    vi.mocked(repo.findByIdInOrg).mockResolvedValue(
      makeRow({ issuedByPartyId: OWNER_AGENT, signedPdfKey: "k" }),
    );
    const dto = await getReservationForOrg(ORG, "res-1", agentSession(OTHER_AGENT));
    expect(dto).toBeNull();
    // Even though the row has a signed PDF, no signed URL is minted for a
    // foreign agent — proof the guard short-circuits ahead of toDto.
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("ALLOWS the owning agent → full DTO incl. its own publicToken", async () => {
    vi.mocked(repo.findByIdInOrg).mockResolvedValue(makeRow({ issuedByPartyId: OWNER_AGENT }));
    const dto = await getReservationForOrg(ORG, "res-1", agentSession(OWNER_AGENT));
    expect(dto).not.toBeNull();
    expect(dto?.applicant.nric).toBe("900101-14-2222");
    expect(dto?.applicant.nationality).toBe("Malaysian");
    expect(dto?.publicToken).toBe("tok-secret");
  });

  it("ALLOWS an admin/operator to read any in-org reservation", async () => {
    vi.mocked(repo.findByIdInOrg).mockResolvedValue(makeRow({ issuedByPartyId: OWNER_AGENT }));
    const dto = await getReservationForOrg(ORG, "res-1", adminSession);
    expect(dto).not.toBeNull();
    expect(dto?.applicant.emergencyContactName).toBe("EC Name");
  });

  it("ALLOWS a viewer (org-wide staff) — unaffected by the agent guard, no public token", async () => {
    vi.mocked(repo.findByIdInOrg).mockResolvedValue(makeRow({ issuedByPartyId: OWNER_AGENT }));
    const dto = await getReservationForOrg(ORG, "res-1", viewerSession);
    expect(dto).not.toBeNull();
    expect(dto?.publicToken).toBeUndefined();
  });
});
