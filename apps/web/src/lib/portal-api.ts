import { clearStoredAuth, getPortalToken } from "./auth";

const PORTAL_API_BASE = import.meta.env.VITE_PORTAL_API_URL || "/portal-api";

export type PortalApiErrorBody = {
  error?: ({ code: string; message: string } & Record<string, unknown>) | string;
} | null;

export class PortalApiError extends Error {
  public readonly status: number;
  public readonly body: PortalApiErrorBody;

  constructor(message: string, status: number, body: PortalApiErrorBody = null) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    this.body = body;
  }
}

type PortalFetchOptions = RequestInit & {
  redirectOnUnauthorized?: boolean;
};

export function portalApiUrl(path: string): string {
  return `${PORTAL_API_BASE}${path}`;
}

export async function portalApiFetch<T>(
  path: string,
  options?: PortalFetchOptions,
): Promise<T> {
  const { redirectOnUnauthorized = true, ...requestInit } = options ?? {};
  // Bearer-token fallback for iOS Safari, which silently drops the cross-site
  // portal_session cookie and bounces mobile users back to /portal/login.
  // The cookie still rides via credentials:"include" — backend takes either.
  const token = getPortalToken();
  const res = await fetch(portalApiUrl(path), {
    ...requestInit,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...requestInit.headers,
    },
  });

  if (res.status === 401 && redirectOnUnauthorized) {
    // Clear the bearer-token fallback so a stale token isn't replayed on the
    // next page load — would loop the user right back into the same 401.
    clearStoredAuth();
    window.location.href = "/portal/login";
    throw new PortalApiError("Session expired", 401);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as PortalApiErrorBody;
    // Server returns any of:
    //   { error: "string" }                  — legacy wrapped string
    //   { error: { code, message, ... } }    — structured wrapped (claims, parties)
    //   { code, message, ... }               — flat structured
    //   { code, ...details }                 — flat with no message (LISTING_MODE_MISMATCH)
    const errField = (body as Record<string, unknown> | null)?.error;
    const top = (body ?? {}) as Record<string, unknown>;
    let message: string | undefined;
    if (typeof errField === "string") {
      message = errField;
    } else if (errField && typeof errField === "object") {
      const inner = errField as Record<string, unknown>;
      if (typeof inner.message === "string") message = inner.message;
    }
    if (!message && typeof top.message === "string") message = top.message as string;
    if (!message) {
      message =
        res.status === 400
          ? "Bad request. Please check the form and try again."
          : res.status === 401
            ? "Your session has expired. Please log in again."
            : res.status === 403
              ? "You don't have permission to do that."
              : res.status === 404
                ? "That item was not found."
                : res.status === 409
                  ? "Conflict with an existing record. Refresh and try again."
                  : res.status === 422
                    ? "We couldn't process that — please check the form."
                    : res.status >= 500
                      ? "Server error. Try again in a moment, or contact support if it persists."
                      : `Request failed (${res.status}).`;
    }
    throw new PortalApiError(message, res.status, body);
  }

  return res.json();
}
