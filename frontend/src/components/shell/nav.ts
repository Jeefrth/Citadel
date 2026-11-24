import {
  Activity,
  ClipboardCheck,
  Film,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  Network,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  Shield,
  Terminal,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  badge?: "approvals";
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Navigation grouped by what people do, not by how the backend is built. */
export const NAV: NavGroup[] = [
  {
    label: "Exploitation",
    items: [
      { to: "/", label: "Tableau de bord", icon: LayoutDashboard },
      { to: "/servers", label: "Serveurs", icon: Server },
      { to: "/terminal", label: "Terminal", icon: Terminal },
      { to: "/jobs", label: "Tâches", icon: ListChecks },
      { to: "/updates", label: "Mises à jour", icon: RefreshCw },
    ],
  },
  {
    label: "Gouvernance",
    items: [
      { to: "/approvals", label: "Validations", icon: ClipboardCheck, badge: "approvals" },
      { to: "/access", label: "Accès", icon: KeyRound, adminOnly: true },
    ],
  },
  {
    label: "Audit",
    items: [
      { to: "/live", label: "Sessions en direct", icon: Activity, adminOnly: true },
      { to: "/sessions", label: "Enregistrements", icon: Film },
      { to: "/commands", label: "Journal des commandes", icon: ScrollText },
      { to: "/audit", label: "Journal d'audit", icon: Shield },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/infrastructure", label: "Infrastructure", icon: Network, adminOnly: true },
      { to: "/settings", label: "Paramètres", icon: Settings, adminOnly: true },
    ],
  },
];

const EXTRA_TITLES: Record<string, string> = { "/account": "Mon compte" };

/** Breadcrumb trail for a pathname: [{label, to?}] */
export function trailFor(pathname: string): { label: string; to?: string }[] {
  if (pathname.startsWith("/servers/")) return [{ label: "Serveurs", to: "/servers" }, { label: "Fiche serveur" }];
  if (pathname.startsWith("/jobs/")) return [{ label: "Tâches", to: "/jobs" }, { label: "Détail de la tâche" }];
  for (const g of NAV) {
    const item = g.items.find((i) => i.to === pathname);
    if (item) return pathname === "/" ? [{ label: item.label }] : [{ label: g.label }, { label: item.label }];
  }
  return [{ label: EXTRA_TITLES[pathname] ?? "Citadel" }];
}
