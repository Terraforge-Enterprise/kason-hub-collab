import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsLeft, ChevronsRight, LogOut, Plus } from "lucide-react";
import { getPortalNavSections } from "@/pages/portal/components/portal-nav";
import { usePortalProfile } from "@/components/portal-protected-route";
import { portalApiFetch } from "@/lib/portal-api";
import { clearStoredAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { AddPropertyChooser } from "@/components/add-property-chooser";
import { Button } from "@/components/ui/button";
import { DashboardHeader } from "@/components/dashboard-header";
import { PortalMobileDrawer } from "@/components/portal-mobile-drawer";
import { UserMenu } from "@/components/user-menu";
import { LegalFooterLinks } from "@/components/legal-footer-links";

const SIDEBAR_KEY = "portal-sidebar-collapsed";

export default function PortalLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = usePortalProfile();
  const profile = data?.data;
  const navSections = getPortalNavSections(profile?.userType ?? "tenant");

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === "true"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_KEY, String(collapsed)); } catch { /* localStorage unavailable */ }
  }, [collapsed]);

  const handleLogout = async () => {
    try {
      await portalApiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Cookie already cleared or network error — redirect anyway
    }
    // Drop the bearer-token fallback alongside cookies, otherwise the next
    // mobile user on this device would auto-authenticate via the leftover
    // localStorage token.
    clearStoredAuth();
    // Drop cached queries (profile, claims, etc) so the next user sees fresh data.
    queryClient.clear();
    navigate("/portal/login");
  };

  return (
    <div className="flex h-screen bg-[var(--page-bg)]">
      {/* Sidebar */}
      <aside
        className={`hidden lg:flex flex-col bg-[var(--sidebar-bg)] text-[var(--sidebar-ink)] transition-all duration-300 ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        {/* Brand header */}
        <div className={`flex border-b border-[var(--sidebar-border)] ${collapsed ? "flex-col items-center gap-2 px-2 py-5" : "items-center justify-between px-6 py-5"}`}>
          {collapsed ? (
            <>
              <img src="/logo.png" alt="KAEN Properties" className="h-8 w-8 shrink-0" />
              <button
                onClick={() => setCollapsed(!collapsed)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--sidebar-muted)] hover:text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-hover)] transition-colors"
                title="Expand sidebar"
              >
                <ChevronsRight className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 min-w-0">
                <img src="/logo.png" alt="KAEN Properties" className="h-8 w-8 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[var(--gold)]">
                    {profile?.userType === "agent"
                      ? "Agent Portal"
                      : profile?.userType === "owner"
                        ? "Owner Portal"
                        : "Tenant Portal"}
                  </div>
                  {profile && (
                    <div className="text-xs text-[var(--sidebar-muted)] truncate">
                      {profile.userType === "agent"
                        ? profile.fullName
                        : profile.userType === "owner"
                          ? `${profile.propertyCount ?? 0} Properties`
                          : profile.propertyName && profile.unitCode
                            ? `${profile.propertyName} — ${profile.unitCode}`
                            : "No active lease"}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => setCollapsed(!collapsed)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--sidebar-muted)] hover:text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-hover)] transition-colors"
                title="Collapse sidebar"
              >
                <ChevronsLeft className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        {/* + Add Property — agents only. Single CTA that opens a Sale /
            Rent chooser; both options route through the source queue
            server-side. Per unified-property-sourcing spec §6.2. */}
        {profile?.userType === "agent" && !collapsed && (
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
        <nav className="scrollbar-slim flex-1 px-2 py-4 space-y-4 overflow-y-auto">
          {navSections.map((section, sectionIdx) => (
            <div key={section.label || `section-${sectionIdx}`} className="space-y-1">
              {!collapsed && section.label && (
                <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--sidebar-muted)]">
                  {section.label}
                </div>
              )}
              {section.items.map((item) => (
                <NavLink
                  key={item.href}
                  to={item.href}
                  title={collapsed ? item.title : undefined}
                  className={({ isActive }) =>
                    `flex items-center rounded-md text-sm transition-colors ${
                      collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
                    } ${
                      isActive
                        ? "bg-[var(--sidebar-active-bg)] text-[var(--gold)]"
                        : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-ink)]"
                    }`
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate">{item.title}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer — Profile moved to the top-right UserMenu dropdown
            (admin parity). Theme toggle + Sign Out stay here to mirror
            admin's SidebarShell footer, which also keeps a Logout
            icon-button at the bottom (apps/web/src/components/sidebar.tsx). */}
        <div className="px-2 py-4 border-t border-[var(--sidebar-border)] space-y-1">
          {profile && !collapsed && (
            <div className="px-3 py-2 text-xs text-[var(--sidebar-muted)] truncate">{profile.fullName}</div>
          )}
          {collapsed ? (
            <div className="flex justify-center">
              <ThemeToggle />
            </div>
          ) : (
            <div className="flex items-center justify-between px-1">
              <span className="px-2 text-xs text-[var(--sidebar-muted)]">Theme</span>
              <ThemeToggle />
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            title={collapsed ? "Sign Out" : undefined}
            className={`flex items-center w-full rounded-md text-sm text-[var(--sidebar-muted)] hover:text-[var(--sidebar-ink)] hover:bg-[var(--sidebar-hover)] ${
              collapsed ? "justify-center px-2 py-2" : "gap-3 px-3 py-2"
            }`}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && "Sign Out"}
          </button>
        </div>
      </aside>

      {/* Main content + top header */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <DashboardHeader leftSlot={<PortalMobileDrawer onLogout={handleLogout} />}>
          <UserMenu
            fullName={profile?.fullName ?? ""}
            role={profile?.userType ?? "agent"}
            profileHref="/portal/profile"
            profileLabel="Profile"
            onLogout={handleLogout}
          />
        </DashboardHeader>
        <main className="flex-1 overflow-y-auto">
          <div className="px-6 py-6 max-w-[1400px] mx-auto">
            <Outlet />
          </div>
          {/*
            Consumer policy links for signed-in tenants and owners. Without
            this, a tenant who wanted to re-read the refund policy after paying
            would have to log out to find it — the links otherwise exist only on
            the login screen and inside the payment step.

            Inside <main> so it scrolls with the content rather than pinning
            over it. Admin pages deliberately do NOT carry this: admin users are
            internal staff, not the consumers these disclosures are owed to.
          */}
          <div className="px-6 pb-8 pt-2 max-w-[1400px] mx-auto">
            <div className="border-t border-[var(--border)] pt-5">
              <LegalFooterLinks showEntity />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
