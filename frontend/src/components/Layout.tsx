import { Fragment } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useMsal } from "@azure/msal-react";
import { useTheme } from "next-themes";
import { motion } from "motion/react";
import { ChevronsUpDown, LogOut, Moon, Search, Sun, UserCog } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useCurrentUser } from "@/services/useCurrentUser";
import NotificationBell, { usePolledCount } from "@/components/NotificationBell";
import LiveIndicator from "@/components/shell/LiveIndicator";
import CommandPalette, { useCommandPalette } from "@/components/shell/CommandPalette";
import { NAV, trailFor } from "@/components/shell/nav";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

/** Citadel mark: a rampart silhouette, drawn rather than borrowed from an icon set. */
function CitadelMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M3 21V9h3V6h3v3h2V4h2v5h2V6h3v3h3v12h-7v-5a2 2 0 0 0-4 0v5H3z"
        fill="currentColor"
      />
    </svg>
  );
}

function AppSidebar({ isAdmin }: { isAdmin: boolean }) {
  const { pathname } = useLocation();
  const [pendingApprovals] = usePolledCount("/api/approvals/pending-count");
  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link to="/" className="flex h-10 items-center gap-2.5 px-2 text-sidebar-foreground">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <CitadelMark className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden">
            Citadel
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group) => {
          const items = group.items.filter((i) => isAdmin || !i.adminOnly);
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu>
                {items.map((item) => {
                  const active = isActive(item.to);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="relative">
                        <NavLink to={item.to}>
                          {active && (
                            <motion.span
                              layoutId="nav-active"
                              className="absolute inset-0 -z-0 rounded-md bg-sidebar-accent"
                              transition={{ type: "spring", stiffness: 500, damping: 40 }}
                            />
                          )}
                          <item.icon className="relative" />
                          <span className="relative">{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                      {item.badge === "approvals" && pendingApprovals > 0 && (
                        <SidebarMenuBadge className="bg-live text-live-foreground">{pendingApprovals}</SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function UserMenu() {
  const { instance, accounts } = useMsal();
  const account = accounts[0];
  const { user } = useCurrentUser();
  const { resolvedTheme, setTheme } = useTheme();
  const name = account?.name || user?.display_name || "Utilisateur";
  const email = account?.username || user?.email || "";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <Avatar className="size-8 rounded-md">
                <AvatarFallback className="rounded-md bg-sidebar-accent text-xs font-semibold">
                  {initials(name)}
                </AvatarFallback>
              </Avatar>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium text-sidebar-accent-foreground">{name}</span>
                <span className="truncate text-xs">{user?.role === "admin" ? "Administrateur" : user?.role === "operator" ? "Opérateur" : "Lecteur"}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{name}</div>
              <div className="truncate text-xs text-muted-foreground">{email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/account">
                <UserCog /> Mon compte
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              {resolvedTheme === "dark" ? "Thème clair" : "Thème sombre"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => instance.logoutRedirect()}>
              <LogOut /> Se déconnecter
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  const { isAdmin } = useCurrentUser();
  const palette = useCommandPalette();
  const trail = trailFor(pathname);

  return (
    <SidebarProvider>
      <AppSidebar isAdmin={isAdmin} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-5" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList>
              {trail.map((t, i) => (
                <Fragment key={`${t.label}-${i}`}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem>
                    {i === trail.length - 1 ? (
                      <BreadcrumbPage className="font-medium">{t.label}</BreadcrumbPage>
                    ) : t.to ? (
                      <BreadcrumbLink asChild>
                        <Link to={t.to}>{t.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <span>{t.label}</span>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>

          <div className="ml-auto flex items-center gap-2">
            {isAdmin && <LiveIndicator />}
            <Button
              variant="outline"
              size="sm"
              onClick={() => palette.setOpen(true)}
              className="h-8 gap-2 text-muted-foreground md:w-56 md:justify-start"
            >
              <Search className="size-4" />
              <span className="hidden md:inline">Rechercher</span>
              <kbd className="pointer-events-none ml-auto hidden h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] md:inline-flex">
                ⌘K
              </kbd>
            </Button>
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} isAdmin={isAdmin} />
    </SidebarProvider>
  );
}
