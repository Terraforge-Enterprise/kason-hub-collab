import { MessageSquareWarning } from "lucide-react";

interface Props {
  note: string;
  requestedAt?: Date | string | null;
}

function formatRequestedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // Project pattern is to render absolute YYYY-MM-DD; the existing portal
  // claim list uses the same shape, so this stays consistent without
  // pulling in date-fns just for relative time.
  return date.toISOString().slice(0, 10);
}

/**
 * Banner shown to the agent at the top of an in-flight amendment.
 * Displays the admin's note (free text) verbatim.
 *
 * Visually identical to the source-queue amendment banner so both flows
 * read the same way to agents. Pure presentation; no business logic.
 */
export function AmendmentRequestBanner({ note, requestedAt }: Props) {
  const formattedDate = requestedAt ? formatRequestedAt(requestedAt) : "";
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex items-start gap-3">
        <MessageSquareWarning
          className="mt-0.5 h-5 w-5 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <div className="flex-1 space-y-1">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Admin requested changes
          </p>
          <p className="whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-100">
            {note}
          </p>
          {formattedDate ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Requested {formattedDate}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
