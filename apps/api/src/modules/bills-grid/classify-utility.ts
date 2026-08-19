import { UTILITY_SPEC, type Utility } from "./utility-spec";

export class ClassificationError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ClassificationError"; }
}
// Re-exported so existing importers keep their import site; the DECLARATION lives in
// utility-spec.ts, which is the one place a utility is defined.
export type { Utility };
export type FundedBy = "owner" | "manager" | "tenant_direct";
export interface ClassifyInput { utility: Utility; fundedBy: FundedBy; actualCost: number; chargedAmount: number; nature?: "expense" | "profit"; }
// Economics ONLY — no `family` (that is the CATEGORY's routing concern; Charge has no family column).
export interface ClassifyResult { revenueRecognition: "owner_funds" | "recovery_of_advance" | "manager_revenue"; settlementRecipient: "owner" | "manager"; taxTreatment: "out_of_scope_disbursement" | "taxable_service" | "pending_review"; markupAmount: number; }

export function classifyUtilityCharge(input: ClassifyInput): ClassifyResult {
  const markupAmount = Math.round((input.chargedAmount - input.actualCost) * 100) / 100;
  const hasMarkup = markupAmount > 0.005;
  // Read from the single utility declaration rather than a bucket list maintained here.
  // An unknown value arriving at runtime (outside the type) yields `undefined` and falls
  // through to the UNKNOWN_UTILITY throw below, exactly as the array-literal form did.
  const bucket = UTILITY_SPEC[input.utility]?.bucket;
  if (bucket === "subsidy") {
    // Owner-funded offset to the tenant (negative line): owner money, no KAEN revenue.
    return { revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 };
  }
  if (bucket === "passthrough") {
    if (hasMarkup) return { revenueRecognition: "manager_revenue", settlementRecipient: "manager", taxTreatment: "pending_review", markupAmount };
    if (input.fundedBy === "manager") return { revenueRecognition: "recovery_of_advance", settlementRecipient: "manager", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 };
    if (input.fundedBy === "owner") return { revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 };
    throw new ClassificationError("PASSTHROUGH_FUNDING", `pass-through ${input.utility} needs owner/manager funding, got ${input.fundedBy}`);
  }
  if (bucket === "service") {
    if (input.fundedBy === "owner") return { revenueRecognition: "owner_funds", settlementRecipient: "owner", taxTreatment: "out_of_scope_disbursement", markupAmount };
    if (input.nature === "expense") return { revenueRecognition: "recovery_of_advance", settlementRecipient: "manager", taxTreatment: "out_of_scope_disbursement", markupAmount: 0 };
    return { revenueRecognition: "manager_revenue", settlementRecipient: "manager", taxTreatment: "taxable_service", markupAmount };
  }
  throw new ClassificationError("UNKNOWN_UTILITY", `unknown utility ${String(input.utility)}`);
}
