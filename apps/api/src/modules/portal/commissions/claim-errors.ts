export type ClaimErrorCode =
  | "rule_a_duplicate"
  | "rule_b_same_agent_active"
  | "rule_c_sum_exceeded"
  | "ta_share_sum_invalid"
  | "ta_tier_mismatch"
  | "validation"
  | "forbidden_transition"
  | "not_found"
  | "conflict"
  | "internal";

export type ClaimErrorPayloads = {
  rule_a_duplicate: { keyIndex: number };
  rule_b_same_agent_active: { priorClaimNumber: string };
  rule_c_sum_exceeded: {
    availableMax: string;
    existingPct: string;
    proposedPct: string;
    totalPct: string;
    key: { propertyId: string; unitCodeLower: string; roomTypeLower: string; moveInDate: string };
  };
  ta_share_sum_invalid: {
    existingPct: string;
    proposedPct: string;
    totalPct: string;
    key: { propertyId: string; unitCode: string; roomType: string; moveInDate: string };
  };
  ta_tier_mismatch: { expected: string | null; given: string; reason?: string };
  validation: { fieldPath?: string };
  forbidden_transition: { from: string; to: string };
  not_found: Record<never, never>;
  conflict: Record<never, never>;
  internal: Record<never, never>;
};

export type ClaimErrorData<C extends ClaimErrorCode = ClaimErrorCode> = {
  message: string;
} & ClaimErrorPayloads[C];

export type ClaimErrorResponseBody<C extends ClaimErrorCode = ClaimErrorCode> = {
  error: { code: C; message: string } & ClaimErrorPayloads[C];
};

const BRAND = Symbol.for("kason.ClaimError");

export class ClaimError<C extends ClaimErrorCode = ClaimErrorCode> extends Error {
  public readonly [BRAND] = true;
  public readonly code: C;
  public readonly data: ClaimErrorData<C>;

  constructor(code: C, data: ClaimErrorData<C>) {
    super(data.message);
    this.name = "ClaimError";
    this.code = code;
    this.data = data;
  }

  toResponseBody(): ClaimErrorResponseBody<C> {
    const { message, ...rest } = this.data;
    return { error: { code: this.code, message, ...rest } } as ClaimErrorResponseBody<C>;
  }
}

export function isClaimError(value: unknown): value is ClaimError {
  return (
    value != null &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[BRAND] === true
  );
}

export function claimErrorToHttpStatus(code: ClaimErrorCode): 400 | 403 | 404 | 409 | 422 | 500 {
  switch (code) {
    case "validation": return 400;
    case "forbidden_transition": return 403;
    case "not_found": return 404;
    case "rule_a_duplicate":
    case "rule_b_same_agent_active":
    case "rule_c_sum_exceeded":
    case "conflict":
      return 409;
    case "ta_share_sum_invalid": return 422;
    case "ta_tier_mismatch": return 422;
    case "internal":
    default:
      return 500;
  }
}
