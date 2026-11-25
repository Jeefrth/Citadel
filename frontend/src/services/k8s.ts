// Kubernetes (lot 8): types of /api/k8s/*, labels and the "is the menu visible" check.
import { useEffect, useState } from "react";
import { api } from "@/services/api";

export type K8sAction = "view" | "logs" | "exec" | "manage";
export const K8S_ACTIONS: K8sAction[] = ["view", "logs", "exec", "manage"];

export const K8S_ACTION_LABELS: Record<K8sAction, string> = {
  view: "Consulter",
  logs: "Logs",
  exec: "Shell",
  manage: "Gérer",
};

export const K8S_ACTION_HELP: Record<K8sAction, string> = {
  view: "Lister espaces de noms, pods, charges et événements",
  logs: "Lire les logs d'un conteneur",
  exec: "Ouvrir un shell dans un conteneur",
  manage: "Redémarrer un pod, mettre à l'échelle, redémarrer une charge",
};

export interface K8sCluster {
  id: string;
  name: string;
  description: string | null;
  api_url: string;
  has_ca_cert: boolean;
  skip_tls_verify: boolean;
  has_token: boolean;
  node_id: string | null;
  zone_id: string | null;
  tags: Record<string, string>;
  is_active: boolean;
  version: string | null;
  last_check_at: string | null;
  last_check_status: "ok" | "error" | null;
  last_check_message: string | null;
  /** Actions of the current user on this cluster (all for an admin). */
  actions?: K8sAction[];
  /** Namespaces (names or patterns) granted to the current user. */
  namespaces?: string[];
}

export interface K8sClusterInput {
  name: string;
  description: string | null;
  api_url: string;
  ca_cert: string | null;
  skip_tls_verify: boolean;
  token: string | null;
  node_id: string | null;
  zone_id: string | null;
  tags: Record<string, string>;
  is_active: boolean;
}

export interface K8sPolicy {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  user_ids: string[];
  group_ids: string[];
  cluster_ids: string[];
  namespaces: string[];
  actions: K8sAction[];
  created_at: string;
}

export interface K8sNamespace {
  name: string;
  status: string | null;
  age_seconds: number | null;
}

export interface K8sPod {
  name: string;
  namespace: string;
  phase: string | null;
  node: string | null;
  ip: string | null;
  ready: string;
  restarts: number;
  containers: string[];
  reason: string | null;
  owner: { kind: string; name: string } | null;
  age_seconds: number | null;
}

export type K8sWorkloadKind = "deployments" | "statefulsets" | "daemonsets";

export const K8S_KIND_LABELS: Record<K8sWorkloadKind, string> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
};

export interface K8sWorkload {
  kind: K8sWorkloadKind;
  name: string;
  namespace: string;
  desired: number;
  ready: number;
  images: string[];
  age_seconds: number | null;
}

export interface K8sEvent {
  type: string | null;
  reason: string | null;
  message: string | null;
  object: string;
  count: number | null;
  last_seen: string | null;
}

export function canK8s(c: Pick<K8sCluster, "actions"> | null | undefined, a: K8sAction): boolean {
  return !!c?.actions?.includes(a);
}

/** "3 j", "5 h", "12 min", "40 s" */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds == null) return "-";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} j`;
}

// ── Menu visibility: at least one visible cluster (or the "kubernetes" permission) ──

let visibleCache: boolean | null = null;
let visiblePending: Promise<boolean> | null = null;

function loadVisible(): Promise<boolean> {
  if (visibleCache !== null) return Promise.resolve(visibleCache);
  visiblePending ??= api
    .get<K8sCluster[]>("/api/k8s/clusters")
    .then((list) => (visibleCache = list.length > 0))
    .catch(() => {
      visiblePending = null;
      return false;
    });
  return visiblePending;
}

/** Forget the cached answer (after a cluster was added or removed). */
export function refreshK8sVisibility(): void {
  visibleCache = null;
  visiblePending = null;
}

/** True when the user sees at least one cluster. Fetched once per page load. */
export function useHasK8sClusters(): boolean {
  const [has, setHas] = useState<boolean>(visibleCache ?? false);
  useEffect(() => {
    let alive = true;
    loadVisible().then((v) => alive && setHas(v));
    return () => {
      alive = false;
    };
  }, []);
  return has;
}
