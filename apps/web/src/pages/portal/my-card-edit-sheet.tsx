/**
 * MyCardEditSheet — slide-over drawer with the four card-display fields.
 *
 * On submit, fires useSubmitMyCard. On success: close + sonner toast.
 * On 409 pending_exists / org_card_settings_not_configured: show a
 * tailored message instead of the generic API error.
 *
 * The form mirrors the admin-side AgentCardVersion fields per spec §6.2:
 *   - displayName  (required)
 *   - title        (required)
 *   - primaryEmail (optional)
 *   - primaryPhone (optional)
 *
 * Implementation note: the form body is split into <EditFormBody> so it
 * remounts each time the Sheet opens (parent gates on `open`). This
 * initialises the controlled inputs from `initial` via lazy useState
 * instead of via an effect — sidesteps the react-x lint rule
 * forbidding setState-in-useEffect for derived state.
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Field, TextInput } from "@/components/form-ui";
import { PhoneInput } from "@/components/phone-input";
import {
  useSubmitMyCard,
  getMyCardErrorCode,
  type MyCardVersion,
} from "@/api/portal-my-card";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Initial values for the form. Pass the active card row when editing
   * (pre-fills with last-approved data); pass null for a fresh first
   * submission.
   */
  initial: MyCardVersion | null;
}

export function MyCardEditSheet({ open, onOpenChange, initial }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Edit your e-namecard</SheetTitle>
          <SheetDescription>
            Submissions go to your manager for approval. Your existing
            public link keeps working until the new version is approved.
          </SheetDescription>
        </SheetHeader>
        {/*
          Mount the form ONLY when the sheet is open. Each open is a
          fresh mount → controlled-input state is initialised from
          `initial` via lazy useState rather than via an effect.
        */}
        {open && <EditFormBody initial={initial} onClose={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

interface FormBodyProps {
  initial: MyCardVersion | null;
  onClose: () => void;
}

function EditFormBody({ initial, onClose }: FormBodyProps) {
  const submit = useSubmitMyCard();
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [primaryEmail, setPrimaryEmail] = useState(initial?.primaryEmail ?? "");
  const [primaryPhone, setPrimaryPhone] = useState<string | null>(
    initial?.primaryPhone ?? null,
  );
  const [errors, setErrors] = useState<{ displayName?: string; title?: string }>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (!displayName.trim()) nextErrors.displayName = "Display name is required";
    if (!title.trim()) nextErrors.title = "Title is required";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    submit.mutate(
      {
        displayName: displayName.trim(),
        title: title.trim(),
        primaryEmail: primaryEmail.trim() || null,
        // primaryPhone is already canonical-or-null from <PhoneInput>.
        primaryPhone: primaryPhone,
      },
      {
        onSuccess: () => {
          toast.success("Submitted for review", {
            description:
              "Your card update is pending manager approval. Your existing public link keeps working until then.",
          });
          onClose();
        },
        onError: (err) => {
          // Branch on structured error codes returned by the service.
          const code = getMyCardErrorCode(err);
          if (code === "pending_exists") {
            toast.error("You already have a pending submission", {
              description: "Withdraw or wait for the review to complete.",
            });
          } else if (code === "org_card_settings_not_configured") {
            toast.error("Organization branding not yet configured", {
              description: "Ask your admin to configure card settings first.",
            });
          } else {
            toast.error(`Submit failed: ${err.message}`);
          }
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="contents">
      <SheetBody>
        <div className="space-y-4">
          <Field label="Display name" hint="How your name appears on the card">
            <TextInput
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Cadis Tan"
              maxLength={100}
              aria-invalid={Boolean(errors.displayName)}
            />
            {errors.displayName && (
              <span className="text-xs text-destructive">{errors.displayName}</span>
            )}
          </Field>
          <Field label="Job title" hint="Visible under your name on the card">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Senior Sales Manager"
              maxLength={100}
              aria-invalid={Boolean(errors.title)}
            />
            {errors.title && (
              <span className="text-xs text-destructive">{errors.title}</span>
            )}
          </Field>
          <Field label="Email (optional)">
            <TextInput
              type="email"
              value={primaryEmail}
              onChange={(e) => setPrimaryEmail(e.target.value)}
              placeholder="agent@example.com"
              maxLength={254}
            />
          </Field>
          <PhoneInput
            label="Phone (optional)"
            value={primaryPhone}
            onChange={setPrimaryPhone}
          />
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          type="submit"
          variant="gold"
          disabled={submit.isPending}
        >
          {submit.isPending ? "Submitting…" : "Submit for approval"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={submit.isPending}
        >
          Cancel
        </Button>
      </SheetFooter>
    </form>
  );
}
