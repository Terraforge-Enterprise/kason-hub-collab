import { FileText, Image as ImageIcon } from "lucide-react";

export type PhotoStripItem = {
  url: string;
  /** Renders a doc icon instead of an <img> thumbnail — set for non-image files (e.g. PDFs). */
  isDoc?: boolean;
  /** Accessible label for the thumbnail (e.g. the filename). Empty alt would drop the <img> to role="presentation". */
  alt?: string;
};

type Props = {
  items: PhotoStripItem[];
  total: number;
  onClick?: () => void;
};

export function PhotoStrip({ items, total, onClick }: Props) {
  const visible = items.slice(0, 3);
  const remaining = Math.max(0, total - visible.length);
  if (visible.length === 0) {
    return (
      <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
        <ImageIcon className="h-3.5 w-3.5" />
        No photos
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1"
    >
      {visible.map((item, i) =>
        item.isDoc ? (
          <span
            key={i}
            className="flex h-10 w-10 items-center justify-center rounded border border-[var(--card-border)] text-[var(--text-muted)]"
          >
            <FileText className="h-4 w-4" />
          </span>
        ) : (
          <img
            key={i}
            src={item.url}
            alt={item.alt ?? "Attachment"}
            className="h-10 w-10 rounded object-cover border border-[var(--card-border)]"
          />
        ),
      )}
      {remaining > 0 && (
        <span className="text-xs text-[var(--text-muted)]">+{remaining}</span>
      )}
    </button>
  );
}
