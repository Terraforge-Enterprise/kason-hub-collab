import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, Surface, StatusPill } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Field, TextInput } from "@/components/form-ui";
import { AvatarUploader } from "@/components/avatar-uploader";
import { useMyProfile, useUpdateMyProfile } from "@/api/profile";

export default function AccountPage() {
  const profile = useMyProfile();
  const update = useUpdateMyProfile();
  const [fullName, setFullName] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (profile.data?.data?.fullName) setFullName(profile.data.data.fullName);
  }, [profile.data?.data?.fullName]);

  if (profile.isLoading) {
    return <div className="p-6 text-sm">Loading…</div>;
  }
  if (profile.isError || !profile.data) {
    return <p className="p-6 text-sm text-rose-600">Failed to load profile.</p>;
  }

  const me = profile.data.data;

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    update.mutate({ fullName: fullName.trim() }, { onSuccess: () => setSavedNotice(true) });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My account"
        description="Edit your profile, password, and avatar."
      />

      <Surface title="Profile" description="Update your display name and avatar.">
        <form onSubmit={onSave} className="space-y-4">
          <AvatarUploader mode="admin" currentPhotoUrl={me.photoUrl} name={me.fullName} />

          <Field label="Full name">
            <TextInput value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </Field>

          <Field label="Email">
            <p className="text-sm text-[var(--text-muted)]">{me.email}</p>
          </Field>

          <Field label="Role">
            <StatusPill tone="emerald">{me.role}</StatusPill>
          </Field>

          <div className="flex items-center gap-3">
            <Button variant="gold" type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            {savedNotice && !update.isPending && (
              <span className="text-xs text-emerald-600">Saved.</span>
            )}
          </div>
        </form>
      </Surface>

      <Surface title="Security" description="Manage your password.">
        <div className="space-y-3">
          <div className="text-sm">
            Last sign-in:{" "}
            <span className="text-[var(--text-muted)]">
              {me.lastLoginAt ? new Date(me.lastLoginAt).toLocaleString() : "Never"}
            </span>
          </div>
          <Link
            to="/change-password"
            className="inline-block rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-2 text-sm font-medium hover:bg-[var(--page-bg)] transition"
          >
            Change password
          </Link>
        </div>
      </Surface>
    </div>
  );
}
