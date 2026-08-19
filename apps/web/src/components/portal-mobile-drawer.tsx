import { Dialog } from "@base-ui/react/dialog";
import { Menu, X, LogOut, Plus } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { getPortalNavSections } from "@/pages/portal/components/portal-nav";
import { usePortalProfile } from "@/components/portal-protected-route";
import { ThemeToggle } from "@/components/theme-toggle";
import { AddPropertyChooser } from "@/components/add-property-chooser";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Mobile/tablet nav drawer for the portal layout — the portal mirror of the
// admin MobileDrawer (apps/web/src/components/mobile-drawer.tsx). The portal
// sidebar is `hidden lg:flex`, so below `lg` this hamburger is the ONLY way to
// reach the nav. It rebuilds the portal sidebar's content (brand header, agent
// "Add Property" CTA, role-scoped nav, theme toggle, sign out) inside a Dialog.
// Auth stays the caller's job: PortalLayout owns logout (queryClient.clear +
// portalApiFetch), so it's passed in rather than re-derived here.

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

export function PortalMobileDrawer({ onLogout }: { onLogout: () => void | Promise<void> }) {
  const { pathname } = useLocation();
  const { data } = usePortalProfile();
  const profile = data?.data;
  const navSections = getPortalNavSections(profile?.userType ?? "tenant");

  const portalTitle =
    profile?.userType === "agent"
      ? "Agent Portal"
      : profile?.userType === "owner"
        ? "Owner Portal"
        : "Tenant Portal";

  const subtitle = !profile
    ? null
    : profile.userType === "agent"
      ? profile.fullName
      : profile.userType === "owner"
        ? `${profile.propertyCount ?? 0} Properties`
        : profile.propertyName && profile.unitCode
          ? `${profile.propertyName} — ${profile.unitCode}`
          : "No active lease";

  return (
    <Dialog.Root>
      <Dialog.Trigger
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] transition hover:bg-[var(--page-bg)] lg:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="h-4 w-4" />
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-[var(--sidebar-bg)] text-[var(--sidebar-ink)] shadow-2xl data-open:animate-in data-open:slide-in-from-left data-open:fade-in-0 data-closed:animate-out data-closed:slide-out-to-left data-closed:fade-out-0 duration-200">
          {/* Brand header — mirrors the portal sidebar brand block */}
          <div className="flex items-center justify-between border-b border-[var(--sidebar-border)] px-4 py-4">
            <div className="flex items-center gap-3 min-w-0">
              <img src="/logo.png" alt="KAEN Properties" className="h-8 w-8 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--gold)]">{portalTitle}</div>
                {subtitle && (
                  <div className="text-xs text-[var(--sidebar-muted)] truncate">{subtitle}</div>
                )}
              </div>
            </div>
            <Dialog.Close className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--sidebar-muted)] transition hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-ink)]">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Add Property — agents only (mirrors sidebar CTA) */}
          {profile?.userType === "agent" && (
            <div className="px-3 pt-3">
              <AddPropertyChooser
                trigger={
                  <Button variant="gold" size="sm" className="w-full">
                    <Plus className="h-3.5 w-3.5" /> Add Property
                  </Button>
                }
              />
            </div>
          )}

          {/* Nav items, grouped by section */}
          <nav className="scrollbar-slim flex-1 space-y-4 overflow-y-auto px-2 py-4">
            {navSections.map((section, sectionIdx) => (
              <div key={section.label || `section-${sectionIdx}`} className="space-y-1">
                {section.label && (
                  <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--sidebar-muted)]">
                    {section.label}
                  </div>
                )}
                {section.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Dialog.Close
                      key={item.href}
                      render={
                        <Link
                          to={item.href}
                          className={cn(
                            "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                            active
                              ? "bg-[var(--sidebar-active-bg)] text-[var(--gold)]"
                              : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-ink)]",
                          )}
                        />
                      }
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.title}</span>
                    </Dialog.Close>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* Footer — theme toggle + sign out (mirrors sidebar footer) */}
          <div className="space-y-1 border-t border-[var(--sidebar-border)] px-2 py-4">
            <div className="flex items-center justify-between px-1">
              <span className="px-2 text-xs text-[var(--sidebar-muted)]">Theme</span>
              <ThemeToggle />
            </div>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-[var(--sidebar-muted)] transition hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-ink)]"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              Sign Out
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
