// Mock data for the Sales Entry + Renovation Claim review pages.
// Realistic Malaysian context (KL/Selangor) with off-plan project names that
// don't collide with the existing seed properties (which are the rental side).

export type RenovationStatus = "not_started" | "on_going" | "completed";
export type ClaimStatus = "submitted" | "pending_approval" | "approved";
export type PaymentType = "full" | "partial" | "offset_from_rental";
export type Purpose = "rent" | "own_stay";
export type PackageType = "standard" | "premium" | "premium_plus" | string;

export type MockProject = {
  id: string;
  name: string;
  developer: string;
  city: string;
  expectedHandover: string; // YYYY-MM-DD
  totalUnitsSecured: number;
};

export type MockSalesUnit = {
  id: string;
  projectId: string;
  unitNumber: string;
  ownerName: string;
  salesDate: string;
  purpose: Purpose;
  bedrooms: number;
  bathrooms: number;
  parkingLots: number;
  expectedRental: number; // MYR / month
  purchasePrice: number; // MYR (one-time)
  agentName: string; // who submitted
  renovation: {
    status: RenovationStatus;
    startDate: string | null;
    expectedCompletion: string | null;
    actualCompletion: string | null;
  };
};

export type MockClaimSplit = {
  partyName: string;
  role: string; // free text — "Sales Commission", "Project Leader Override", etc.
  type: "percent" | "fixed";
  value: number; // % or MYR
};

export type MockRenovationClaim = {
  id: string;
  salesUnitId: string;
  projectId: string;
  packagePrice: number;
  packageType: PackageType;
  splits: MockClaimSplit[];
  paymentType: PaymentType;
  monthlyOffsetAmount: number | null; // only set if offset_from_rental
  status: ClaimStatus;
  submittedAt: string;
  submittedBy: string;
  notes: string;
  documents: { kind: "quotation" | "invoice" | "agreement"; filename: string }[];
};

export type MockPackageType = {
  key: string;
  label: string;
  defaultPrice: number;
  description: string;
  archived: boolean;
};

export const MOCK_PROJECTS: MockProject[] = [
  {
    id: "proj-aurora",
    name: "Aurora Residences",
    developer: "Mah Sing Group",
    city: "Petaling Jaya",
    expectedHandover: "2026-09-30",
    totalUnitsSecured: 4,
  },
  {
    id: "proj-skyline",
    name: "The Skyline @ KLCC",
    developer: "EcoWorld Development",
    city: "Kuala Lumpur",
    expectedHandover: "2027-03-15",
    totalUnitsSecured: 3,
  },
  {
    id: "proj-pv9",
    name: "PV9 Phase 2",
    developer: "Platinum Victory",
    city: "Setapak",
    expectedHandover: "2026-12-01",
    totalUnitsSecured: 2,
  },
];

