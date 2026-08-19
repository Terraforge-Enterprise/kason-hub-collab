import { LogOut, UserCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

type UserMenuProps = {
  fullName: string;
  role: string;
  // Where "My account" / "Profile" navigates to. Admin → "/account",
  // portal → "/portal/profile". No default — explicit callers only, so
  // adding a new layout can't silently route to the wrong page.
  profileHref: string;
  profileLabel?: string;
  // Each layout owns its own auth client: admin uses apiFetch + useAuth,
  // portal uses portalApiFetch (no useAuth — cookie-only session). The
  // menu doesn't pick a side; the caller wires it.
  onLogout: () => Promise<void> | void;
};

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

function formatRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

export function UserMenu({ fullName, role, profileHref, profileLabel = "My account", onLogout }: UserMenuProps) {
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] text-sm font-bold text-white transition hover:opacity-90 focus:outline-none">
        {getInitial(fullName)}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 py-2">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {fullName}
            </p>
            <span className="mt-0.5 inline-block rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--gold)] dark:bg-amber-900/20">
              {formatRole(role)}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate(profileHref)}>
          <UserCircle className="h-4 w-4" />
          {profileLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void onLogout()}>
          <LogOut className="h-4 w-4" />
          Logout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
