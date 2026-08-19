import { useQuery } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";

export type RoomTypeKind = "WHOLE" | "PARTITION";

export type RoomTypeOption = { id: string; name: string; kind: RoomTypeKind; sortOrder: number };

export function useRoomTypes() {
  return useQuery({
    queryKey: ["portal", "room-types"],
    queryFn: async () => {
      const res = await portalApiFetch<{ data: RoomTypeOption[] }>("/commissions/room-types");
      return res.data;
    },
  });
}
