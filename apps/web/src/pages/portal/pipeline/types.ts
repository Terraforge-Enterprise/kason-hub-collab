export type SalesTrackerRow = {
  id: string;
  projectName: string;
  unitNumber: string;
  ownerName: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  derivedStatus:
    | "pending_review"
    | "approved_no_reno"
    | "not_started"
    | "on_going"
    | "completed"
    | "graduated";
  renovationProgress: {
    id: string;
    status: "not_started" | "on_going" | "completed";
    stages: Array<{
      stageProgressId: string;
      stageKey: string;
      stageLabel: string;
      sortOrder: number;
      status: "pending" | "in_progress" | "completed";
    }>;
  } | null;
};

export type RentalTrackerRow = {
  id: string;
  propertyName: string;
  unitCode: string;
  bedrooms: number | null;
  rentalRate: number | null;
  furnishingLevel: string | null;
  derivedStatus: "pending_review" | "approved" | "tenanted" | "vacated";
  picName: string;
};

export type TabKey = "sales" | "rentals";
