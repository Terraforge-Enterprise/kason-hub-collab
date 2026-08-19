/**
 * Card Settings — admin configures org branding for the e-namecard.
 *
 * Per spec §7.1, this page is a sub-route of /organization/agents and
 * provides:
 *   - Form panel: brand name, tagline, agency cert, address (4 lines),
 *     auto-expiry policy
 *   - Live preview panel: <AgentCardPreview> with placeholder agent fields
 *     so the admin can see exactly how their branding will render
 *   - Danger-zone callout explaining that branding changes do NOT
 *     invalidate existing approved cards (they keep their snapshot per
 *     §5 invariants)
 *
 * Save flow: PUT /api/organization-card-settings; backend flips
 * `isConfigured = true` once agencyName + agencyLicense + addressLine1 are
 * all non-empty (the gate for agent card creation).
 */
import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput, SelectInput } from "@/components/form-ui";
import {
  useOrgCardSettings,
  useUpdateOrgCardSettings,
  type UpdateOrgCardSettingsInput,
} from "@/api/organization-card-settings";
import { AgentCardPreview } from "@/components/agent-card-preview";
import { AgentsAreaTabs } from "./agents-area-tabs";

const EXPIRY_OPTIONS = [
  { value: "3", label: "3 months (recommended — default)" },
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
];

function buildDraftFromSettings(
  s: NonNullable<ReturnType<typeof useOrgCardSettings>["data"]>,
): UpdateOrgCardSettingsInput {
  return {
    agencyName: s.agencyName,
    agencyLicense: s.agencyLicense,
    agencyPhone: s.agencyPhone,
    agencyFax: s.agencyFax,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    addressLine3: s.addressLine3,
    addressLine4: s.addressLine4,
    cardExpiryMonths: s.cardExpiryMonths,
  };
}

function PageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-72 bg-muted rounded" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-[500px] bg-muted rounded-xl" />
        <div className="h-[500px] bg-muted rounded-xl" />
      </div>
    </div>
  );
}

export default function CardSettingsPage() {
  const { data: settings, isLoading } = useOrgCardSettings();
  const update = useUpdateOrgCardSettings();
  const [draft, setDraft] = useState<UpdateOrgCardSettingsInput>({});

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (settings) setDraft(buildDraftFromSettings(settings));
  }, [settings]);

  if (isLoading || !settings) {
    return (
      <div className="space-y-6">
        <AgentsAreaTabs activeTab="card-settings" />
        <PageSkeleton />
      </div>
    );
  }

  const handleSave = () => {
    update.mutate(draft, {
      onSuccess: () => toast.success("Card settings saved"),
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Unknown error";
        toast.error(`Save failed: ${msg}`);
      },
    });
  };

  const handleDiscard = () => {
    setDraft(buildDraftFromSettings(settings));
  };

  // Live preview pulls from the in-progress draft, falling back to saved
  // settings for fields the user hasn't touched yet.
  const previewOrg = {
    agencyName: draft.agencyName ?? settings.agencyName,
    agencyLicense: draft.agencyLicense ?? settings.agencyLicense,
    agencyPhone: draft.agencyPhone ?? settings.agencyPhone,
    agencyFax: draft.agencyFax ?? settings.agencyFax,
    address: [
      draft.addressLine1 ?? settings.addressLine1,
      draft.addressLine2 ?? settings.addressLine2,
      draft.addressLine3 ?? settings.addressLine3,
      draft.addressLine4 ?? settings.addressLine4,
    ].filter((line): line is string => Boolean(line && line.trim())),
    logoUrl: "/logo-gold.png",
  };

  return (
    <div className="space-y-6">
      <AgentsAreaTabs activeTab="card-settings" />

      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Settings className="h-8 w-8 text-primary" />
          Card Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Brand, address, agency cert, and expiry policy. Applied to every
          agent's e-namecard.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form panel */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold">Brand &amp; cert</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Agency name">
                <TextInput
                  value={draft.agencyName ?? ""}
                  onChange={(e) => setDraft({ ...draft, agencyName: e.target.value })}
                  placeholder="e.g. EUM Realty Sdn Bhd"
                />
              </Field>
              <Field label="License no.">
                <TextInput
                  value={draft.agencyLicense ?? ""}
                  onChange={(e) => setDraft({ ...draft, agencyLicense: e.target.value })}
                  placeholder="e.g. E(1) 1708"
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Agency phone">
                <TextInput
                  value={draft.agencyPhone ?? ""}
                  onChange={(e) => setDraft({ ...draft, agencyPhone: e.target.value })}
                />
              </Field>
              <Field label="Agency fax">
                <TextInput
                  value={draft.agencyFax ?? ""}
                  onChange={(e) => setDraft({ ...draft, agencyFax: e.target.value })}
                />
              </Field>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Address (up to 4 lines)
              </p>
              <TextInput
                value={draft.addressLine1 ?? ""}
                onChange={(e) => setDraft({ ...draft, addressLine1: e.target.value })}
                placeholder="Line 1 (required)"
              />
              <TextInput
                value={draft.addressLine2 ?? ""}
                onChange={(e) => setDraft({ ...draft, addressLine2: e.target.value })}
                placeholder="Line 2"
              />
              <TextInput
                value={draft.addressLine3 ?? ""}
                onChange={(e) => setDraft({ ...draft, addressLine3: e.target.value })}
                placeholder="Line 3"
              />
              <TextInput
                value={draft.addressLine4 ?? ""}
                onChange={(e) => setDraft({ ...draft, addressLine4: e.target.value })}
                placeholder="Line 4"
              />
            </div>

            <Field label="Public-link auto-expires after">
              <SelectInput
                value={String(draft.cardExpiryMonths ?? 3)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cardExpiryMonths: Number(e.target.value) as 3 | 6 | 12,
                  })
                }
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </SelectInput>
            </Field>

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={handleDiscard} disabled={update.isPending}>
                Discard
              </Button>
              <Button variant="gold" onClick={handleSave} disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Live preview panel */}
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-bold">Live preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <AgentCardPreview
              displayName="[Agent name]"
              title="[Agent title]"
              primaryPhone="[Agent phone]"
              primaryEmail="[Agent email]"
              org={previewOrg}
            />
            <Callout variant="warning" title="Danger zone">
              Changing the agency name or license number does NOT invalidate
              existing approved cards — they keep their snapshot of the
              values at approval time. New and re-submitted cards will use
              the new values.
            </Callout>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
