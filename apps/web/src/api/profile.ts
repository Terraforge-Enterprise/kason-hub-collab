import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

export type MyProfile = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  photoKey: string | null;
  photoUrl: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
};

export type UpdateMyProfileInput = {
  fullName?: string;
  photoKey?: string | null;
};

export type AvatarUploadUrlResponse = {
  url: string;
  key: string;
  headers: Record<string, string>;
};

const PROFILE_KEY = ["profile"] as const;

export function useMyProfile() {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => apiFetch<{ data: MyProfile }>("/profile/me"),
    staleTime: 30_000,
  });
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyProfileInput) =>
      apiFetch<{ data: MyProfile }>("/profile/me", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROFILE_KEY }),
  });
}

export function useAvatarUploadUrl() {
  return useMutation({
    mutationFn: (input: { contentType: string; sizeBytes: number }) =>
      apiFetch<{ data: AvatarUploadUrlResponse }>("/profile/avatar/upload-url", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}
