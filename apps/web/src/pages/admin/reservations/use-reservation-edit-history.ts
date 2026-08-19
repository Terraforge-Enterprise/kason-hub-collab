import { useQuery } from "@tanstack/react-query";
import {
  getReservationEditHistory,
  type EditHistoryEntry,
} from "@/api/admin-edit-reservation";

/**
 * Fetch admin_edit_after_signing audit-log entries for a reservation. The
 * endpoint is admin-only (the server returns 403 for non-admins); pass
 * `enabled = currentUser.role === "admin"` to suppress the call entirely for
 * non-admins so we don't spam the network with guaranteed-403 requests.
 */
export function useReservationEditHistory(
  reservationId: string,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ["admin", "reservation-edit-history", reservationId],
    queryFn: () => getReservationEditHistory(reservationId),
    enabled: enabled && !!reservationId,
  });
}

export type { EditHistoryEntry };
