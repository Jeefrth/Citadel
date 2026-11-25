import { Fragment } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "next-themes";
import { motion } from "motion/react";
import { Building2, Check, ChevronsUpDown, LogOut, MailPlus, Moon, Search, Sun, UserCog } from "lucide-react";
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
import { logout } from "@/services/session";
import { roleLabel, switchOrg } from "@/services/org";
import NoOrgScreen from "@/components/NoOrgScreen";
import { useHasK8sClusters } from "@/services/k8s";
import NotificationBell, { usePolledCount } from "@/components/NotificationBell";
import LiveIndicator from "@/components/shell/LiveIndicator";
import CommandPalette, { useCommandPalette } from "@/components/shell/CommandPalette";
import { NAV, trailFor, type NavRequirement } from "@/components/shell/nav";
import { formatShortcut, useShortcut } from "@/services/shortcut";

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

function AppSidebar({ allows }: { allows: (req: NavRequirement | undefined) => boolean }) {
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
        <OrgSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {NAV.map((group) => {
          const items = group.items.filter((i) => allows(i.perm));
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

/**
 * Current organisation; with several, a dropdown to switch. Switching stores the slug
 * and reloads the app on the dashboard (every loaded view belongs to the previous org).
 */
function OrgSwitcher() {
  const { user } = useCurrentUser();
  const current = user?.org;
  if (!current) return null;
  const orgs = user?.orgs || [];

  const label = (
    <>
      <Building2 />
      <span className="min-w-0 flex-1 truncate text-left">{current.name}</span>
    </>
  );

  if (orgs.length <= 1) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={`Organisation : ${current.name}`}
            className="cursor-default text-muted-foreground hover:bg-transparent hover:text-muted-foreground active:bg-transparent"
            asChild
          >
            <div>{label}</div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              tooltip={`Organisation : ${current.name}`}
              className="border data-[state=open]:bg-sidebar-accent"
              aria-label={`Organisation : ${current.name}. Changer d'organisation`}
            >
              {label}
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-64">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Changer d'organisation</DropdownMenuLabel>
            {orgs.map((o) => {
              const isCurrent = o.id === current.id;
              return (
                <DropdownMenuItem
                  key={o.id}
                  onSelect={() => {
                    if (!isCurrent) switchOrg(o.slug);
                  }}
                  className="gap-2"
                >
                  <Check className={isCurrent ? "size-4" : "size-4 opacity-0"} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{o.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.role ? roleLabel(o.role) : "Administrateur (plateforme)"}
                    </span>
                  </span>
                  {!o.role && (
                    <span
                      className="shrink-0 rounded border border-info/25 bg-info/10 px-1 text-[10px] font-medium text-info"
                      title="Accès en tant qu'administrateur de la plateforme, sans appartenance"
                    >
                      Plateforme
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu() {
  const { user } = useCurrentUser();
  const { resolvedTheme, setTheme } = useTheme();
  const name = user?.display_name || "Utilisateur";
  const email = user?.email || "";
  const invites = user?.pending_invitations || 0;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <span className="relative shrink-0">
                <Avatar className="size-8 rounded-md">
                  <AvatarFallback className="rounded-md bg-sidebar-accent text-xs font-semibold">
                    {initials(name)}
                  </AvatarFallback>
                </Avatar>
                {invites > 0 && (
                  <span
                    className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-sidebar bg-live"
                    aria-label={`${invites} invitation${invites > 1 ? "s" : ""} en attente`}
                  />
                )}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium text-sidebar-accent-foreground">{name}</span>
                <span className="truncate text-xs">{roleLabel(user?.role || "viewer")}
                  {user?.custom_role_name && user.role !== "admin" ? `, ${user.custom_role_name}` : ""}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{name}</div>
              <div className="truncate text-xs text-muted-foreground">{email}</div>
              {user?.org && (
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {roleLabel(user.role)} dans {user.org.name}
                </div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/account">
                <UserCog /> Mon compte
              </Link>
            </DropdownMenuItem>
            {invites > 0 && (
              <DropdownMenuItem asChild>
                <Link to="/account#invitations">
                  <MailPlus /> Invitations
                  <span className="tabular ml-auto rounded bg-live/10 px-1.5 text-xs font-medium text-live">{invites}</span>
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              {resolvedTheme === "dark" ? "Thème clair" : "Thème sombre"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void logout()}>
              <LogOut /> Se déconnecter
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** No organisation for this account: dedicated screen instead of the shell. */
export default function Layout() {
  const { noOrg } = useCurrentUser();
  return noOrg ? <NoOrgScreen /> : <AppShell />;
}

function AppShell() {
  const { pathname } = useLocation();
  const { can, allows: allowsPerm, isPlatformAdmin } = useCurrentUser();
  const hasClusters = useHasK8sClusters();
  const allows = (req: NavRequirement | undefined) =>
    req === "k8s" ? hasClusters || can("kubernetes") : req === "platform" ? isPlatformAdmin : allowsPerm(req);
  const palette = useCommandPalette();
  const [shortcut] = useShortcut();
  const trail = trailFor(pathname);

  return (
    <SidebarProvider>
      <AppSidebar allows={allows} />
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
            {can("audit") && <LiveIndicator />}
            <Button
              variant="outline"
              size="sm"
              onClick={() => palette.setOpen(true)}
              className="h-8 gap-2 text-muted-foreground md:w-56 md:justify-start"
            >
              <Search className="size-4" />
              <span className="hidden md:inline">Rechercher</span>
              <kbd className="pointer-events-none ml-auto hidden h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] md:inline-flex">
                {formatShortcut(shortcut)}
              </kbd>
            </Button>
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} allows={allows} />
    </SidebarProvider>
  );
}
