// Mock-only annotation widget. Wraps a section the client should review
// and decide on. Renders three toggle states: keep / alt / drop. State is
// purely local — no persistence. The "Drop" state visually dims the wrapped
// content so the client can see what the page would look like without it.
import { useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";

type Props = {
  id: string;
  question: string;
  // Tag the page surface this decision lives on, e.g. "Sales Entry — fields",
  // so the client can mentally group decisions when reviewing.
  scope: string;
  // Three response labels. Default: Keep / Alternative / Drop.
  options?: { keep: string; alt?: string; drop: string };
  children: ReactNode;
};

type Decision = "keep" | "alt" | "drop";

export function DecisionPill({ id, question, scope, options, children }: Props) {
  const [decision, setDecision] = useState<Decision>("keep");
  const labels = {
    keep: options?.keep ?? "Keep",
    alt: options?.alt,
    drop: options?.drop ?? "Drop",
  };
  const isDropped = decision === "drop";

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-1">
      <div className="flex items-start justify-between gap-3 border-b border-amber-500/20 px-3 py-2">
        <div className="flex items-start gap-2 min-w-0">
          <HelpCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
              MOCK — decide ({scope})
            </p>
            <p className="text-xs text-amber-900 dark:text-amber-100 mt-0.5 leading-relaxed">
              {question}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" data-decision-id={id}>
          <button
            type="button"
            onClick={() => setDecision("keep")}
            className={`rounded px-2 py-1 text-[11px] font-medium transition ${
              decision === "keep"
                ? "bg-emerald-500/20 text-emerald-800 dark:text-emerald-200"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {labels.keep}
          </button>
          {labels.alt && (
            <button
              type="button"
              onClick={() => setDecision("alt")}
              className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                decision === "alt"
                  ? "bg-sky-500/20 text-sky-800 dark:text-sky-200"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {labels.alt}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDecision("drop")}
            className={`rounded px-2 py-1 text-[11px] font-medium transition ${
              decision === "drop"
                ? "bg-rose-500/20 text-rose-800 dark:text-rose-200"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {labels.drop}
          </button>
        </div>
      </div>
      <div
        className={`p-3 transition-opacity ${isDropped ? "opacity-30" : "opacity-100"}`}
        aria-hidden={isDropped}
      >
        {children}
      </div>
    </div>
  );
}
