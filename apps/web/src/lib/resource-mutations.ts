import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, ApiError } from "./api-client";

export const DEFAULT_CONFLICT_TEXT = "Record changed — reloaded";

/**
 * Returns a copy of `obj` with every key whose value is strictly `undefined`
 * removed. Used to sanitise patches before optimistic spread merges:
 *
 *   { ...prevDetail, ...patch }
 *
 * If `patch.email === undefined`, the spread CLOBBERS prevDetail.email
 * with `undefined`, even though Prisma's `update({ data })` would have
 * skipped it. Strip these keys so the optimistic cache reflects what the
 * server will persist (unchanged for those fields).
 *
 * Note: empty strings are intentionally preserved — `""` is a meaningful
 * value (the user cleared the field) and must reach the server.
 */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
      out[k] = obj[k];
    }
  }
  return out;
}

/**
 * Hook that returns a stable `invalidate` callback for the given queryKey prefix.
 * Uses `exact: false` so nested/sibling queries (list + detail + activity) are all refetched.
 */
export function useResourceInvalidation(queryKey: QueryKey) {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey, exact: false }),
    // queryKey is a stable reference when used as module-scoped constant
    [queryClient, queryKey],
  );
}

/**
 * Shared error handler for mutation onError. Shows a bare (info) toast on 409
 * with the optional conflict string, a toast.error with the server message on
 * any other error. Always triggers a targeted invalidation via the provided
 * invalidate callback so the UI converges to server state.
 */
export function handleMutationError(
  err: Error,
  invalidate: () => void,
  options?: { conflictText?: string; fallbackMessage?: string },
) {
  const conflictText = options?.conflictText ?? DEFAULT_CONFLICT_TEXT;
  const status = err instanceof ApiError ? err.status : undefined;
  if (status === 409) {
    // Prefer the server's 409 message so specific conflicts (e.g. "A tier
    // mapping for X / Y already exists") surface to the admin. Fall back to
    // conflictText only when the server omitted a message.
    toast(err.message || conflictText);
  } else {
    toast.error(err.message || options?.fallbackMessage || "Operation failed");
  }
  invalidate();
}

export type ResourceMutationsConfig = {
  /** URL segment, no leading slash — e.g. "parties/agents" */
  resource: string;
  /** React Query cache key — e.g. ["parties", "agents"] */
  queryKey: QueryKey;
  toasts?: {
    create?: string;
    update?: string;
    remove?: string;
    /** Defaults to "Record changed — reloaded" */
    conflict?: string;
  };
};

/**
 * Patches a single item (matched by id) inside a cached list value.
 * Supports two shapes:
 *   - bare array:           [item, item, ...]
 *   - pagination wrapper:   { data: [item, item, ...], ...rest }
 */
function patchListItem<T extends { id: string }>(
  value: unknown,
  id: string,
  patch: Partial<T>,
): unknown {
  // Handle array shape: [item, item, ...]
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (
        item &&
        typeof item === "object" &&
        "id" in item &&
        (item as { id: string }).id === id
      ) {
        return { ...item, ...patch };
      }
      return item;
    });
  }
  // Handle { data: [...] } shape (common pagination wrapper)
  if (value && typeof value === "object" && "data" in value) {
    const wrapper = value as { data: unknown };
    if (Array.isArray(wrapper.data)) {
      return { ...wrapper, data: patchListItem(wrapper.data, id, patch) };
    }
  }
  return value;
}

/**
 * Factory-of-hooks for the standard CRUD mutation pattern.
 *
 * Define the config once at module scope; call the returned hook per-component.
 *
 * @example
 * export const useAgentMutations = createResourceMutations<AgentDto>({
 *   resource: "parties/agents",
 *   queryKey: ["parties", "agents"],
 *   toasts: { create: "Agent created", update: "Saved", remove: "Removed" },
 * });
 *
 * // Inside a component:
 * const { create, update, remove } = useAgentMutations();
 */
