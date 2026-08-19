export type CommissionsSession = {
  userId: string;
  orgId: string;
  role: string;
  // Optional because admin/manager sessions may not be tied to a Party row;
  // required in practice for any path that enforces party-scoped auth
  // (e.g. agent self-only PDF download).
  partyId?: string | null;
};
