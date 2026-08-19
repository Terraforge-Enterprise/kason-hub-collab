import { MessageSquareWarning } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Status pill for a record (commission claim, unit submission, or property
 * submission) that the admin has sent back to the agent for amendment.
 *
 * Lifted to a shared component so commission-claim pages and source-queue
 * pages stay visually identical. Service-layer code per module stays
 * separate (rule-of-three).
 */
export function NeedsAmendmentBadge() {
  return (
    <Badge variant="amber">
      <MessageSquareWarning aria-hidden />
      Needs amendment
    </Badge>
  );
}
