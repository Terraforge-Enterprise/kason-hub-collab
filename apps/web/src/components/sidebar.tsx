import { useState, useEffect } from "react";
import { ChevronsLeft, ChevronsRight, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api-client";
import { SidebarNav } from "./dashboard-nav";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/utils";

export function SidebarShell() {
  const { user, clearAuth } = useAuth();
  const navigate = useNavigate();

  const role = user?.role ?? "viewer";

  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem("admin-sidebar-collapsed") === "true";
  });

  useEffect(() => {
    localStorage.setItem("admin-sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  const handleLogout = async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    clearAuth();
    navigate("/login");
  };

  const toggleBtn = (
    <button
      type="button"
      onClick={() => setCollapsed((c) => !c)}
      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--sidebar-muted)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--gold-light)]"
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {collapsed ? (
        <ChevronsRight className="h-4 w-4" />
      ) : (
        <ChevronsLeft className="h-4 w-4" />
      )}
    </button>
  );

  return (
    <aside
      className={cn(
        "hidden lg:flex flex-col shrink-0 transition-all duration-300",
        collapsed ? "w-16" : "w-60",
        "bg-[var(--sidebar-bg)] border-r border-white/[0.06]",
        "py-5",
      )}
    >
      {/* Brand */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 px-2 pb-4">
          <img
            src="/logo.png"
            alt="KAEN Properties"
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-lg object-contain"
          />
          {toggleBtn}
        </div>
      ) : (
        <div className="flex items-center justify-between px-5 pb-4">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/logo.png"
              alt="KAEN Properties"
              width={40}
              height={40}
              className="h-10 w-10 shrink-0 rounded-lg object-contain"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">KAEN Properties</p>
              <p className="truncate text-[11px] text-[var(--sidebar-muted)]">Property Management</p>
            </div>
          </div>
          {toggleBtn}
        </div>
      )}

      <div className={cn("mb-3 h-px bg-white/[0.08]", collapsed ? "mx-2" : "mx-5")} />

      <div className="scrollbar-slim flex-1 overflow-y-auto overflow-x-hidden px-3">
        <SidebarNav collapsed={collapsed} />
      </div>

      <div className={cn("mt-2 h-px bg-white/[0.08]", collapsed ? "mx-2" : "mx-5")} />

      {collapsed ? (
        <div className="flex justify-center px-2 pt-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--sidebar-muted)] transition hover:bg-[var(--sidebar-hover)] hover:text-red-400"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between px-5 pt-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--gold-muted)]">
              {role}
            </span>
            <ThemeToggle />
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--sidebar-muted)] transition hover:bg-[var(--sidebar-hover)] hover:text-red-400"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      )}
    </aside>
  );
}
