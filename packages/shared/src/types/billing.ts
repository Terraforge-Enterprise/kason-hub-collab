export type ChargeStatus = "draft" | "posted" | "paid" | "partial" | "void";
export type PaymentStatus = "recorded" | "allocated" | "void" | "refunded";

export type ChargeEventType = "charge_created" | "charge_posted" | "charge_voided";

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
  events: ChargeEventListItem[];
};

export type PaymentAllocationItem = {
  id: string;
  chargeNumber: string;
  allocatedAmount: number;
  allocatedAt: string;
};

export type PaymentListItem = {
  id: string;
  paymentNumber: string;
  partyName: string;
  paymentType: string;
  paymentMethod: string;
  status: string;
  amount: number;
  currency: string;
  receivedAt: string;
  historySummary: string[];
  allocations: PaymentAllocationItem[];
};
