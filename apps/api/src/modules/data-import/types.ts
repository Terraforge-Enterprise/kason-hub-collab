export interface ReportRow {
  sheet: string;
  row: number;
  unitCode: string | null;
  room: string | null;
  tenantMasked: string; // MUST NOT contain raw name/IC/phone (PDPA)
  partyAction: string; // "create" | "match" | "skip"
  tenancyAction: string; // "create" | "exists" | "skip"
  carparkAction: string | null;
  meterAction: string | null;
  conflict: string | null;
  notes: string | null;
}

export interface ImportSession {
  orgId: string;
  userId: string;
  role: "admin";
  userType: "operator";
}

export interface RawTenantRow {
  sheet: string;
  rowNumber: number;
  propertyName: string;
  unitCode: string | null;
  roomName: string | null;
  tenantNameRaw: string | null;
  coTenantNames: string[];
  rentalRoom: number | null;
  rentalCarpark: number | null;
  carparkCol: string | null;
  accessCardNo: string | null;
  numberOfPax: number | null;
  idNumber: string | null;
  phoneRaw: string | null;
  email: string | null;
  gender: "male" | "female" | null;
  moveIn: Date | null;
  moveOut: Date | null;
  termMonths: number | null;
  agentLabel: string | null;
  latestReading: number | null;
  readingMonotonic: boolean;
}