export function createResourceMutations<TResource extends { id: string }>(
  config: ResourceMutationsConfig,
) {
  return function useResourceMutations() {
    const queryClient = useQueryClient();
    const invalidate = useResourceInvalidation(config.queryKey);

    const handleError = (err: Error, fallbackMessage: string) =>
      handleMutationError(err, invalidate, {
        conflictText: config.toasts?.conflict,
        fallbackMessage,
      });

    // ── CREATE ─────────────────────────────────────────────────────────────
    const create = useMutation<TResource, Error, Partial<TResource>>({
      mutationFn: (body) =>
        apiFetch<TResource>(`/${config.resource}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      onSuccess: () => {
        invalidate();
        if (config.toasts?.create) toast.success(config.toasts.create);
      },
      onError: (err) => handleError(err, "Failed to create"),
    });

    // ── UPDATE (optimistic) ────────────────────────────────────────────────
    const update = useMutation<
      TResource,
      Error,
      { id: string; patch: Partial<TResource> },
      { prevDetail?: TResource; prevLists?: Array<[QueryKey, unknown]> }
    >({
      mutationFn: ({ id, patch }) =>
        apiFetch<TResource>(`/${config.resource}/${id}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        }),
      onMutate: async ({ id, patch }) => {
        await Promise.all([
          queryClient.cancelQueries({
            queryKey: [...(config.queryKey as unknown[]), id],
          }),
          queryClient.cancelQueries({ queryKey: config.queryKey }),
        ]);

        const prevDetail = queryClient.getQueryData<TResource>([
          ...(config.queryKey as unknown[]),
          id,
        ]);
        const prevLists: Array<[QueryKey, unknown]> = queryClient.getQueriesData(
          { queryKey: config.queryKey },
        );

        // Strip `undefined` keys so the optimistic merge below does not
        // CLOBBER existing values with `undefined`. Frontend code that
        // builds a "diff payload" (e.g. `field.trim() || undefined`) would
        // otherwise wipe untouched fields from the cache mid-flight even
        // though the server's Prisma `update` skips them.
        const safePatch = stripUndefined(
          patch as object,
        ) as Partial<TResource>;

        if (prevDetail) {
          queryClient.setQueryData<TResource>(
            [...(config.queryKey as unknown[]), id],
            { ...prevDetail, ...safePatch },
          );
        }

        // Patch every list variant (filters, pagination, etc.) that contains this id.
        // Skip the detail key itself — it was already patched above.
        const detailKey = [...(config.queryKey as unknown[]), id];
        for (const [key, value] of prevLists) {
          if (value == null) continue;
          // Skip the per-item detail entry to avoid clobbering the patch above.
          if (
            Array.isArray(key) &&
            key.length === detailKey.length &&
            key.every((k, i) => k === detailKey[i])
          ) {
            continue;
          }
          queryClient.setQueryData(key, patchListItem(value, id, safePatch));
        }

        return { prevDetail, prevLists };
      },
      onError: (err, { id }, ctx) => {
        if (ctx?.prevDetail) {
          queryClient.setQueryData(
            [...(config.queryKey as unknown[]), id],
            ctx.prevDetail,
          );
        }
        if (ctx?.prevLists) {
          for (const [key, prev] of ctx.prevLists) {
            queryClient.setQueryData(key, prev);
          }
        }
        handleError(err, "Failed to save");
      },
      onSuccess: () => {
        invalidate();
        if (config.toasts?.update) toast.success(config.toasts.update);
      },
    });

    // ── REMOVE ─────────────────────────────────────────────────────────────
    const remove = useMutation<unknown, Error, { id: string }>({
      mutationFn: ({ id }) =>
        apiFetch(`/${config.resource}/${id}`, { method: "DELETE" }),
      onSuccess: () => {
        invalidate();
        if (config.toasts?.remove) toast.success(config.toasts.remove);
      },
      onError: (err) => handleError(err, "Failed to remove"),
    });

    return { create, update, remove };
  };
}
