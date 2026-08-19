export type OwnerListItem = {
  id: string;
  displayName: string;
  legalName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  nationality: string | null;
  isBlacklisted: boolean;
  status: string;
  createdAt: string;
};

export type TenantListItem = {
  id: string;
  displayName: string;
  legalName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  nationality: string | null;
  occupation: string | null;
  isBlacklisted: boolean;
  status: string;
  createdAt: string;
};
