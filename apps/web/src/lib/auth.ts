import { createContext, useContext } from "react";

export interface User {
  id: string;
  fullName: string;
  email: string;
  role: string;
  orgId: string;
  userType?: string;
  permissions?: string[];
}

export interface AuthContextType {
  user: User | null;
  setAuth: (user: User) => void;
  clearAuth: () => void;
  isAuthenticated: boolean;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/**
 * localStorage writes THROW in Safari Private Browsing, under "block all
 * cookies", in hardened/enterprise profiles, and when the quota is full — so
 * every writer here has to swallow, exactly as the readers and clearStoredAuth
 * already do. Callers store a token and then navigate; an escaping write error
 * skips the navigation and strands the user on a form whose submit already
 * succeeded server-side. Losing the bearer-token fallback degrades that session
 * to cookie-only auth, which is the correct trade against a dead-end screen.
 */
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked or full — cookie auth still carries the session
  }
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem("kh_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function storeUser(user: User): void {
  writeStorage("kh_user", JSON.stringify(user));
}

// Bearer-token fallback: iOS Safari drops the cross-site session cookie
// (CloudFront web → Lightsail api are different eTLD+1) so mobile users get
// bounced back to /login. We keep the HttpOnly cookie as the primary
// (XSS-safer on desktop) and ALSO store the token so apiFetch / portalApiFetch
// can attach an Authorization: Bearer header — the backend middleware accepts
// either (see apps/api/src/middleware/auth.ts:21-26 and
// apps/api/src/modules/portal/auth/portal.auth.middleware.ts:37-38).
const ADMIN_TOKEN_KEY = "kh_token";
const PORTAL_TOKEN_KEY = "kh_portal_token";

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  writeStorage(ADMIN_TOKEN_KEY, token);
}

export function getPortalToken(): string | null {
  try {
    return localStorage.getItem(PORTAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setPortalToken(token: string): void {
  writeStorage(PORTAL_TOKEN_KEY, token);
}

export function clearStoredAuth(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(PORTAL_TOKEN_KEY);
    localStorage.removeItem("kh_user");
  } catch {
    // storage blocked (private mode) — nothing stored, nothing to clear;
    // must not throw or the 401 redirect to login never runs
  }
}
