// SectionNav — sticky jump-nav for the Edit-apartment form.
//
// A horizontal pill bar pinned to the top of the dialog's scroll area. Each
// pill jumps to a form section and highlights while that section is in view.
// Purely a navigation aid: it holds no form state and every pill is
// `type="button"`, so it never submits the surrounding <form>.
//
// Scroll-spy observes the section elements against the dialog's own scroll
// container (the closest [data-slot="dialog-content"]), not the window — the
// form lives inside a scrollable modal, so window intersection would never
// fire. All DOM access happens in an effect and is null-guarded; if anything is
// missing the bar simply doesn't highlight — the form stays fully usable.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type SectionNavItem = { id: string; label: string };

export function SectionNav({ items }: { items: SectionNavItem[] }) {
  const navRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>(items[0]?.id ?? "");
  // Stable dependency for the effect — items is rebuilt every render.
  const key = items.map((i) => i.id).join("|");

  useEffect(() => {
    const root =
      (navRef.current?.closest('[data-slot="dialog-content"]') as HTMLElement | null) ??
      null;
    const els = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;
    // Feature-guard: jsdom (and any environment without it) has no
    // IntersectionObserver. The nav still jumps on click — it just skips the
    // active-on-scroll highlight rather than throwing during render.
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const inView = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (inView[0]) setActive(inView[0].target.id);
      },
      // Bias toward the section whose top is near the upper third of the
      // viewport so the highlight tracks what the admin is actually reading.
      { root, rootMargin: "-12% 0px -68% 0px", threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function jump(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setActive(id);
  }

  if (items.length < 2) return null;

  return (
    <div
      ref={navRef}
      aria-label="Jump to section"
      className="sticky top-0 z-20 -mx-6 flex gap-1.5 overflow-x-auto border-b border-border/50 bg-background/95 px-6 py-2.5 backdrop-blur-xl"
    >
      {items.map((i) => {
        const on = active === i.id;
        return (
          <button
            key={i.id}
            type="button"
            aria-current={on ? "location" : undefined}
            onClick={() => jump(i.id)}
            className={cn(
              "shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold tracking-wide transition-colors",
              on
                ? "bg-[#D4AF37]/15 text-[#D4AF37] ring-1 ring-[#D4AF37]/30"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            {i.label}
          </button>
        );
      })}
    </div>
  );
}
