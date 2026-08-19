import { useEffect, useRef, useState } from "react";
import { ActionButton } from "@/components/form-ui";
import { cn } from "@/lib/utils";
import { ListingMediaPanel } from "./listing-media-panel";

/**
 * The "Photos & videos" card for ONE listing, mirroring the shipped
 * unit-detail-page mount. Owns LOCAL photoKeys/videoKeys state seeded ONCE from
 * the initial props: the panel writes to /listings/:id/media immediately (the
 * server is the source of truth), so this state is display-only and must never
 * re-seed from a parent re-render — hence useState lazy init, not a derived
 * useEffect. This is the single reusable media unit for both create and edit.
 */
export function SingleUnitMediaPanel({
  listingId,
  initialPhotoKeys = [],
  initialVideoKeys = [],
  onMediaChanged,
}: {
  listingId: string;
  initialPhotoKeys?: string[];
  initialVideoKeys?: string[];
  // Optional — fires on every server-confirmed media change (add/delete)
  // after the initial mount. Lets a host (EditUnitForm) keep its own cache
  // of this listing's media in sync without owning the upload/delete flow
  // itself. Never fires on mount (the initial keys are not a "change").
  onMediaChanged?: (next: { photoKeys: string[]; videoKeys: string[] }) => void;
}) {
  const [photoKeys, setPhotoKeys] = useState<string[]>(() => initialPhotoKeys);
  const [videoKeys, setVideoKeys] = useState<string[]>(() => initialVideoKeys);

  // Read the latest callback through a ref so a new onMediaChanged identity
  // per parent render (e.g. an inline arrow function) never re-triggers the
  // effect below — only an actual photoKeys/videoKeys change should.
  const onMediaChangedRef = useRef(onMediaChanged);
  useEffect(() => {
    onMediaChangedRef.current = onMediaChanged;
  }, [onMediaChanged]);

  // Skip the effect's first run (the initial mount, seeded from props) —
  // only fire for actual post-mount changes (a server-confirmed add/delete
  // flowing back through setPhotoKeys/setVideoKeys below). Deliberately NOT
  // a boolean "have we fired yet" flag: React 18/19 StrictMode (this app's
  // root — main.tsx) double-invokes a fresh effect once in dev (setup ->
  // cleanup -> setup again, same commit/closure) to surface exactly this
  // class of bug. A flag flips true->false on the first invocation and
  // stays false for the second, so the second invocation would wrongly
  // read "already seeded" and fire with the unchanged initial keys.
  // Comparing against a fixed baseline captured once via useRef's lazy
  // initializer is idempotent — both StrictMode invocations reach the same
  // "unchanged" conclusion — while a REAL update still produces new
  // photoKeys/videoKeys array references that compare unequal to the seed.
  const seedRef = useRef({ photoKeys, videoKeys });
  useEffect(() => {
    const seed = seedRef.current;
    if (photoKeys === seed.photoKeys && videoKeys === seed.videoKeys) return;
    onMediaChangedRef.current?.({ photoKeys, videoKeys });
  }, [photoKeys, videoKeys]);

  return (
    <div className="rounded-xl border border-border/50 bg-background/40 px-4 py-4 space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-[3px] h-[18px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
          Photos &amp; videos
        </span>
        <span className="text-xs text-muted-foreground">
          · {photoKeys.length} photos · {videoKeys.length} videos
        </span>
      </div>
      <ListingMediaPanel
        listingId={listingId}
        photoKeys={photoKeys}
        videoKeys={videoKeys}
        onPhotoKeysChange={setPhotoKeys}
        onVideoKeysChange={setVideoKeys}
      />
    </div>
  );
}

export type CreatedRoom = { id: string; label: string };

/**
 * Post-save create step. Whole unit → one media card. Partition → one tab per
 * created room, each bound to its own listingId. Every panel stays MOUNTED
 * (inactive ones hidden via the `hidden` attribute) so switching tabs never
 * remounts a panel mid-upload and never loses its queue. Empty keys ⇒ each
 * panel skips its download-urls fetch (listing-media-panel.tsx:200), so N
 * panels cost zero extra unit fetches (spec R6). Media is optional: Done closes.
 */
export function CreateUnitMediaStep({
  rooms,
  onDone,
}: {
  rooms: CreatedRoom[];
  onDone: () => void;
}) {
  const [active, setActive] = useState(0);
  const multi = rooms.length > 1;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Standard ARIA-tabs keyboard idiom: Arrow keys move + wrap, Home/End jump
  // to the ends, and focus follows the newly active tab (roving tabIndex).
  function focusTab(index: number) {
    setActive(index);
    tabRefs.current[index]?.focus();
  }

  function handleTabListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const count = rooms.length;
    if (count === 0) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusTab((active + 1) % count);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusTab((active - 1 + count) % count);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTab(count - 1);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-semibold text-foreground">
          Unit created — add photos &amp; videos
        </div>
        <p className="text-xs text-muted-foreground">
          Media is optional. Add it now, or click Done to finish.
        </p>
      </div>

      {multi && (
        <div
          role="tablist"
          aria-label="Created rooms"
          onKeyDown={handleTabListKeyDown}
          className="flex flex-wrap items-center gap-1.5 border-b border-border/50 pb-3"
        >
          {rooms.map((r, i) => (
            <button
              key={r.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`create-media-tab-${r.id}`}
              aria-selected={i === active}
              aria-controls={`create-media-panel-${r.id}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors",
                i === active
                  ? "bg-[#D4AF37]/15 text-[#D4AF37] ring-1 ring-[#D4AF37]/40"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {rooms.map((r, i) =>
        multi ? (
          <div
            key={r.id}
            role="tabpanel"
            id={`create-media-panel-${r.id}`}
            aria-labelledby={`create-media-tab-${r.id}`}
            hidden={i !== active}
          >
            <SingleUnitMediaPanel listingId={r.id} />
          </div>
        ) : (
          <div key={r.id}>
            <SingleUnitMediaPanel listingId={r.id} />
          </div>
        ),
      )}

      <div className="flex justify-end">
        <ActionButton type="button" variant="primary" onClick={onDone}>
          Done
        </ActionButton>
      </div>
    </div>
  );
}
