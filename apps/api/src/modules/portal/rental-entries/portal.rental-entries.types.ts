export type RentalEntryCtx = {
  orgId: string;
  agentPartyId: string;
  actorUserId: string;
};

export type RentalEntryResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: { code: string; message: string };
    };

export type CreatedRentalUnit = {
  id: string;
  propertyId: string;
  unitCode: string;
  sourcingApproved: boolean;
  listingStatus: string;
};
