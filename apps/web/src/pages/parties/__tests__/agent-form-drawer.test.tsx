import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Sonner — keep toast call-tracking for assertions about the "Saved" toast.
vi.mock("sonner", () => {
  const success = vi.fn();
  const error = vi.fn();
  const info = vi.fn();
  const toastBase = vi.fn();
  (toastBase as { success?: typeof success }).success = success;
  (toastBase as { error?: typeof error }).error = error;
  (toastBase as { info?: typeof info }).info = info;
  return { toast: toastBase };
});

vi.mock("@/lib/auth", () => ({
  getStoredUser: vi.fn(() => ({ id: "u1", fullName: "Test", role: "admin" })),
  clearStoredAuth: vi.fn(),
  getAdminToken: vi.fn(() => null),
  getPortalToken: vi.fn(() => null),
}));

import { toast } from "sonner";
import { AgentFormDrawer } from "../agent-form-drawer";
import type { AgentListItem } from "../agents-table";

const toastSuccess = (toast as unknown as { success: ReturnType<typeof vi.fn> }).success;
const toastInfo = (toast as unknown as { info: ReturnType<typeof vi.fn> }).info;
const toastFn = toast as unknown as ReturnType<typeof vi.fn>;

const sampleAgent: AgentListItem = {
  id: "agent-1",
  displayName: "Farah Chen",
  legalName: "Farah Chen Sdn. Bhd.",
  primaryEmail: "farah@example.com",
  primaryPhone: "+60 12-345-6789",
  formattedPhone: "+60 12-345 6789",
  nationality: "MY",
  agentLevel: "new_agent",
  status: "active",
  isBlacklisted: false,
  updatedAt: "2026-04-20T12:00:00.000Z",
  createdAt: "2026-04-01T12:00:00.000Z",
  bankName: "Maybank Berhad",
  bankAccountHolder: "Farah Chen",
  bankAccountNumber: "1234567890",
  idType: "ic",
  idNumber: "880101-01-1234",
  portalUser: null,
  uplineId: null,
  upline: null,
  photoUrl: null,
};

const sampleDetail = {
  id: sampleAgent.id,
  displayName: sampleAgent.displayName,
  legalName: sampleAgent.legalName,
  primaryEmail: sampleAgent.primaryEmail,
  primaryPhone: sampleAgent.primaryPhone,
  idType: sampleAgent.idType,
  idNumber: sampleAgent.idNumber,
  nationality: sampleAgent.nationality,
  agentLevel: sampleAgent.agentLevel,
  bank: {
    name: sampleAgent.bankName,
    accountHolder: sampleAgent.bankAccountHolder,
    accountNumber: sampleAgent.bankAccountNumber,
  },
  status: sampleAgent.status,
  isBlacklisted: false,
  blacklistReason: null,
  portalUser: null,
  claimStats: { submitted: 0, approved: 0, paid: 0, rejected: 0, totalPaidCommission: 0 },
  uplineId: null,
  upline: null,
  createdAt: sampleAgent.createdAt,
  updatedAt: sampleAgent.updatedAt,
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AgentFormDrawer — dirty-tracking + rollback survival", () => {
  const originalFetch = globalThis.fetch;
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
    globalThis.fetch = vi.fn();
    toastSuccess.mockClear();
    toastFn.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function setupFetchSequence(...responses: Array<() => Response | Promise<Response>>) {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    let i = 0;
    fetchMock.mockImplementation(async () => {
      const fn = responses[Math.min(i, responses.length - 1)];
      i++;
      return fn();
    });
    return fetchMock;
  }

  it("only-dirty-field PATCH: changing agentLevel sends a payload with just agentLevel + updatedAt", async () => {
    // 1st call: GET /parties/agents/:id detail. 2nd: PUT update.
    setupFetchSequence(
      () => makeResponse({ data: sampleDetail }, 200),
      () => makeResponse({ id: sampleAgent.id, updatedAt: "2026-04-21T00:00:00.000Z" }, 200),
    );
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    render(
      <AgentFormDrawer open mode="edit" agent={sampleAgent} onClose={() => {}} />,
      { wrapper: makeWrapper(queryClient) },
    );

    // Wait for the detail fetch to resolve so the form is fully hydrated.
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      expect(calls.some((c) => String(c[0]).includes(`/parties/agents/${sampleAgent.id}`))).toBe(true);
    });

    // Change ONLY the agent level.
    const select = (await screen.findByLabelText(/agent level/i)) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "pre_leader" } });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    // Find the PUT call.
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined;
        return init?.method === "PUT";
      });
      expect(putCall).toBeTruthy();
    });

    const putCall = fetchMock.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      return init?.method === "PUT";
    });
    const init = putCall?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // ONLY agentLevel + updatedAt — no other fields leaked.
    expect(Object.keys(body).sort()).toEqual(["agentLevel", "updatedAt"]);
    expect(body.agentLevel).toBe("pre_leader");
    expect(body.updatedAt).toBe(sampleAgent.updatedAt);
  });

  it("409 rollback: form state and dirty edit are preserved (user can resubmit)", async () => {
    // 1st: detail fetch. 2nd: PUT returns 409.
    setupFetchSequence(
      () => makeResponse({ data: sampleDetail }, 200),
      () => makeResponse({ error: "Record changed — reloaded" }, 409),
    );
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const onClose = vi.fn();

    render(
      <AgentFormDrawer open mode="edit" agent={sampleAgent} onClose={onClose} />,
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      expect(calls.some((c) => String(c[0]).includes(`/parties/agents/${sampleAgent.id}`))).toBe(true);
    });

    const select = (await screen.findByLabelText(/agent level/i)) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "leader" } });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    // Wait for the conflict toast (proxy for mutation settling on error).
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith("Record changed — reloaded");
    });

    // The drawer must NOT close on 409.
    expect(onClose).not.toHaveBeenCalled();

    // The user's edit must still be visible in the form.
    const stillSelected = (screen.getByLabelText(/agent level/i)) as HTMLSelectElement;
    expect(stillSelected.value).toBe("leader");
  });

  it("empty string submitted explicitly: payload includes primaryEmail: \"\" (not omitted)", async () => {
    setupFetchSequence(
      () => makeResponse({ data: sampleDetail }, 200),
      () => makeResponse({ id: sampleAgent.id, updatedAt: "x" }, 200),
    );
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    render(
      <AgentFormDrawer open mode="edit" agent={sampleAgent} onClose={() => {}} />,
      { wrapper: makeWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes(`/parties/agents/${sampleAgent.id}`)),
      ).toBe(true);
    });

    const emailInput = (await screen.findByLabelText(/^email$/i)) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined;
        return init?.method === "PUT";
      });
      expect(putCall).toBeTruthy();
    });

    const putCall = fetchMock.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      return init?.method === "PUT";
    });
    const init = putCall?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    // primaryEmail MUST be present, MUST be empty string — user intent
    // (clearing the field) reaches the server as `""`. The server then
    // coerces to null. This is the contract the parties service tests assert.
    expect(body).toHaveProperty("primaryEmail");
    expect(body.primaryEmail).toBe("");
  });
});

