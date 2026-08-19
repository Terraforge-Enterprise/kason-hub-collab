import { getDb } from "@kason/db";
import { createSignedDownloadUrl, createSignedUploadUrl, deleteObjectsBestEffort } from "../../../lib/storage";
import { randomUUID } from "node:crypto";

type SessionScope = { partyId: string; orgId: string; userId: string };

export async function getProfile(session: SessionScope) {
  const db = getDb();

  const [user, party] = await Promise.all([
    db.user.findUnique({
      where: { id: session.userId },
      select: { fullName: true, email: true, phone: true, userType: true },
    }),
    db.party.findFirst({
      where: { id: session.partyId, organizationId: session.orgId },
      select: { displayName: true, partyType: true, primaryEmail: true, primaryPhone: true, agentLevel: true, bankName: true, bankAccountHolder: true, bankAccountNumber: true, photoKey: true },
    }),
  ]);

  const photoUrl = party?.photoKey ? await createSignedDownloadUrl(party.photoKey) : null;

  const base = {
    fullName: user?.fullName ?? party?.displayName ?? "Unknown",
    email: user?.email ?? party?.primaryEmail ?? "",
    phone: user?.phone ?? party?.primaryPhone ?? "",
    partyType: party?.partyType ?? "individual",
    userType: user?.userType ?? "tenant",
    agentLevel: party?.agentLevel ?? null,
    bankName: party?.bankName ?? null,
    bankAccountHolder: party?.bankAccountHolder ?? null,
    bankAccountNumber: party?.bankAccountNumber ?? null,
    photoKey: party?.photoKey ?? null,
    photoUrl,
  };

  if (user?.userType === "owner") {
    // Owner → properties resolved per-unit via Listing.ownerPartyId (owner money
    // is attributed per-unit, NOT per-property via LandlordTenancy). propertyCount
    // = distinct propertyId across the owner's owned non-archived listings.
    const ownedListings = await db.listing.findMany({
      where: {
        ownerPartyId: session.partyId,
        organizationId: session.orgId,
        listingStatus: { not: "archived" },
      },
      select: { apartment: { select: { propertyId: true } } },
    });
    const propertyCount = new Set(ownedListings.map((l) => l.apartment.propertyId)).size;
    return { ...base, propertyCount };
  }

  const tenancy = await db.tenancy.findFirst({
    where: {
      tenantPartyId: session.partyId,
      organizationId: session.orgId,
      status: "active",
    },
    select: {
      tenancyCode: true,
      unit: { select: { apartment: { select: { unitCode: true } } } },
      property: { select: { name: true } },
    },
  });

  return {
    ...base,
    unitCode: tenancy?.unit.apartment.unitCode ?? null,
    propertyName: tenancy?.property.name ?? null,
    tenancyCode: tenancy?.tenancyCode ?? null,
  };
}

export async function updateAgentBankDetails(partyId: string, orgId: string, data: {
  bankName?: string;
  bankAccountHolder?: string;
  bankAccountNumber?: string;
}) {
  const db = getDb();
  return db.party.update({
    where: { id: partyId },
    data: {
      ...(data.bankName !== undefined ? { bankName: data.bankName } : {}),
      ...(data.bankAccountHolder !== undefined ? { bankAccountHolder: data.bankAccountHolder } : {}),
      ...(data.bankAccountNumber !== undefined ? { bankAccountNumber: data.bankAccountNumber } : {}),
    },
  });
}

export type PortalProfileUpdateInput = {
  fullName?: string;
  // null is the canonical "clear" intent from optionalPhoneSchema —
  // the route's Zod schema produces `string | null | undefined`. The
  // updateMyPortalProfile fn forwards null through to Prisma so the
  // primaryPhone column is set to NULL (not "").
  phone?: string | null;
  photoKey?: string | null;
};

function partyAvatarKeyPrefix(partyId: string): string {
  return `avatars/parties/${partyId}/`;
}

export async function updateMyPortalProfile(
  session: SessionScope,
  input: PortalProfileUpdateInput,
): Promise<
  | { ok: true }
  | { ok: false; status: 403; error: string }
> {
  // Ownership guard on photoKey
  if (input.photoKey != null) {
    if (!input.photoKey.startsWith(partyAvatarKeyPrefix(session.partyId))) {
      return { ok: false, status: 403, error: "Photo key does not belong to caller" };
    }
  }

  const db = getDb();

  // Read the current photoKey BEFORE the update so we can clean up the old
  // object afterwards — but only when the caller is actually changing the photo.
  let oldPhotoKey: string | null = null;
  if (input.photoKey !== undefined) {
    const current = await db.party.findUnique({
      where: { id: session.partyId },
      select: { photoKey: true },
    });
    oldPhotoKey = current?.photoKey ?? null;
  }

  const partyData: { displayName?: string; primaryPhone?: string | null; photoKey?: string | null } = {};
  if (input.fullName !== undefined) partyData.displayName = input.fullName;
  if (input.phone !== undefined) partyData.primaryPhone = input.phone;
  if (input.photoKey !== undefined) partyData.photoKey = input.photoKey;

  if (Object.keys(partyData).length > 0) {
    await db.party.update({
      where: { id: session.partyId },
      data: partyData,
    });
  }

  // Best-effort delete of the previous avatar object AFTER the DB write.
  // Only delete when there was a prior key AND it differs from the new key
  // (covers both "replace" and "clear" cases). No-op on "same key" or "no prior photo".
  if (input.photoKey !== undefined && oldPhotoKey && oldPhotoKey !== input.photoKey) {
    await deleteObjectsBestEffort([oldPhotoKey]);
  }

  return { ok: true };
}

const PORTAL_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export async function mintPortalAvatarUploadUrl(
  session: SessionScope,
  input: { contentType: string; sizeBytes: number },
): Promise<
  | { ok: true; data: { url: string; key: string; headers: Record<string, string> } }
  | { ok: false; status: 400; error: string }
> {
  const ext = PORTAL_MIME_TO_EXT[input.contentType];
  if (!ext) return { ok: false, status: 400, error: "contentType must be image/jpeg, image/png, or image/webp" };
  if (input.sizeBytes <= 0 || input.sizeBytes > 5 * 1024 * 1024) {
    return { ok: false, status: 400, error: "Max 5MB" };
  }
  const key = `${partyAvatarKeyPrefix(session.partyId)}${randomUUID()}.${ext}`;
  const signed = await createSignedUploadUrl({ storageKey: key, contentType: input.contentType });
  return { ok: true, data: { url: signed.uploadUrl, key, headers: signed.headers } };
}
