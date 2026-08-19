import { clearStoredAuth, getAdminToken, getStoredUser } from "./auth";

export const API_BASE = import.meta.env.VITE_API_URL || "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  // Raw body parsed from the error response (available for structured 4xx bodies).
  readonly data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// Pull a user-facing message + machine code out of any backend error shape:
//   { error: "string" }                — legacy wrapped string
//   { error: { code, message } }       — wrapped structured (invalid_body etc.)
//   { code, message, ...details }      — flat structured at top level
//   { code, currentMode, attemptedKind } — flat structured with no message (LISTING_MODE_MISMATCH)
//   anything else                      — fall back to status-aware wording
// Per-component onError handlers can still check err.code/err.data for
// domain-specific UX, but the default toast.error(err.message) now reads
// well in every case instead of "API error 400".
export function extractApiError(
  body: unknown,
  status: number,
): { message: string; code?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const errField = b.error;
  const topLevelCode = typeof b.code === "string" ? (b.code as string) : undefined;
  const topLevelMessage = typeof b.message === "string" ? (b.message as string) : undefined;

  let message: string | undefined;
  let code: string | undefined = topLevelCode;

  if (typeof errField === "string") {
    message = errField;
  } else if (errField && typeof errField === "object") {
    const inner = errField as Record<string, unknown>;
    if (typeof inner.message === "string") message = inner.message;
    if (!code && typeof inner.code === "string") code = inner.code as string;
  }
  if (!message && topLevelMessage) message = topLevelMessage;

  if (!message) {
    message =
      status === 400
        ? "Bad request. Please check the form and try again."
        : status === 401
          ? "Your session has expired. Please log in again."
          : status === 403
            ? "You don't have permission to do that."
            : status === 404
              ? "That item was not found."
              : status === 409
                ? "Conflict with an existing record. Refresh and try again."
                : status === 422
                  ? "We couldn't process that — please check the form."
                  : status >= 500
                    ? "Server error. Try again in a moment, or contact support if it persists."
                    : `Request failed (${status}).`;
  }
  return { message, code };
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  // Attach the bearer token from localStorage when we have one. The cookie is
  // still sent via credentials:"include" — backend accepts either. On iOS
  // Safari the cross-site cookie is silently dropped; the bearer header is
  // what keeps the session alive there.
  const token = getAdminToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    const wasAuthenticated = !!getStoredUser();
    if (wasAuthenticated) {
      clearStoredAuth();
      window.location.href = "/login";
      throw new Error("Session expired");
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const { message, code } = extractApiError(body, res.status);
    throw new ApiError(message, res.status, code, body);
  }

  return res.json();
}