export const MOCK_SALES_UNITS: MockSalesUnit[] = [
  // Aurora — mix of states
  {
    id: "su-aurora-a1201",
    projectId: "proj-aurora",
    unitNumber: "A-12-01",
    ownerName: "Tan Wei Liang",
    salesDate: "2026-02-15",
    purpose: "rent",
    bedrooms: 3,
    bathrooms: 2,
    parkingLots: 2,
    expectedRental: 3200,
    purchasePrice: 850000,
    agentName: "Ahmad Rizal",
    renovation: {
      status: "completed",
      startDate: "2026-03-01",
      expectedCompletion: "2026-04-15",
      actualCompletion: "2026-04-20",
    },
  },
  {
    id: "su-aurora-a0805",
    projectId: "proj-aurora",
    unitNumber: "A-08-05",
    ownerName: "Lim Mei Hua",
    salesDate: "2026-03-10",
    purpose: "rent",
    bedrooms: 2,
    bathrooms: 2,
    parkingLots: 1,
    expectedRental: 2400,
    purchasePrice: 650000,
    agentName: "Priya Subramaniam",
    renovation: {
      status: "on_going",
      startDate: "2026-04-01",
      expectedCompletion: "2026-05-15",
      actualCompletion: null,
    },
  },
  {
    id: "su-aurora-a1503",
    projectId: "proj-aurora",
    unitNumber: "A-15-03",
    ownerName: "Datuk Ramesh Pillai",
    salesDate: "2026-04-05",
    purpose: "own_stay",
    bedrooms: 4,
    bathrooms: 3,
    parkingLots: 2,
    expectedRental: 0,
    purchasePrice: 1200000,
    agentName: "Ahmad Rizal",
    renovation: {
      status: "not_started",
      startDate: null,
      expectedCompletion: null,
      actualCompletion: null,
    },
  },
  {
    id: "su-aurora-a2001",
    projectId: "proj-aurora",
    unitNumber: "A-20-01",
    ownerName: "Wong Kah Lok",
    salesDate: "2026-04-12",
    purpose: "rent",
    bedrooms: 2,
    bathrooms: 1,
    parkingLots: 1,
    expectedRental: 2200,
    purchasePrice: 580000,
    agentName: "Farah Hassan",
    renovation: {
      status: "not_started",
      startDate: null,
      expectedCompletion: null,
      actualCompletion: null,
    },
  },
  // Skyline — mix
  {
    id: "su-skyline-b2301",
    projectId: "proj-skyline",
    unitNumber: "B-23-01",
    ownerName: "Sarah Chen",
    salesDate: "2026-01-20",
    purpose: "rent",
    bedrooms: 3,
    bathrooms: 2,
    parkingLots: 2,
    expectedRental: 4500,
    purchasePrice: 1450000,
    agentName: "Ahmad Rizal",
    renovation: {
      status: "completed",
      startDate: "2026-02-01",
      expectedCompletion: "2026-03-30",
      actualCompletion: "2026-04-02",
    },
  },
  {
    id: "su-skyline-b1207",
    projectId: "proj-skyline",
    unitNumber: "B-12-07",
    ownerName: "Yusof bin Hamzah",
    salesDate: "2026-03-25",
    purpose: "rent",
    bedrooms: 2,
    bathrooms: 2,
    parkingLots: 1,
    expectedRental: 3500,
    purchasePrice: 980000,
    agentName: "Priya Subramaniam",
    renovation: {
      status: "on_going",
      startDate: "2026-04-15",
      expectedCompletion: "2026-06-01",
      actualCompletion: null,
    },
  },
  {
    id: "su-skyline-b3502",
    projectId: "proj-skyline",
    unitNumber: "B-35-02",
    ownerName: "Aisyah binti Karim",
    salesDate: "2026-04-18",
    purpose: "own_stay",
    bedrooms: 4,
    bathrooms: 3,
    parkingLots: 3,
    expectedRental: 0,
    purchasePrice: 2200000,
    agentName: "Ahmad Rizal",
    renovation: {
      status: "not_started",
      startDate: null,
      expectedCompletion: null,
      actualCompletion: null,
    },
  },
  // PV9
  {
    id: "su-pv9-c1004",
    projectId: "proj-pv9",
    unitNumber: "C-10-04",
    ownerName: "Kumar Selvam",
    salesDate: "2026-02-28",
    purpose: "rent",
    bedrooms: 3,
    bathrooms: 2,
    parkingLots: 1,
    expectedRental: 2800,
    purchasePrice: 720000,
    agentName: "Farah Hassan",
    renovation: {
      status: "completed",
      startDate: "2026-03-15",
      expectedCompletion: "2026-04-25",
      actualCompletion: "2026-04-22",
    },
  },
];

export const MOCK_PACKAGE_TYPES: MockPackageType[] = [
  {
    key: "standard",
    label: "Standard",
    defaultPrice: 25000,
    description: "Basic refresh — paint, deep clean, minor fittings",
    archived: false,
  },
  {
    key: "premium",
    label: "Premium",
    defaultPrice: 45000,
    description: "Mid-tier — kitchen + 1 bathroom + flooring upgrade",
    archived: false,
  },
  {
    key: "premium_plus",
    label: "Premium Plus",
    defaultPrice: 75000,
    description: "Full — kitchen, all bathrooms, flooring, custom built-ins",
    archived: false,
  },
];

