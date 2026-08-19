import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PHOTO_MAX_BYTES, VIDEO_MAX_BYTES } from "@/hooks/use-listing-media-upload";

export type MediaLimits = {
  photoMaxBytes: number;
  videoMaxBytes: number;
};

/**
 * Reads the server's current media size caps so the upload UI's guard +
 * rejection message match the server gate exactly. Caps are env-driven on
 * the server (`PHOTO_MAX_BYTES`, `VIDEO_MAX_BYTES`) so dev/staging/prod can
 * each pick a value matching their Supabase bucket's `file_size_limit`.
 *
 * Falls back to the Free-tier-safe defaults from the upload hook if the
 * fetch fails — keeps the UI usable in offline / first-paint scenarios.
 */
export function useMediaLimits() {
  return useQuery<MediaLimits>({
    queryKey: ["media-limits"],
    queryFn: async () => {
      const res = await apiFetch<{ data: MediaLimits }>("/listings/media/limits");
      return res.data;
    },
    staleTime: 5 * 60_000,
    placeholderData: { photoMaxBytes: PHOTO_MAX_BYTES, videoMaxBytes: VIDEO_MAX_BYTES },
  });
}
