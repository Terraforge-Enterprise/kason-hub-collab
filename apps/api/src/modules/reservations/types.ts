// apps/api/src/modules/reservations/types.ts

export type ReservationStatus =
  | "pending_approval"
  | "needs_amendment"
  | "pending_customer"
  | "signed"
  | "cancelled"
  | "expired";

export type ReservationSession = {
  orgId: string;
  userId: string;
  partyId: string;
  role: "admin" | "agent" | "viewer";
  // Set only when role === "admin". Distinguishes the operator's real role
  // since the admin adapter flattens manager + editor + admin into role:"admin".
  operatorRole?: "admin" | "manager" | "editor";
};

export type SectionAInput = {
  propertyId: string;
  unitId: string;
  carPark?: string | null;
  proposedMoveIn: string; // ISO date
  proposedMoveOut?: string | null;
  specialRemarks?: string | null;
  reservationDeposit: string; // decimal as string
  documentationFee: string;
  rentalDeposit: string;
  utilityDeposit: string;
  accessCardDeposit: string;
  customerEmail: string;
  agreedMonthlyRent: string;
  customTerms?: string[];
};

export type SectionBInput = {
  applicantFullName: string;
  applicantNric: string;
  applicantContact: string;
  applicantEmail: string;
  applicantAddressLine1: string;
  applicantAddressLine2?: string;
  applicantCity: string;
  applicantPostcode: string;
  applicantState: string;
  applicantCountry: string;
  nationality: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation?: string;
  occupation?: string;
  monthlyIncome?: string;
};

export type SignInput = {
  typedName: string;
  agreementTicked: boolean;
  signaturePngBase64: string; // "data:image/png;base64,..."
};

export type ReservationDto = {
  id: string;
  referenceCode: string;
  status: ReservationStatus;
  issuedAt: string;
  expiresAt: string;
  property: { id: string; name: string };
  unit: { id: string; unitCode: string };
  carPark: string | null;
  proposedMoveIn: string;
  proposedMoveOut: string | null;
  specialRemarks: string | null;
  charges: {
    reservationDeposit: string;
    documentationFee: string;
    rentalDeposit: string;
    utilityDeposit: string;
    accessCardDeposit: string;
  };
  // The agreed monthly rent recorded on the reservation. A downstream tenancy
  // can source its monthlyRentAmount from here. Null for legacy reservations
  // created before the field became required.
  agreedMonthlyRent: string | null;
  applicant: {
    fullName: string | null;
    nric: string | null;
    contact: string | null;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postcode: string | null;
    state: string | null;
    country: string | null;
    nationality: string | null;
    occupation: string | null;
    monthlyIncome: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    emergencyContactRelation: string | null;
  };
  documents: { id: string; kind: string; filename: string; uploadedAt: string }[];
  signedAt: string | null;
  signedPdfDownloadUrl: string | null;
  customTerms: string[];
  approvalNote: string | null;
  publicToken?: string; // admin/manager + issuing-agent, only when status === "pending_customer"
};
