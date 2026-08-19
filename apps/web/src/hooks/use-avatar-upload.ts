import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { portalApiFetch } from "@/lib/portal-api";

export type AvatarUploadMode = "admin" | "portal";

const UPLOAD_URL_PATH: Record<AvatarUploadMode, string> = {
  admin: "/profile/avatar/upload-url",
  portal: "/profile/avatar/upload-url",
};

const PROFILE_PATCH_PATH: Record<AvatarUploadMode, string> = {
  admin: "/profile/me",
  portal: "/profile/me",
};

// Caches that show photoUrl and must be invalidated after a successful upload
// so the new avatar appears immediately (no manual page refresh).
const INVALIDATE_KEYS: Record<AvatarUploadMode, readonly string[][]> = {
  admin: [
    ["profile"],          // /account page own profile
    ["users"],            // staff-page register table (current user's avatar in own row)
    ["parties", "agents"], // agents-table (current user may have an Agent row too)
  ],
  portal: [
    ["portal-profile"],   // /portal/profile own profile
  ],
};

export function useAvatarUpload(mode: AvatarUploadMode) {
  const qc = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadAvatar(file: File): Promise<{ key: string }> {
    setIsUploading(true);
    setError(null);
    try {
      const fetcher = mode === "admin" ? apiFetch : portalApiFetch;

      // 1) Get signed PUT URL
      const signed = await fetcher<{ data: { url: string; key: string; headers: Record<string, string> } }>(
        UPLOAD_URL_PATH[mode],
        {
          method: "POST",
          body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
        },
      );

      // 2) PUT file body to Supabase Storage
      const putRes = await fetch(signed.data.url, {
        method: "PUT",
        headers: signed.data.headers,
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);

      // 3) Patch own profile with the new key
      await fetcher(PROFILE_PATCH_PATH[mode], {
        method: "PATCH",
        body: JSON.stringify({ photoKey: signed.data.key }),
      });

      // 4) Invalidate caches so the new avatar appears without manual refresh.
      // Prefix-based — react-query invalidates all queries whose keys start with these.
      for (const key of INVALIDATE_KEYS[mode]) {
        await qc.invalidateQueries({ queryKey: key });
      }

      return { key: signed.data.key };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      setError(msg);
      throw err;
    } finally {
      setIsUploading(false);
    }
  }

  return { uploadAvatar, isUploading, error };
}
