import { useRef, useState } from "react";
import { Avatar } from "./avatar";
import { useAvatarUpload, type AvatarUploadMode } from "@/hooks/use-avatar-upload";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

type Props = {
  mode: AvatarUploadMode;
  currentPhotoUrl: string | null;
  name: string;
};

export function AvatarUploader({ mode, currentPhotoUrl, name }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const { uploadAvatar, isUploading, error: uploadError } = useAvatarUpload(mode);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setLocalError("Max 5MB.");
      return;
    }
    if (!ALLOWED_MIME.includes(file.type)) {
      setLocalError("Avatar must be JPEG, PNG, or WebP.");
      return;
    }
    void uploadAvatar(file).catch(() => {
      // hook surfaces error via uploadError
    });
  }

  const error = localError ?? uploadError;

  return (
    <div className="flex items-center gap-4">
      <Avatar src={currentPhotoUrl} name={name} size="lg" />
      <div className="flex flex-col gap-1">
        <label className="cursor-pointer rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm hover:bg-[var(--page-bg)] transition">
          {isUploading ? "Uploading…" : currentPhotoUrl ? "Change avatar" : "Upload avatar"}
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPick}
            className="sr-only"
            aria-label="Upload avatar"
            disabled={isUploading}
          />
        </label>
        {error && <p className="text-xs text-rose-500">{error}</p>}
      </div>
    </div>
  );
}
