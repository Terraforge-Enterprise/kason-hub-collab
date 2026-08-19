export type SalesClaimDefaultRow = {
  id: string;
  organizationId: string;
  appliesTo: string;
  commissionType: string;
  commissionValue: string;          // Decimal serialized as string
  paymentType: string;
  notes: string | null;
  updatedAt: string;
  updatedById: string | null;
  defaultSplits: Array<{
    id: string;
    organizationId: string;
    defaultId: string;
    roleLabel: string;
    splitType: string;
    splitValue: string;
    sortOrder: number;
  }>;
};
