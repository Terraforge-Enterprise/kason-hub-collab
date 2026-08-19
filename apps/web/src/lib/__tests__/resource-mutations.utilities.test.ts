import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Sonner mock ──────────────────────────────────────────────────────────────
vi.mock("sonner", () => {
  const success = vi.fn();
  const error = vi.fn();
  const toastBase = vi.fn();
  (toastBase as any).success = success;
  (toastBase as any).error = error;
  return { toast: toastBase };
});

// ── Auth mock (required by api-client import chain) ──────────────────────────
vi.mock("../auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "1", fullName: "Test" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { toast } from "sonner";
import { ApiError } from "../api-client";
import {
  handleMutationError,
  useResourceInvalidation,
  DEFAULT_CONFLICT_TEXT,
} from "../resource-mutations";

// Typed handles for assertions — resolved after mocks are installed
const toastFn = toast as unknown as ReturnType<typeof vi.fn>;
const toastError = (toast as any).error as ReturnType<typeof vi.fn>;

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("handleMutationError", () => {
  beforeEach(() => {
    toastFn.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. ApiError 409 → bare (info) toast with server message ─────────────
  it("ApiError 409: shows server message on info toast, not toast.error", () => {
    const invalidate = vi.fn();
    const err = new ApiError("A tier mapping for X / Y already exists", 409);

    handleMutationError(err, invalidate);

    expect(toastFn).toHaveBeenCalledWith("A tier mapping for X / Y already exists");
    expect(toastError).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  // ── 1b. ApiError 409 with empty message → falls back to DEFAULT_CONFLICT_TEXT
  it("ApiError 409 with empty message: falls back to DEFAULT_CONFLICT_TEXT", () => {
    const invalidate = vi.fn();
    const err = new ApiError("", 409);

    handleMutationError(err, invalidate);

    expect(toastFn).toHaveBeenCalledWith(DEFAULT_CONFLICT_TEXT);
    expect(toastError).not.toHaveBeenCalled();
  });

  // ── 2. ApiError 500 → toast.error with err.message ────────────────────────
  it("ApiError 500: calls toast.error with the error message, calls invalidate", () => {
    const invalidate = vi.fn();
    const err = new ApiError("Internal server error", 500);

    handleMutationError(err, invalidate);

    expect(toastError).toHaveBeenCalledWith("Internal server error");
    expect(toastFn).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  // ── 3. Plain Error (not ApiError) → toast.error with message ──────────────
  it("plain Error: calls toast.error with the error message, calls invalidate", () => {
    const invalidate = vi.fn();
    const err = new Error("Network failure");

    handleMutationError(err, invalidate);

    expect(toastError).toHaveBeenCalledWith("Network failure");
    expect(toastFn).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  // ── 4. Custom conflictText as fallback when server omits message ─────────
  it("uses custom conflictText fallback when server message is empty on 409", () => {
    const invalidate = vi.fn();
    const err = new ApiError("", 409);
    const customText = "Someone else changed this record";

    handleMutationError(err, invalidate, { conflictText: customText });

    expect(toastFn).toHaveBeenCalledWith(customText);
    expect(toastError).not.toHaveBeenCalled();
  });

  // ── 5. Fallback message when err.message is empty ─────────────────────────
  it("uses fallbackMessage when err.message is empty", () => {
    const invalidate = vi.fn();
    const err = new ApiError("", 503);
    const fallback = "Operation failed — please try again";

    handleMutationError(err, invalidate, { fallbackMessage: fallback });

    expect(toastError).toHaveBeenCalledWith(fallback);
    expect(toastFn).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

describe("useResourceInvalidation", () => {
  // ── 6. Returns callback that invalidates with exact: false ─────────────────
  it("returned callback calls queryClient.invalidateQueries with given queryKey and exact: false", () => {
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const queryKey = ["commissions", "claims"] as const;

    const { result } = renderHook(() => useResourceInvalidation(queryKey), {
      wrapper: makeWrapper(queryClient),
    });

    result.current();

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey, exact: false }),
    );
  });
});
