import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { navSections, allNavItems, canSeeNavItemFor, type NavItem } from "./navigation";

// A prefix match (/inventory matching /inventory/agent-sourced) should lose
// to any more-specific nav sibling. Otherwise the parent lights up alongside
// its child — confusing the "where am I" signal.
function isActive(pathname: string, href: string, allItems: NavItem[]): boolean {
  if (href === "/dashboard") return pathname === href;
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  const hasMoreSpecificSibling = allItems.some(
    (other) =>
      other.href !== href &&
      other.href.length > href.length &&
      (pathname === other.href || pathname.startsWith(`${other.href}/`)),
  );
  return !hasMoreSpecificSibling;
}

function sectionExpandedKey(label: string) {
  return `sidebar-section-${label.toLowerCase().replace(/\s+/g, "-")}-expanded`;
}

/** Persisted expand/collapse state for a collapsible nav section. */
function useSectionExpanded(label: string, defaultExpanded: boolean) {
  const key = sectionExpandedKey(label);
  const [expanded, setExpanded] = useState<boolean>(() => {
    const stored = localStorage.getItem(key);
    if (stored === null) return defaultExpanded;
    return stored === "true";
  });
  useEffect(() => {
    localStorage.setItem(key, String(expanded));
  }, [key, expanded]);
  return [expanded, setExpanded] as const;
}

function NavLinkItem({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      to={item.href}
      title={collapsed ? item.title : undefined}
      className={cn(
        "group relative flex items-center rounded-lg py-2 text-sm font-medium transition-all duration-200",
        collapsed ? "justify-center px-2" : "gap-3 px-3",
        active
          ? "bg-[var(--sidebar-active-bg)] text-[var(--gold-light)] shadow-[inset_0_0_0_1px_var(--sidebar-active-border)]"
          : "text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-hover)] hover:text-white",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--gold)]" />
      )}
      <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{item.title}</span>}
    </Link>
  );
}

function CollapsibleSection({
  label,
  visibleItems,
  pathname,
  collapsed,
}: {
  label: string;
  visibleItems: NavItem[];
  pathname: string;
  collapsed: boolean;
}) {
  // If any item inside is active, force-open so the user sees their location.
  const hasActive = visibleItems.some((item) => isActive(pathname, item.href, allNavItems));
  const [expanded, setExpanded] = useSectionExpanded(label, false);
  const isOpen = expanded || hasActive;

  // In the icon-rail (sidebar collapsed) we can't show a header, so just hide
  // the parked items entirely. The user can expand the sidebar to access them.
  if (collapsed) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={isOpen}
        className="mb-1 flex items-center justify-between rounded-md px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--sidebar-muted)] transition-colors hover:text-[var(--gold-light)]"
      >
        <span>{label}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-200",
            isOpen ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      {isOpen &&
        visibleItems.map((item) => (
          <NavLinkItem
            key={item.href}
            item={item}
            active={isActive(pathname, item.href, allNavItems)}
            collapsed={false}
          />
        ))}
    </div>
  );
}

export function SidebarNav({ collapsed = false }: { collapsed?: boolean }) {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const role = user?.role;

  return (
    <nav className="flex w-full flex-col gap-5">
      {navSections.map((section) => {
        const visibleItems = section.items.filter((item) => canSeeNavItemFor(role, item, user?.permissions));
        if (visibleItems.length === 0) return null;
        if (section.collapsible) {
          return (
            <CollapsibleSection
              key={section.label}
              label={section.label}
              visibleItems={visibleItems}
              pathname={pathname}
              collapsed={collapsed}
            />
          );
        }
        return (
          <div key={section.label} className="flex flex-col gap-0.5">
            {!collapsed && (
              <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--sidebar-muted)]">
                {section.label}
              </p>
            )}
            {visibleItems.map((item) => (
              <NavLinkItem
                key={item.href}
                item={item}
                active={isActive(pathname, item.href, allNavItems)}
                collapsed={collapsed}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

export function MobileNav() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const role = user?.role;
  const visibleItems = allNavItems.filter((item) => canSeeNavItemFor(role, item, user?.permissions));

  return (
    <div className="relative">
      <nav className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        {visibleItems.map((item) => {
          const active = isActive(pathname, item.href, allNavItems);
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition",
                active
                  ? "border-[var(--gold)] bg-[#FFF9EC] text-[var(--navy-text)] dark:bg-muted"
                  : "border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {item.title}
            </Link>
          );
        })}
      </nav>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--card-bg)]" />
    </div>
  );
}
