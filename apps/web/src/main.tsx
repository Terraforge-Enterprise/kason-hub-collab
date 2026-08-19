import { StrictMode, useState, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import {
  AuthContext,
  type User,
  getStoredUser,
  storeUser,
  clearStoredAuth,
} from "@/lib/auth";
import { ApiError } from "@/lib/api-client";
import { router } from "@/router";
import "./globals.css";

// Retry policy tuned for the Lightsail-container + Supabase cold-start window.
// After the API has been idle (overnight on UAT, between sessions on prod), the
// first request can hit a container whose DB connection pool is re-warming and
// briefly get a 5xx or a dropped connection. Rather than surfacing a hard
// "Failed to load…", we ride that out with a few backed-off retries — by the
// time they're exhausted (~15s) the pool is warm. Client errors (4xx) won't fix
// themselves, so we fail those fast. Queries are GETs, so retrying is safe.
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 5) return false;
  if (error instanceof ApiError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  // The 401-while-authenticated path in apiFetch already redirects to /login.
  if (error instanceof Error && error.message === "Session expired") return false;
  // No status → network/connection error (fetch threw). Transient — retry.
  return true;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 8000),
    },
  },
});

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(getStoredUser);

  const setAuth = useCallback((newUser: User) => {
    storeUser(newUser);
    setUser(newUser);
  }, []);

  const clearAuth = useCallback(() => {
    clearStoredAuth();
    setUser(null);
    queryClient.clear();
  }, []);

  const value = useMemo(
    () => ({
      user,
      setAuth,
      clearAuth,
      isAuthenticated: !!user,
    }),
    [user, setAuth, clearAuth]
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster position="top-right" richColors />
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>
);
