export type PortalSessionPayload = {
  userId: string;
  orgId: string;
  role: string;
  userType: "tenant" | "agent" | "owner";
  partyId: string;
  iat: number;
  absoluteExp: number;
};

export type PortalEnv = {
  Variables: {
    session: PortalSessionPayload;
    authMethod: "cookie" | "bearer";
  };
};
