import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { allNavItems } from "./navigation";

function toLabel(segment: string): string {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Navigable hrefs the user can actually land on. Anything outside this set is
// a URL grouping (e.g. /inventory/units, /parties) with no listing page —
// rendering it as a Link would dead-end the user on the catch-all redirect.
// Source of truth is the sidebar nav config; /dashboard is added explicitly
// because Home links there.
const NAVIGABLE_HREFS = new Set<string>([
  "/dashboard",
  ...allNavItems.map((i) => i.href),
]);

export function Breadcrumbs() {
  const { pathname } = useLocation();

  if (pathname === "/dashboard" || pathname === "/") return null;

  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => ({
    label: toLabel(segment),
    href: "/" + segments.slice(0, index + 1).join("/"),
  }));

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 px-4 py-2 text-xs text-[var(--text-muted)] lg:px-6"
    >
      <Link to="/dashboard" className="transition hover:text-[var(--text-primary)]">
        Home
      </Link>
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const isNavigable = NAVIGABLE_HREFS.has(crumb.href);
        return (
          <span key={crumb.href} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            {isLast || !isNavigable ? (
              <span className={isLast ? "font-medium text-[var(--text-secondary)]" : undefined}>
                {crumb.label}
              </span>
            ) : (
              <Link to={crumb.href} className="transition hover:text-[var(--text-primary)]">
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
