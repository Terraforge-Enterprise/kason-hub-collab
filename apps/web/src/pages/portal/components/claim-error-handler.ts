import { toast } from "sonner";
import type { ClaimErrorCode } from "@kason/shared";

type ClaimErrorResponse = {
  error: { code: ClaimErrorCode; message: string } & Record<string, unknown>;
};

export type ClaimErrorUIAction = {
  toastTitle: string;
  toastDescription: string;
  bannerMessage: string;
  focusFieldPath?: string;
  linkToClaimNumber?: string;
};

export function handleClaimError(body: ClaimErrorResponse): ClaimErrorUIAction {
  const { code, message } = body.error;
  switch (code) {
    case "rule_a_duplicate": {
      const keyIndex = (body.error as { keyIndex?: number }).keyIndex;
      return {
        toastTitle: "Duplicate items",
        toastDescription: message,
        bannerMessage: message,
        focusFieldPath: typeof keyIndex === "number" ? `items[${keyIndex}].unitCode` : undefined,
      };
    }
    case "rule_b_same_agent_active": {
      const prior = (body.error as { priorClaimNumber?: string }).priorClaimNumber;
      return {
        toastTitle: "Submission blocked",
        toastDescription: message,
        bannerMessage: message,
        linkToClaimNumber: prior,
      };
    }
    case "rule_c_sum_exceeded":
      return {
        toastTitle: "Over 100%",
        toastDescription: message,
        bannerMessage: message,
      };
    case "forbidden_transition":
      return {
        toastTitle: "Action not available",
        toastDescription: message,
        bannerMessage: message,
      };
    case "validation": {
      const fieldPath = (body.error as { fieldPath?: string }).fieldPath;
      return {
        toastTitle: "Please review the form",
        toastDescription: message,
        bannerMessage: message,
        focusFieldPath: fieldPath,
      };
    }
    case "not_found":
      return {
        toastTitle: "Not found",
        toastDescription: message,
        bannerMessage: message,
      };
    case "conflict":
    case "internal":
    default:
      return {
        toastTitle: "Submission failed",
        toastDescription: message,
        bannerMessage: message,
      };
  }
}

export function applyClaimErrorUI(
  body: ClaimErrorResponse,
  setBanner: (msg: string | null) => void,
): ClaimErrorUIAction {
  const ui = handleClaimError(body);
  toast.error(ui.toastTitle, { description: ui.toastDescription, duration: 8000 });
  setBanner(ui.bannerMessage);
  return ui; // returned so callers can use focusFieldPath / linkToClaimNumber
}
