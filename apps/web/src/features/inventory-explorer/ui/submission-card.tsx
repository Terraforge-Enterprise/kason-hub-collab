// apps/web/src/features/inventory-explorer/ui/submission-card.tsx
//
// Renders a `UnitSubmission` row in the agent's "My Uploads" view. After
// the three-table refactor (2026-05-19), pending agent-sourced rows live
// in their own table (UnitSubmission) — they no longer reach this card via
// the inventory explorer because the inventory tree never contains them.
//
// The card surfaces the submission state badge + (for amendments) a label
// noting this is an amendment to an existing approved listing. Detail / edit
// flows live on the portal pages (`my-uploads-page.tsx`,
// `inventory-edit-page.tsx`).
//
// Spec: docs/superpowers/specs/2026-05-19-inventory-three-table-refactor-design.md
//       §Web changes - Portal listings

import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatRM } from "@/components/format";

/**
 * The slim shape this card consumes. Matches `PortalOwnUnit` from
 * `@/api/portal-inventory` — the wire shape of
 * `GET /portal-api/inventory/units`.
 */
export type SubmissionCardRow = {
  id: string;
  unitCode: string;
  unitType: string;
  listingType: string;
  submissionState: "pending" | "needs_amendment" | "approved" | "rejected" | "withdrawn";
  amendmentNote: string | null;
  parentListingId: string | null;
  approvedListingId: string | null;
  submittedPayload: Record<string, unknown> | null;
  property: { id: string; name: string; propertyCode: string } | null;
  createdAt: string;
};

const STATE_VARIANT: Record<
  SubmissionCardRow["submissionState"],
  "amber" | "sky" | "emerald" | "rose" | "default"
> = {
  pending: "amber",
  needs_amendment: "amber",
  approved: "emerald",
  rejected: "rose",
  withdrawn: "default",
};

const STATE_LABEL: Record<SubmissionCardRow["submissionState"], string> = {
  pending: "Pending approval",
  needs_amendment: "Needs amendment — see notes",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn by you",
};

function readProposedRentalRate(payload: Record<string, unknown> | null): number | null {
  if (!payload) return null;
  const listing = (payload as { listing?: Record<string, unknown> }).listing;
  const raw = listing?.rentalRate;
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function SubmissionCard({
  submission,
}: {
  submission: SubmissionCardRow;
}) {
  const isAmendment = submission.parentListingId !== null;
  const rentalRate = readProposedRentalRate(submission.submittedPayload);
  const variant = STATE_VARIANT[submission.submissionState];
  const label = STATE_LABEL[submission.submissionState];
  const noteBody = submission.amendmentNote?.replace(/^REJECTED:\s*/, "") ?? null;

  // Approved submissions deep-link to the live Listing; non-approved stay
  // on the submission itself so the agent can amend / withdraw / re-submit.
  const targetId =
    submission.submissionState === "approved" && submission.approvedListingId
      ? submission.approvedListingId
      : submission.id;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50">
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={variant}>{label}</Badge>
          {isAmendment && (
            <Badge variant="sky">Amendment to existing</Badge>
          )}
        </div>
        <Link
          to={`/portal/inventory/${targetId}`}
          className="block text-sm font-medium text-foreground hover:underline"
        >
          {submission.property?.name ?? "(Pending property)"}{" "}
          <span className="font-mono text-muted-foreground">· {submission.unitCode}</span>
        </Link>
        <div className="text-xs text-muted-foreground">
          <span className="capitalize">{submission.unitType}</span>
          {rentalRate != null && ` · ${formatRM(rentalRate)} / month`}
          {" · "}submitted {formatDate(submission.createdAt)}
        </div>
        {noteBody && (
          <div className="text-xs text-amber-400 mt-1.5 line-clamp-3">
            Note: {noteBody}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
