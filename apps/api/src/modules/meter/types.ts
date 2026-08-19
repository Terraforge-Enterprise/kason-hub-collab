import type { Prisma } from "@kason/db";

export type DbClient = Prisma.TransactionClient | ReturnType<typeof import("@kason/db").getDb>;

// Raw room row used to build RoomInput for compute (active tenancy + period reading).
export type BillRoomRow = {
  unitId: string;
  occupancyStatus: string;
  unitCode: string | null; // parent apartment's unitCode — display label (frontend §16)
  listingType: string | null; // e.g. "master" / "studio" — display label
  tenancy: { id: string; tenantPartyId: string; numberOfPax: number | null } | null;
  reading: { id: string; computedAmount: string; consumption: string; status: string; chargeId: string | null } | null;
};
