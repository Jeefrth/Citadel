import {
  Activity,
  Building2,
  ClipboardCheck,
  Container,
  FileBarChart,
  Film,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogIn,
  type LucideIcon,
  Network,
  RefreshCw,
  ScrollText,
  Server,
  ShieldAlert,
  Settings,
  Shield,
  Terminal,
} from "lucide-react";
import type { Requirement } from "@/services/permissions";

/**
 * Nav requirement: a permission requirement, "k8s" or "platform" (platform admin),
 * the last two resolved by the layout.
 */
export type NavRequirement = Requirement | "k8s" | "platform";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * Who sees the entry: a permission, any of several, or "admin". None: everyone.
   * "k8s": users who see at least one cluster, or hold the "kubernetes" permission.
   */
  perm?: NavRequirement;
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
      { to: "/kubernetes", label: "Kubernetes", icon: Container, perm: "k8s" },
      { to: "/jobs", label: "Tâches", icon: ListChecks },
      { to: "/updates", label: "Mises à jour", icon: RefreshCw },
    ],
  },
  {
    label: "Gouvernance",
    items: [
      { to: "/approvals", label: "Validations", icon: ClipboardCheck, badge: "approvals" },
      { to: "/access", label: "Accès", icon: KeyRound, perm: ["policies", "secrets"] },
    ],
  },
  {
    label: "Audit",
    items: [
      { to: "/live", label: "Sessions en direct", icon: Activity, perm: "audit" },
      { to: "/sessions", label: "Enregistrements", icon: Film },
      { to: "/commands", label: "Journal des commandes", icon: ScrollText },
      { to: "/audit", label: "Journal d'audit", icon: Shield },
      { to: "/logins", label: "Connexions", icon: LogIn, perm: "audit" },
      { to: "/reports", label: "Rapports", icon: FileBarChart, perm: "audit" },
      { to: "/risks", label: "Risques", icon: ShieldAlert, perm: "audit" },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/infrastructure", label: "Infrastructure", icon: Network, perm: ["servers", "secrets"] },
      { to: "/settings", label: "Paramètres", icon: Settings, perm: "admin" },
      { to: "/platform/orgs", label: "Organisations", icon: Building2, perm: "platform" },
    ],
  },
];

const EXTRA_TITLES: Record<string, string> = { "/account": "Mon compte" };

/** Breadcrumb trail for a pathname: [{label, to?}] */
export function trailFor(pathname: string): { label: string; to?: string }[] {
  if (pathname.startsWith("/servers/")) return [{ label: "Serveurs", to: "/servers" }, { label: "Fiche serveur" }];
  if (pathname.startsWith("/kubernetes/"))
    return [{ label: "Kubernetes", to: "/kubernetes" }, { label: "Cluster" }];
  if (pathname.startsWith("/jobs/")) return [{ label: "Tâches", to: "/jobs" }, { label: "Détail de la tâche" }];
  for (const g of NAV) {
    const item = g.items.find((i) => i.to === pathname);
    if (item) return pathname === "/" ? [{ label: item.label }] : [{ label: g.label }, { label: item.label }];
  }
  return [{ label: EXTRA_TITLES[pathname] ?? "Citadel" }];
}
