export type LoginInput = {
  email: string;
  password: string;
};

export type AuthSession = {
  userId: string;
  orgId: string;
  role: string;
  userType?: string;
  partyId?: string;
};