describe("AgentFormDrawer — restructure toasts on save", () => {
  const originalFetch = globalThis.fetch;
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = makeQueryClient();
    globalThis.fetch = vi.fn();
    toastSuccess.mockClear();
    toastInfo.mockClear();
    toastFn.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function setupFetchSequence(...responses: Array<() => Response | Promise<Response>>) {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    let i = 0;
    fetchMock.mockImplementation(async () => {
      const fn = responses[Math.min(i, responses.length - 1)];
      i++;
      return fn();
    });
    return fetchMock;
  }

  async function triggerLevelSaveAndWaitForPut(level: string) {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    render(
      <AgentFormDrawer open mode="edit" agent={sampleAgent} onClose={() => {}} />,
      { wrapper: makeWrapper(queryClient) },
    );
    // Wait for detail fetch to land so the form hydrates.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes(`/parties/agents/${sampleAgent.id}`)),
      ).toBe(true);
    });
    const select = (await screen.findByLabelText(/agent level/i)) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: level } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    // Wait until the PUT settles (factory's onSuccess fires the "Saved" toast).
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Saved");
    });
  }

  it("does not show restructure toast when response has no restructured field", async () => {
    // PUT response = flat shape with NO `restructured` key (server omits when empty).
    setupFetchSequence(
      () => makeResponse({ data: sampleDetail }, 200),
      () => makeResponse({ id: sampleAgent.id, updatedAt: "2026-05-24T00:00:00.000Z" }, 200),
    );

    await triggerLevelSaveAndWaitForPut("pre_leader");

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("shows a single info toast when one restructure entry is returned", async () => {
    setupFetchSequence(
      () => makeResponse({ data: sampleDetail }, 200),
      () =>
        makeResponse(
          {
            id: sampleAgent.id,
            updatedAt: "2026-05-24T00:00:00.000Z",
            restructured: [
              {
                agentId: "priya",
                agentName: "Priya a/p Subramaniam",
                oldUplineId: "farah",
                oldUplineName: "Farah binti Hassan",
                oldUplineLevel: "pre_leader",
                newUplineId: "sarah",
                newUplineName: "Sarah Tan",
                newUplineLevel: null,
              },
            ],
          },
          200,
        ),
    );

    await triggerLevelSaveAndWaitForPut("leader");

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledOnce();
    });
    const msg = String(toastInfo.mock.calls[0]?.[0] ?? "");
    expect(msg).toMatch(/Priya a\/p Subramaniam/);
    expect(msg).toMatch(/Farah binti Hassan/);
    expect(msg).toMatch(/Sarah Tan/);
  });

  it("shows one combined info toast when multiple restructure entries are returned", async () => {
    setupFetchSequence(
      () => makeResponse({ data: sampleDetail }, 200),
      () =>
        makeResponse(
          {
            data: { id: sampleAgent.id, updatedAt: "2026-05-24T00:00:00.000Z" },
            restructured: [
              {
                agentId: "priya",
                agentName: "Priya a/p Subramaniam",
                oldUplineId: "farah",
                oldUplineName: "Farah binti Hassan",
                oldUplineLevel: "pre_leader",
                newUplineId: "sarah",
                newUplineName: "Sarah Tan",
                newUplineLevel: null,
              },
              {
                agentId: "amir",
                agentName: "Amir bin Abdullah",
                oldUplineId: "farah",
                oldUplineName: "Farah binti Hassan",
                oldUplineLevel: "pre_leader",
                newUplineId: "sarah",
                newUplineName: "Sarah Tan",
                newUplineLevel: null,
              },
            ],
          },
          200,
        ),
    );

    await triggerLevelSaveAndWaitForPut("leader");

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledOnce();
    });
    const msg = String(toastInfo.mock.calls[0]?.[0] ?? "");
    expect(msg).toMatch(/2 downlines/);
  });
});
