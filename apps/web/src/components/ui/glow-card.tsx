import { useRef, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type GlowColor = "blue" | "purple" | "green" | "red" | "orange" | "gold";

const glowColorMap: Record<GlowColor, { base: number; spread: number }> = {
  blue:   { base: 220, spread: 200 },
  purple: { base: 280, spread: 300 },
  green:  { base: 120, spread: 200 },
  red:    { base: 0,   spread: 200 },
  orange: { base: 30,  spread: 200 },
  gold:   { base: 43,  spread: 160 },
};

export function GlowCard({
  children,
  className,
  glowColor = "blue",
}: {
  children: ReactNode;
  className?: string;
  glowColor?: GlowColor;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let rafId = 0;
    let lastX = 0;
    let lastY = 0;

    const syncPointer = (e: PointerEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          if (cardRef.current) {
            cardRef.current.style.setProperty("--x", lastX.toFixed(0));
            cardRef.current.style.setProperty("--xp", (lastX / window.innerWidth).toFixed(2));
            cardRef.current.style.setProperty("--y", lastY.toFixed(0));
            cardRef.current.style.setProperty("--yp", (lastY / window.innerHeight).toFixed(2));
          }
          rafId = 0;
        });
      }
    };

    document.addEventListener("pointermove", syncPointer);
    return () => {
      document.removeEventListener("pointermove", syncPointer);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  const { base, spread } = glowColorMap[glowColor];

  return (
    <div
      ref={cardRef}
      data-glow
      style={{
        "--base": base,
        "--spread": spread,
        "--radius": "14",
        "--border": "2",
        "--backdrop": "hsl(0 0% 60% / 0.08)",
        "--backup-border": "var(--backdrop)",
        "--size": "180",
        "--outer": "1",
        "--border-size": "calc(var(--border, 2) * 1px)",
        "--spotlight-size": "calc(var(--size, 150) * 1px)",
        "--hue": "calc(var(--base) + (var(--xp, 0) * var(--spread, 0)))",
        backgroundImage: `radial-gradient(
          var(--spotlight-size) var(--spotlight-size) at
          calc(var(--x, 0) * 1px)
          calc(var(--y, 0) * 1px),
          hsl(var(--hue, 210) calc(var(--saturation, 100) * 1%) calc(var(--lightness, 70) * 1%) / var(--bg-spot-opacity, 0.1)), transparent
        )`,
        backgroundColor: "var(--backdrop, transparent)",
        backgroundSize: "calc(100% + (2 * var(--border-size))) calc(100% + (2 * var(--border-size)))",
        backgroundPosition: "50% 50%",
        backgroundAttachment: "fixed",
        border: "var(--border-size) solid var(--backup-border)",
        position: "relative",
        touchAction: "none",
      } as React.CSSProperties}
      className={cn(
        "rounded-2xl relative backdrop-blur-sm",
        className,
      )}
    >
      <div data-glow />
      {children}
    </div>
  );
}
