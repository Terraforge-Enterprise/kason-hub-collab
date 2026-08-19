import { Link, Outlet, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

const TABS: { id: "deals" | "log"; label: string; to: string }[] = [
  { id: "deals", label: "Deal Audit", to: "/audit/deals" },
  { id: "log", label: "Audit Log", to: "/audit/log" },
];

export default function AuditLayout() {
  const { pathname } = useLocation();
  return (
    <div className="space-y-6">
      <div className="border-b border-border/50">
        <nav className="flex gap-1" aria-label="Audit">
          {TABS.map((tab) => {
            const isActive = pathname === tab.to || pathname.startsWith(tab.to + "/");
            return (
              <Link
                key={tab.id}
                to={tab.to}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2",
                  isActive
                    ? "text-primary border-primary"
                    : "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
