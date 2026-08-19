export type BillingSession = {
  userId: string;
  orgId: string;
  role: string;
};

export type ChargeEventListItem = {
  eventType: string;
  eventAt: string;
  payloadJson: unknown;
};

export type ChargeListItem = {
  id: string;
  chargeNumber: string;
  partyName: string;
  tenancyCode: string | null;
  unitCode: string | null;
  chargeType: string;
  status: string;
  dueDate: string;
  amount: number;
  outstandingAmount: number;
  currency: string;
  invoiceNumber: string | null;
  documentNumber: string | null;
  events: ChargeEventListItem[];
};