export const MOCK_RENOVATION_CLAIMS: MockRenovationClaim[] = [
  {
    id: "rc-1",
    salesUnitId: "su-aurora-a1201",
    projectId: "proj-aurora",
    packagePrice: 30000,
    packageType: "standard",
    splits: [
      { partyName: "Ahmad Rizal", role: "Sales Commission", type: "percent", value: 60 },
      { partyName: "Priya Subramaniam", role: "Project Leader Override", type: "percent", value: 15 },
      { partyName: "Kaen Operations", role: "House Keep", type: "percent", value: 25 },
    ],
    paymentType: "full",
    monthlyOffsetAmount: null,
    status: "approved",
    submittedAt: "2026-04-21",
    submittedBy: "Ahmad Rizal",
    notes: "Standard package; tenant target moved up — owner agreed to expedite.",
    documents: [
      { kind: "quotation", filename: "aurora-a1201-quote-30k.pdf" },
      { kind: "invoice", filename: "aurora-a1201-invoice-final.pdf" },
    ],
  },
  {
    id: "rc-2",
    salesUnitId: "su-aurora-a0805",
    projectId: "proj-aurora",
    packagePrice: 45000,
    packageType: "premium",
    splits: [
      { partyName: "Priya Subramaniam", role: "Sales Commission", type: "percent", value: 55 },
      { partyName: "Ahmad Rizal", role: "Co-broke Override", type: "percent", value: 20 },
      { partyName: "Kaen Operations", role: "House Keep", type: "percent", value: 25 },
    ],
    paymentType: "partial",
    monthlyOffsetAmount: null,
    status: "pending_approval",
    submittedAt: "2026-04-23",
    submittedBy: "Priya Subramaniam",
    notes: "Owner paid 50% upfront; balance on completion.",
    documents: [
      { kind: "quotation", filename: "aurora-a0805-premium-quote.pdf" },
      { kind: "agreement", filename: "aurora-a0805-renovation-agreement.pdf" },
    ],
  },
  {
    id: "rc-3",
    salesUnitId: "su-skyline-b2301",
    projectId: "proj-skyline",
    packagePrice: 75000,
    packageType: "premium_plus",
    splits: [
      { partyName: "Ahmad Rizal", role: "Sales Commission", type: "fixed", value: 12000 },
      { partyName: "Senior PM", role: "Project Leader Override", type: "fixed", value: 6000 },
      { partyName: "Kaen Operations", role: "House Keep", type: "fixed", value: 57000 },
    ],
    paymentType: "offset_from_rental",
    monthlyOffsetAmount: 1500,
    status: "approved",
    submittedAt: "2026-04-04",
    submittedBy: "Ahmad Rizal",
    notes: "Balance to be offset after tenant secured — RM1,500/mo over 50 months.",
    documents: [
      { kind: "quotation", filename: "skyline-b2301-pp-quote.pdf" },
      { kind: "invoice", filename: "skyline-b2301-final-invoice.pdf" },
      { kind: "agreement", filename: "skyline-b2301-offset-agreement.pdf" },
    ],
  },
  {
    id: "rc-4",
    salesUnitId: "su-skyline-b1207",
    projectId: "proj-skyline",
    packagePrice: 50000,
    packageType: "premium",
    splits: [
      { partyName: "Priya Subramaniam", role: "Sales Commission", type: "percent", value: 60 },
      { partyName: "Kaen Operations", role: "House Keep", type: "percent", value: 40 },
    ],
    paymentType: "full",
    monthlyOffsetAmount: null,
    status: "submitted",
    submittedAt: "2026-04-25",
    submittedBy: "Priya Subramaniam",
    notes: "",
    documents: [{ kind: "quotation", filename: "skyline-b1207-quote.pdf" }],
  },
  {
    id: "rc-5",
    salesUnitId: "su-pv9-c1004",
    projectId: "proj-pv9",
    packagePrice: 28000,
    packageType: "standard",
    splits: [
      { partyName: "Farah Hassan", role: "Sales Commission", type: "percent", value: 65 },
      { partyName: "Kaen Operations", role: "House Keep", type: "percent", value: 35 },
    ],
    paymentType: "full",
    monthlyOffsetAmount: null,
    status: "approved",
    submittedAt: "2026-04-23",
    submittedBy: "Farah Hassan",
    notes: "Quick turnaround; owner already lined up tenant.",
    documents: [
      { kind: "quotation", filename: "pv9-c1004-quote.pdf" },
      { kind: "invoice", filename: "pv9-c1004-invoice.pdf" },
    ],
  },
  {
    id: "rc-6",
    salesUnitId: "su-aurora-a2001",
    projectId: "proj-aurora",
    packagePrice: 25000,
    packageType: "standard",
    splits: [
      { partyName: "Farah Hassan", role: "Sales Commission", type: "percent", value: 55 },
      { partyName: "Ahmad Rizal", role: "Project Leader Override", type: "percent", value: 15 },
      { partyName: "Kaen Operations", role: "House Keep", type: "percent", value: 30 },
    ],
    paymentType: "partial",
    monthlyOffsetAmount: null,
    status: "submitted",
    submittedAt: "2026-04-26",
    submittedBy: "Farah Hassan",
    notes: "Renovation hasn't started yet — claim filed early per finance request.",
    documents: [],
  },
];

export const RENOVATION_STATUS_LABELS: Record<RenovationStatus, string> = {
  not_started: "Not Started",
  on_going: "On Going Renovation",
  completed: "Completed (Ready Move In)",
};

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  submitted: "Submitted",
  pending_approval: "Pending Approval",
  approved: "Approved",
};

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  full: "Full Payment",
  partial: "Partial Payment",
  offset_from_rental: "Offset from Rental",
};

export function projectFor(salesUnit: MockSalesUnit): MockProject | undefined {
  return MOCK_PROJECTS.find((p) => p.id === salesUnit.projectId);
}

export function salesUnitFor(claim: MockRenovationClaim): MockSalesUnit | undefined {
  return MOCK_SALES_UNITS.find((u) => u.id === claim.salesUnitId);
}

export function formatRMShort(value: number): string {
  return `RM ${value.toLocaleString("en-MY")}`;
}
