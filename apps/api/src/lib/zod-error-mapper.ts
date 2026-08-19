import type { ZodError, ZodIssue } from "zod";

type Domain =
  | "inventory"
  | "reservation"
  | "commission"
  | "agent-card"
  | "auth"
  | "billing"
  | "tenancy"
  | "listings"
  | "parties"
  | "payments"
  | "users"
  | "renovations"
  | "profile"
  | "document-templates"
  | "communications"
  | "source-queue"
  | "maintenance"
  | "sales"
  | "sales-claims"
  | "renovation-claims"
  | "tenant-ic"
  | "tasks"
  | "owner-billing"
  | "owner-ledger"
  | "owner-remittance"
  | "utility-billing-config"
  | "bills-grid";

const DOMAIN_FIELD_LABELS: Record<Domain, Record<string, string>> = {
  inventory: {
    unitNo: "Unit number",
    unitCode: "Unit code",
    unitType: "Unit type",
    propertyId: "Property",
    rentalRate: "Rental rate",
  },
  reservation: {
    tenantFullName: "Tenant full name",
    applicantFullName: "Applicant full name",
    applicantAddressLine1: "Address line 1",
    applicantAddressLine2: "Address line 2",
    applicantCity: "City",
    applicantPostcode: "Postcode",
    applicantState: "State",
    applicantCountry: "Country",
    rentalRate: "Rental rate",
    moveInDate: "Move-in date",
  },
  commission: {
    salesUnitId: "Sales unit",
    commissionPercent: "Commission %",
  },
  "agent-card": {
    slug: "Card link",
  },
  auth: {
    email: "Email",
    password: "Password",
  },
  billing: {},
  tenancy: {},
  listings: {},
  parties: {
    displayName: "Display name",
    legalName: "Company / legal name",
    primaryEmail: "Email",
    primaryPhone: "Phone",
    whatsappPhone: "WhatsApp",
    idType: "ID type",
    idNumber: "ID number",
    nationality: "Nationality",
    gender: "Gender",
    dateOfBirth: "Date of birth",
    occupation: "Occupation",
    employerName: "Employer",
    employerAddress: "Employer address",
    monthlyIncome: "Monthly income",
    emergencyContactName: "Emergency contact name",
    emergencyContactPhone: "Emergency contact phone",
    emergencyContactRelation: "Emergency contact relation",
    bankName: "Bank name",
    bankAccountHolder: "Account holder",
    bankAccountNumber: "Account number",
    reason: "Reason",
  },
  payments: {},
  users: {},
  renovations: {},
  profile: {},
  "document-templates": {},
  communications: {},
  "source-queue": {},
  maintenance: {},
  sales: {},
  "sales-claims": {},
  "renovation-claims": {},
  "tenant-ic": {},
  tasks: {},
  "owner-billing": {
    ownerPartyId: "Owner",
    propertyId: "Property",
    feeType: "Fee type",
    feeValue: "Fee value",
    capAmount: "Cap amount",
    sstPercent: "SST %",
    freePeriodStart: "Free-period start",
    freePeriodEnd: "Free-period end",
    isActive: "Active",
    effectiveFrom: "Effective from",
    effectiveTo: "Effective to",
  },
  "utility-billing-config": {
    subsidyPerPax: "Subsidy per pax",
  },
  "owner-ledger": {
    ownerPartyId: "Owner",
    propertyId: "Property",
    listingId: "Unit",
    tenancyId: "Tenancy",
    statementMonth: "Statement month",
    transactionDate: "Transaction date",
    direction: "Direction",
    category: "Category",
    amount: "Amount",
    sstAmount: "SST amount",
    paidBy: "Paid by",
    paymentStatus: "Payment status",
    taxCategory: "Tax category",
    month: "Month",
    fromMonth: "From month",
    toMonth: "To month",
  },
  "owner-remittance": {
    ownerPartyId: "Owner",
    amount: "Amount",
    effectiveDate: "Effective date",
    settlementKind: "Settlement kind",
    paymentMethod: "Payment method",
    bankReference: "Bank reference",
    proofKey: "Proof",
    memo: "Memo",
    currency: "Currency",
    allocations: "Allocations",
    idempotencyKey: "Idempotency key",
  },
  "bills-grid": {
    apartmentId: "Unit",
    periodMonth: "Billing month",
    readingDate: "Reading date",
    rental: "Rental",
    cleaning: "Cleaning",
    tnbTotal: "TNB total",
    airSelangor: "Water (Air Selangor)",
    wifi: "WiFi",
    maintenanceFee: "Maintenance fee",
    paymentStatus: "Payment status",
    tnbPattern: "TNB bearer pattern",
    airPattern: "Water bearer pattern",
    cleaningBearer: "Cleaning bearer",
    wifiBearer: "WiFi bearer",
    maintenanceFeeBearer: "Maintenance fee bearer",
    cleaningRecurringAmount: "Recurring cleaning amount",
    previousKwh: "Previous meter (kWh)",
    currentKwh: "Current meter (kWh)",
    amount: "Amount",
    description: "Description",
    withSST: "With SST",
    bearer: "Bearer",
    items: "Expense items",
  },
};

export interface FormatOpts {
  domain?: Domain;
}

export interface FormattedZodError {
  message: string;
  fieldErrors: Record<string, string>;
}

export function formatZodError(err: ZodError, opts: FormatOpts = {}): FormattedZodError {
  const labels = opts.domain ? (DOMAIN_FIELD_LABELS[opts.domain] ?? {}) : {};
  const fieldErrors: Record<string, string> = {};

  for (const issue of err.issues) {
    const path = issue.path.join(".");
    const label = labels[path] ?? path;
    const reason = humanizeIssue(issue, label);
    fieldErrors[path] = reason;
  }

  const fieldCount = Object.keys(fieldErrors).length;
  const message =
    fieldCount === 1
      ? Object.values(fieldErrors)[0]!
      : `Check the highlighted ${fieldCount} fields and try again.`;

  return { message, fieldErrors };
}

function humanizeIssue(issue: ZodIssue, label: string): string {
  switch (issue.code) {
    case "invalid_type": {
      // Zod v4 embeds received type in message; no top-level `received` field.
      return issue.message.includes("received undefined")
        ? `${label} is required.`
        : `${label} has an invalid format.`;
    }
    case "invalid_value":
      // Zod v4 enum validation failure
      return `${label} is not a valid option.`;
    case "too_small": {
      const origin = (issue as { origin?: string }).origin;
      return origin === "number" || origin === "bigint"
        ? `${label} is too small.`
        : `${label} is too short.`;
    }
    case "too_big": {
      const origin = (issue as { origin?: string }).origin;
      return origin === "number" || origin === "bigint"
        ? `${label} is too large.`
        : `${label} is too long.`;
    }
    case "invalid_format":
      return `${label} has an invalid format.`;
    default:
      return `${label}: ${issue.message}`;
  }
}
