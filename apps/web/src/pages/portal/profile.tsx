import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePortalProfile } from "@/components/portal-protected-route";
import { portalApiFetch } from "@/lib/portal-api";
import { AvatarUploader } from "@/components/avatar-uploader";
import { PhoneInput } from "@/components/phone-input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { User, CreditCard } from "lucide-react";

function humanizeAgentLevel(level?: string | null): string {
  if (!level) return "Not Set";
  const map: Record<string, string> = {
    new_agent: "New Agent",
    pre_leader: "Pre Leader",
    leader: "Leader",
  };
  return map[level] ?? level;
}

const inputClass =
  "w-full rounded-md border border-border/60 bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-ring";

export default function PortalProfilePage() {
  const { data, isLoading } = usePortalProfile();
  const queryClient = useQueryClient();

  const p = data?.data;

  // --- profile edit state ---
  const [editingProfile, setEditingProfile] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPhone, setDraftPhone] = useState<string | null>(null);

  const profileMutation = useMutation({
    mutationFn: (input: { fullName?: string; phone?: string }) =>
      portalApiFetch("/profile/me", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-profile"] });
      setEditingProfile(false);
    },
  });

  function startEditProfile() {
    setDraftName(p?.fullName ?? "");
    setDraftPhone(p?.phone ?? null);
    setEditingProfile(true);
  }

  function saveProfile() {
    // draftPhone is already canonical (or null) from <PhoneInput>; the API
    // accepts undefined to mean "leave alone", so omit when null clears were
    // not previously supported here. Send the trimmed name and the canonical
    // phone (or empty string for "clear") to keep parity with prior PATCH
    // behaviour.
    profileMutation.mutate({
      fullName: draftName.trim(),
      phone: draftPhone ?? "",
    });
  }

  // --- bank edit state ---
  const [editing, setEditing] = useState(false);
  const [bankName, setBankName] = useState("");
  const [bankAccountHolder, setBankAccountHolder] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      portalApiFetch<{ data: { ok: boolean } }>("/profile/bank-details", {
        method: "PUT",
        body: JSON.stringify({ bankName, bankAccountHolder, bankAccountNumber }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-profile"] });
      setEditing(false);
      setSuccessMsg("Bank details saved successfully.");
      setTimeout(() => setSuccessMsg(""), 4000);
    },
  });

  const startEditing = () => {
    setBankName(p?.bankName ?? "");
    setBankAccountHolder(p?.bankAccountHolder ?? "");
    setBankAccountNumber(p?.bankAccountNumber ?? "");
    setEditing(true);
    setSuccessMsg("");
  };

  const cancelEditing = () => {
    setEditing(false);
    mutation.reset();
  };

  const handleSave = () => {
    if (bankName || bankAccountHolder || bankAccountNumber) {
      if (!bankName.trim()) return;
    }
    mutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl animate-pulse">
        <div className="h-10 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  if (!p) return null;

  const isAgent = p.partyType === "agent";

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Page Header */}
      <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
        <User className="h-6 w-6 text-primary" />
        Profile
      </h1>

      {/* Personal Info Card */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <User className="h-5 w-5 text-primary" />
            Personal Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="mb-4">
            <AvatarUploader
              mode="portal"
              currentPhotoUrl={p.photoUrl ?? null}
              name={p.fullName}
            />
          </div>
          {editingProfile ? (
            <>
              <Field label="Full Name">
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <PhoneInput
                label="Phone"
                value={draftPhone}
                onChange={setDraftPhone}
              />
              {profileMutation.error && (
                <div className="text-sm text-red-400">{(profileMutation.error as Error).message}</div>
              )}
              <div className="flex gap-2 pt-1">
                <Button variant="gold" onClick={saveProfile} disabled={profileMutation.isPending}>
                  {profileMutation.isPending ? "Saving…" : "Save"}
                </Button>
                <Button variant="outline" onClick={() => setEditingProfile(false)}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              <DetailRow label="Full Name" value={p.fullName} />
              <DetailRow label="Email" value={p.email} />
              <DetailRow label="Phone" value={p.phone || "Not set"} />
              <DetailRow label="Type" value={p.partyType} />
              {isAgent && (
                <DetailRow label="Agent Level" value={humanizeAgentLevel(p.agentLevel)} muted />
              )}
              {!isAgent && p.propertyName && (
                <DetailRow label="Property" value={p.propertyName} />
              )}
              {!isAgent && p.unitCode && (
                <DetailRow label="Unit" value={p.unitCode} />
              )}
              {!isAgent && p.tenancyCode && (
                <DetailRow label="Tenancy" value={p.tenancyCode} />
              )}
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" onClick={startEditProfile}>Edit profile</Button>
                <Link
                  to="/portal/change-password"
                  className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  Change password
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Bank Details Card (agents only) */}
      {isAgent && (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-primary" />
                Bank Details
              </CardTitle>
              {!editing && (
                <Button variant="outline" size="sm" onClick={startEditing}>
                  Edit
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {successMsg && (
              <div className="text-sm text-emerald-500 font-medium">{successMsg}</div>
            )}
            {mutation.error && (
              <div className="text-sm text-red-400">{(mutation.error as Error).message}</div>
            )}

            {editing ? (
              <>
                <Field label="Bank Name">
                  <input
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="e.g. Maybank, CIMB, Public Bank"
                    className={inputClass}
                  />
                </Field>
                <Field label="Account Owner Name">
                  <input
                    value={bankAccountHolder}
                    onChange={(e) => setBankAccountHolder(e.target.value)}
                    placeholder="Name as shown on bank account"
                    className={inputClass}
                  />
                </Field>
                <Field label="Account Number">
                  <input
                    value={bankAccountNumber}
                    onChange={(e) => setBankAccountNumber(e.target.value)}
                    placeholder="Bank account number"
                    className={inputClass}
                  />
                </Field>
                <div className="flex gap-2 pt-1">
                  <Button variant="gold" onClick={handleSave} disabled={mutation.isPending}>
                    {mutation.isPending ? "Saving..." : "Save"}
                  </Button>
                  <Button variant="outline" onClick={cancelEditing}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <DetailRow label="Bank Name" value={p.bankName || "Not set"} />
                <DetailRow label="Account Owner" value={p.bankAccountHolder || "Not set"} />
                <DetailRow label="Account Number" value={p.bankAccountNumber || "Not set"} />
              </>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}

function DetailRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between border-b border-border/30 pb-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}
