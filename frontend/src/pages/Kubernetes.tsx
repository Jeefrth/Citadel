// Kubernetes (lot 8): clusters the user may see, cluster management and access rules
// (permission "kubernetes").
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, Container, Pencil, Plus, PlugZap, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type NodeData, type UserData, type UserGroupData, type ZoneData } from "@/services/types";
import {
  K8S_ACTIONS,
  K8S_ACTION_HELP,
  K8S_ACTION_LABELS,
  canK8s,
  refreshK8sVisibility,
  type K8sAction,
  type K8sCluster,
  type K8sClusterInput,
  type K8sPolicy,
} from "@/services/k8s";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  LabelChips,
  LabelEditor,
  Modal,
  MultiSelect,
  PageHeader,
  SaveButton,
  Tabs,
  Toggle,
  formatDate,
  iconBtn,
  iconBtnDanger,
} from "@/components/kit";
import { StatusDot, TableSkeleton, Tip } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Tab = "clusters" | "policies";
const NONE = "__none";

export default function Kubernetes() {
  const { can, loading: userLoading } = useCurrentUser();
  const canManage = can("kubernetes");
  const [params, setParams] = useSearchParams();
  const tab: Tab = canManage && params.get("tab") === "policies" ? "policies" : "clusters";
  const [clusters, setClusters] = useState<K8sCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<K8sCluster[]>("/api/k8s/clusters")
      .then((list) => {
        setClusters(list);
        setError(null);
      })
      .catch((e) => {
        setClusters((c) => c ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(load, [load]);

  if (userLoading) return null;
  if (!canManage && clusters !== null && clusters.length === 0 && !error) return <Navigate to="/" replace />;

  return (
    <div>
      <PageHeader
        title="Kubernetes"
        description="Clusters accessibles par Citadel : pods, charges, événements et logs des espaces de noms qui vous sont accordés, shell dans un conteneur avec les mêmes contrôles qu'un terminal SSH."
      />
      {canManage && (
        <Tabs
          tabs={[
            { id: "clusters" as Tab, label: "Clusters", icon: Container },
            { id: "policies" as Tab, label: "Règles d'accès", icon: ShieldCheck },
          ]}
          active={tab}
          onChange={(t) => setParams(t === "clusters" ? {} : { tab: t }, { replace: true })}
        />
      )}
      <ErrorBox message={error} />
      {tab === "clusters" ? (
        <ClustersPanel
          clusters={clusters}
          canManage={canManage}
          onChanged={load}
          openNew={canManage && params.get("new") === "1"}
          onNewHandled={() => setParams({}, { replace: true })}
        />
      ) : (
        <PoliciesPanel clusters={clusters || []} />
      )}
    </div>
  );
}

// ── Clusters ──────────────────────────────────────────────

function CheckState({ c }: { c: K8sCluster }) {
  if (!c.is_active) return <Chip>désactivé</Chip>;
  if (!c.last_check_status)
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <StatusDot tone="muted" /> Jamais testé
      </span>
    );
  const ok = c.last_check_status === "ok";
  return (
    <Tip content={`${c.last_check_message || ""}${c.last_check_at ? ` (${formatDate(c.last_check_at)})` : ""}`}>
      <span className={cn("flex cursor-default items-center gap-2 text-sm", ok ? "text-foreground" : "text-danger")}>
        <StatusDot tone={ok ? "success" : "danger"} />
        {ok ? "Joignable" : "Injoignable"}
        {ok && c.version && <span className="font-mono text-xs text-muted-foreground">{c.version}</span>}
      </span>
    </Tip>
  );
}

function ClustersPanel({
  clusters,
  canManage,
  onChanged,
  openNew,
  onNewHandled,
}: {
  clusters: K8sCluster[] | null;
  canManage: boolean;
  onChanged: () => void;
  openNew: boolean;
  onNewHandled: () => void;
}) {
  const navigate = useNavigate();
  const [edit, setEdit] = useState<K8sCluster | null | undefined>(undefined);
  const [remove, setRemove] = useState<K8sCluster | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    if (openNew) {
      setEdit(null);
      onNewHandled();
    }
  }, [openNew, onNewHandled]);

  const check = async (c: K8sCluster) => {
    setChecking(c.id);
    try {
      const r = await api.post<K8sCluster>(`/api/k8s/clusters/${c.id}/check`, {});
      if (r.last_check_status === "ok") toast.success(`${c.name} joignable : ${r.last_check_message || r.version || ""}`);
      else toast.error(`${c.name} injoignable : ${r.last_check_message || "erreur inconnue"}`);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setChecking(null);
    }
  };

  const doRemove = async (c: K8sCluster) => {
    setDeleting(true);
    try {
      await api.delete(`/api/k8s/clusters/${c.id}`);
      toast.success(`Cluster ${c.name} supprimé`);
      refreshK8sVisibility();
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
      setRemove(null);
    }
  };

  const open = (c: K8sCluster) => {
    if (c.is_active && canK8s(c, "view")) navigate(`/kubernetes/${c.id}`);
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Citadel se connecte à chaque cluster avec son propre compte de service. Les personnes n'y voient que les
            espaces de noms et les actions que leur accordent les règles d'accès.
          </p>
          <Button onClick={() => setEdit(null)}>
            <Plus /> Ajouter un cluster
          </Button>
        </div>
      )}

      {clusters !== null && clusters.length === 0 ? (
        <EmptyState
          icon={Container}
          title="Aucun cluster"
          action={
            canManage ? (
              <Button onClick={() => setEdit(null)}>
                <Plus /> Ajouter un cluster
              </Button>
            ) : undefined
          }
        >
          {canManage
            ? "Ajoutez un premier cluster Kubernetes pour commencer."
            : "Aucun cluster ne vous est accordé. Demandez un accès à un administrateur."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Cluster</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Vos actions</TableHead>
                <TableHead>Espaces de noms</TableHead>
                <TableHead>Étiquettes</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clusters === null ? (
                <TableSkeleton cols={6} rows={3} />
              ) : (
                clusters.map((c) => {
                  const openable = c.is_active && canK8s(c, "view");
                  return (
                    <TableRow
                      key={c.id}
                      className={cn("h-11", openable && "cursor-pointer")}
                      onClick={() => open(c)}
                    >
                      <TableCell className="py-2 pl-4">
                        <p className="font-medium">{c.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{c.api_url}</p>
                        {c.description && <p className="truncate text-xs text-muted-foreground">{c.description}</p>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <CheckState c={c} />
                      </TableCell>
                      <TableCell>
                        {c.actions && c.actions.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {c.actions.map((a) => (
                              <Chip key={a} title={K8S_ACTION_HELP[a]}>
                                {K8S_ACTION_LABELS[a] || a}
                              </Chip>
                            ))}
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">aucune</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(c.namespaces || []).map((n) => (
                            <Chip key={n}>
                              <span className="font-mono">{n === "*" ? "tous" : n}</span>
                            </Chip>
                          ))}
                          {(c.namespaces || []).length === 0 && <span className="text-sm text-muted-foreground">-</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <LabelChips tags={c.tags} />
                      </TableCell>
                      <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {openable && (
                            <Button size="sm" variant="outline" onClick={() => open(c)}>
                              Ouvrir
                            </Button>
                          )}
                          {canManage && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => check(c)}
                                disabled={checking === c.id}
                                title="Vérifier la version et la lecture des espaces de noms"
                              >
                                <PlugZap /> {checking === c.id ? "Test en cours" : "Tester"}
                              </Button>
                              <button className={iconBtn} onClick={() => setEdit(c)} aria-label={`Modifier ${c.name}`} title="Modifier">
                                <Pencil className="size-4" />
                              </button>
                              <button
                                className={iconBtnDanger}
                                onClick={() => setRemove(c)}
                                aria-label={`Supprimer ${c.name}`}
                                title="Supprimer"
                              >
                                <Trash2 className="size-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {edit !== undefined && (
        <ClusterForm
          cluster={edit}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            refreshK8sVisibility();
            onChanged();
          }}
        />
      )}
      {remove && (
        <ConfirmModal
          title="Supprimer le cluster"
          confirmLabel="Supprimer le cluster"
          danger
          loading={deleting}
          onConfirm={() => doRemove(remove)}
          onClose={() => setRemove(null)}
        >
          <p>
            Le cluster <strong>{remove.name}</strong> et son jeton seront retirés de Citadel. Les règles d'accès qui le
            visent n'y donneront plus rien. Le compte de service reste en place sur le cluster.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

function CodeLine({ children }: { children: ReactNode }) {
  return <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">{children}</pre>;
}

function ClusterForm({
  cluster,
  onClose,
  onSaved,
}: {
  cluster: K8sCluster | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!cluster;
  const [form, setForm] = useState<K8sClusterInput>({
    name: cluster?.name ?? "",
    description: cluster?.description ?? "",
    api_url: cluster?.api_url ?? "",
    ca_cert: "",
    skip_tls_verify: cluster?.skip_tls_verify ?? false,
    token: "",
    node_id: cluster?.node_id ?? null,
    zone_id: cluster?.zone_id ?? null,
    tags: cluster?.tags ?? {},
    is_active: cluster?.is_active ?? true,
  });
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [zones, setZones] = useState<ZoneData[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<K8sClusterInput>) => setForm((f) => ({ ...f, ...p }));

  useEffect(() => {
    api.get<NodeData[]>("/api/nodes").then(setNodes).catch(() => {});
    api.get<ZoneData[]>("/api/zones").then(setZones).catch(() => {});
  }, []);

  const save = async () => {
    if (!form.name.trim() || !form.api_url.trim()) {
      setError("Le nom et l'URL de l'API sont obligatoires.");
      return;
    }
    if (!editing && !form.token?.trim()) {
      setError("Collez le jeton du compte de service de Citadel.");
      return;
    }
    const body: K8sClusterInput = {
      ...form,
      name: form.name.trim(),
      description: form.description?.trim() || null,
      api_url: form.api_url.trim(),
      ca_cert: form.ca_cert?.trim() || null,
      token: form.token?.trim() || null,
    };
    setSaving(true);
    setError(null);
    try {
      if (cluster) await api.patch(`/api/k8s/clusters/${cluster.id}`, body);
      else await api.post("/api/k8s/clusters", body);
      toast.success(editing ? "Cluster enregistré" : `Cluster ${body.name} ajouté. Testez-le pour vérifier l'accès.`);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? `Modifier ${cluster?.name}` : "Ajouter un cluster"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={saving}>
            {editing ? "Enregistrer le cluster" : "Ajouter le cluster"}
          </SaveButton>
        </>
      }
    >
      <div className="space-y-2 rounded-md border px-3 py-3 text-sm">
        <p className="font-medium">Préparer le cluster</p>
        <p className="text-muted-foreground">
          Créez le compte de service de Citadel avec les droits minimaux, puis lisez son jeton et la CA du cluster :
        </p>
        <CodeLine>kubectl apply -f deploy/kubernetes/citadel-rbac.yaml</CodeLine>
        <CodeLine>{"kubectl -n citadel-system get secret citadel-token -o jsonpath='{.data.token}' | base64 -d"}</CodeLine>
        <CodeLine>{"kubectl -n citadel-system get secret citadel-token -o jsonpath='{.data.ca\\.crt}' | base64 -d"}</CodeLine>
      </div>

      <ErrorBox message={error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nom">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="prod-paris" />
        </Field>
        <Field label="URL de l'API">
          <Input
            value={form.api_url}
            onChange={(e) => set({ api_url: e.target.value })}
            placeholder="https://k8s.exemple.local:6443"
            className="font-mono"
          />
        </Field>
      </div>
      <Field label="Description">
        <Input value={form.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <Field
        label="Certificat de la CA (PEM)"
        hint={
          editing && cluster?.has_ca_cert
            ? "Une CA est enregistrée. Laissez vide pour la garder."
            : "Recommandé. Sans CA, le certificat de l'API est vérifié avec les CA du système."
        }
      >
        <Textarea
          value={form.ca_cert ?? ""}
          onChange={(e) => set({ ca_cert: e.target.value })}
          placeholder="-----BEGIN CERTIFICATE-----"
          className="min-h-24 font-mono text-xs"
          spellCheck={false}
        />
      </Field>
      <div className="space-y-2">
        <Toggle
          checked={form.skip_tls_verify}
          onChange={(v) => set({ skip_tls_verify: v })}
          label="Ignorer la vérification TLS"
        />
        {form.skip_tls_verify && (
          <p className="flex items-start gap-2 rounded-md border border-live/30 bg-live/10 px-3 py-2 text-xs text-live">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Le certificat de l'API ne sera pas vérifié : n'importe qui sur le chemin réseau peut intercepter le jeton.
            Réservé à un laboratoire.
          </p>
        )}
      </div>

      <Field
        label="Jeton du compte de service"
        hint={
          editing
            ? cluster?.has_token
              ? "Un jeton est enregistré (jamais réaffiché). Laissez vide pour le garder."
              : "Aucun jeton enregistré."
            : "Chiffré dans le coffre, jamais réaffiché."
        }
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={form.token ?? ""}
          onChange={(e) => set({ token: e.target.value })}
          placeholder={editing ? "inchangé" : "eyJhbGciOi..."}
          className="font-mono"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nœud" hint="Pour les règles de connexion et de commandes par nœud.">
          <Select value={form.node_id ?? NONE} onValueChange={(v) => set({ node_id: v === NONE ? null : v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Aucun</SelectItem>
              {nodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.path || n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Zone" hint="L'API est alors jointe par la passerelle SSH de la zone.">
          <Select value={form.zone_id ?? NONE} onValueChange={(v) => set({ zone_id: v === NONE ? null : v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Accès direct</SelectItem>
              {zones.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Étiquettes" hint="Reprises par les règles de connexion et de commandes, avec k8s_cluster et k8s_namespace.">
        <LabelEditor value={form.tags} onChange={(tags) => set({ tags })} />
      </Field>
      <Toggle checked={form.is_active} onChange={(v) => set({ is_active: v })} label="Cluster actif" />
    </Modal>
  );
}

// ── Access rules ──────────────────────────────────────────

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

function policyState(p: K8sPolicy): { label: string; tone: "green" | "amber" | "default" } {
  if (!p.is_active) return { label: "Désactivée", tone: "default" };
  const now = Date.now();
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return { label: "Planifiée", tone: "amber" };
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return { label: "Expirée", tone: "default" };
  return { label: "Active", tone: "green" };
}

function PoliciesPanel({ clusters }: { clusters: K8sCluster[] }) {
  const [policies, setPolicies] = useState<K8sPolicy[] | null>(null);
  const [users, setUsers] = useState<UserData[]>([]);
  const [groups, setGroups] = useState<UserGroupData[]>([]);
  const [groupsError, setGroupsError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<K8sPolicy | null | undefined>(undefined);
  const [remove, setRemove] = useState<K8sPolicy | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api
      .get<K8sPolicy[]>("/api/k8s/policies")
      .then((p) => {
        setPolicies(p);
        setError(null);
      })
      .catch((e) => {
        setPolicies((p) => p ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    load();
    api.get<UserData[]>("/api/users/").then(setUsers).catch(() => {});
    api
      .get<UserGroupData[]>("/api/user-groups")
      .then(setGroups)
      .catch(() => setGroupsError(true));
  }, [load]);

  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.display_name || u.email])), [users]);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const clusterName = useMemo(() => new Map(clusters.map((c) => [c.id, c.name])), [clusters]);

  const doRemove = async (p: K8sPolicy) => {
    setDeleting(true);
    try {
      await api.delete(`/api/k8s/policies/${p.id}`);
      toast.success(`Règle ${p.name} supprimée`);
      setPolicies((list) => (list || []).filter((x) => x.id !== p.id));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDeleting(false);
      setRemove(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Une règle donne à des personnes ou des groupes, sur des clusters, des espaces de noms et des actions. Le rôle
          plafonne : un lecteur n'obtient jamais que Consulter et Logs.
        </p>
        <Button onClick={() => setEdit(null)} disabled={clusters.length === 0}>
          <Plus /> Ajouter une règle
        </Button>
      </div>
      <ErrorBox message={error} />

      {policies !== null && policies.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Aucune règle d'accès Kubernetes"
          action={
            clusters.length > 0 ? (
              <Button onClick={() => setEdit(null)}>
                <Plus /> Ajouter une règle
              </Button>
            ) : undefined
          }
        >
          {clusters.length > 0
            ? "Seuls les administrateurs voient les clusters tant qu'aucune règle n'en accorde."
            : "Ajoutez d'abord un cluster, puis accordez-le avec une règle."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Règle</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Pour</TableHead>
                <TableHead>Clusters</TableHead>
                <TableHead>Espaces de noms</TableHead>
                <TableHead>Actions accordées</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies === null ? (
                <TableSkeleton cols={7} rows={3} />
              ) : (
                <AnimatePresence initial={false}>
                  {policies.map((p) => {
                    const st = policyState(p);
                    return (
                      <motion.tr
                        key={p.id}
                        layout
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="h-11 border-b transition-colors hover:bg-muted/50"
                      >
                        <TableCell className="py-2 pl-4">
                          <p className="font-medium">{p.name}</p>
                          {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                          {(p.valid_from || p.valid_until) && (
                            <p className="text-xs text-muted-foreground">
                              Du {p.valid_from ? formatDate(p.valid_from) : "..."} au{" "}
                              {p.valid_until ? formatDate(p.valid_until) : "..."}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip tone={st.tone}>{st.label}</Chip>
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-xs flex-wrap gap-1">
                            {p.user_ids.map((id) => (
                              <Chip key={id}>{userName.get(id) || id.slice(0, 8)}</Chip>
                            ))}
                            {p.group_ids.map((id) => (
                              <Chip key={id} title="Groupe">
                                {groupName.get(id) || `groupe ${id.slice(0, 8)}`}
                              </Chip>
                            ))}
                            {p.user_ids.length + p.group_ids.length === 0 && (
                              <span className="text-sm text-muted-foreground">personne</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {p.cluster_ids.map((id) => (
                              <Chip key={id}>{clusterName.get(id) || "supprimé"}</Chip>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {p.namespaces.map((n) => (
                              <Chip key={n}>
                                <span className="font-mono">{n === "*" ? "tous" : n}</span>
                              </Chip>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {p.actions.map((a) => (
                              <Chip key={a} title={K8S_ACTION_HELP[a]}>
                                {K8S_ACTION_LABELS[a] || a}
                              </Chip>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="pr-4">
                          <div className="flex items-center justify-end gap-1">
                            <button className={iconBtn} onClick={() => setEdit(p)} aria-label={`Modifier ${p.name}`} title="Modifier">
                              <Pencil className="size-4" />
                            </button>
                            <button
                              className={iconBtnDanger}
                              onClick={() => setRemove(p)}
                              aria-label={`Supprimer ${p.name}`}
                              title="Supprimer"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </div>
                        </TableCell>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {edit !== undefined && (
        <PolicyForm
          policy={edit}
          clusters={clusters}
          users={users}
          groups={groups}
          groupsError={groupsError}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            load();
          }}
        />
      )}
      {remove && (
        <ConfirmModal
          title="Supprimer la règle"
          confirmLabel="Supprimer la règle"
          danger
          loading={deleting}
          onConfirm={() => doRemove(remove)}
          onClose={() => setRemove(null)}
        >
          <p>
            Les personnes visées par <strong>{remove.name}</strong> perdent tout de suite les accès qu'elle accordait.
            Les shells déjà ouverts ne sont pas coupés.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

const NS_PATTERN = /^[a-z0-9*?][-a-z0-9*?]{0,62}$/;

function PolicyForm({
  policy,
  clusters,
  users,
  groups,
  groupsError,
  onClose,
  onSaved,
}: {
  policy: K8sPolicy | null;
  clusters: K8sCluster[];
  users: UserData[];
  groups: UserGroupData[];
  groupsError: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: policy?.name ?? "",
    description: policy?.description ?? "",
    is_active: policy?.is_active ?? true,
    valid_from: toLocalInput(policy?.valid_from ?? null),
    valid_until: toLocalInput(policy?.valid_until ?? null),
    user_ids: policy?.user_ids ?? [],
    group_ids: policy?.group_ids ?? [],
    cluster_ids: policy?.cluster_ids ?? (clusters.length === 1 ? [clusters[0].id] : []),
    namespaces: policy?.namespaces ?? ["*"],
    actions: policy?.actions ?? (["view", "logs"] as K8sAction[]),
  });
  const [nsInput, setNsInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type F = typeof form;
  const set = (p: Partial<F>) => setForm((f) => ({ ...f, ...p }));

  const addNs = () => {
    const v = nsInput.trim().toLowerCase();
    if (!v) return;
    if (v !== "*" && !NS_PATTERN.test(v)) {
      setError(`« ${v} » n'est pas un nom ou un motif d'espace de noms valide (minuscules, chiffres, tirets, * et ?).`);
      return;
    }
    setError(null);
    if (!form.namespaces.includes(v)) set({ namespaces: [...form.namespaces, v] });
    setNsInput("");
  };

  const toggleAction = (a: K8sAction) =>
    set({ actions: form.actions.includes(a) ? form.actions.filter((x) => x !== a) : [...form.actions, a] });

  const save = async () => {
    if (!form.name.trim()) return setError("Donnez un nom à la règle.");
    if (form.cluster_ids.length === 0) return setError("Choisissez au moins un cluster.");
    if (form.namespaces.length === 0) return setError("Indiquez au moins un espace de noms (ou * pour tous).");
    if (form.actions.length === 0) return setError("Choisissez au moins une action.");
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      is_active: form.is_active,
      valid_from: fromLocalInput(form.valid_from),
      valid_until: fromLocalInput(form.valid_until),
      user_ids: form.user_ids,
      group_ids: form.group_ids,
      cluster_ids: form.cluster_ids,
      namespaces: form.namespaces,
      actions: form.actions,
    };
    setSaving(true);
    setError(null);
    try {
      if (policy) await api.put(`/api/k8s/policies/${policy.id}`, body);
      else await api.post("/api/k8s/policies", body);
      toast.success("Règle enregistrée");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={policy ? `Modifier ${policy.name}` : "Ajouter une règle d'accès Kubernetes"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={saving}>
            Enregistrer la règle
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nom">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="équipe web en lecture" />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Utilisateurs">
          <MultiSelect
            options={users.map((u) => ({ id: u.id, label: u.display_name || u.email, sub: u.email }))}
            selected={form.user_ids}
            onChange={(user_ids) => set({ user_ids })}
            placeholder="Rechercher une personne"
            emptyText="Aucun utilisateur"
          />
        </Field>
        <Field
          label="Groupes"
          hint={groupsError ? "Liste des groupes non disponible : il faut aussi la permission « règles d'accès »." : undefined}
        >
          <MultiSelect
            options={groups.map((g) => ({ id: g.id, label: g.name, sub: `${g.users.length} membre(s)` }))}
            selected={form.group_ids}
            onChange={(group_ids) => set({ group_ids })}
            placeholder="Rechercher un groupe"
            emptyText="Aucun groupe"
          />
        </Field>
      </div>

      <Field label="Clusters" hint="Au moins un.">
        <MultiSelect
          options={clusters.map((c) => ({ id: c.id, label: c.name, sub: c.api_url }))}
          selected={form.cluster_ids}
          onChange={(cluster_ids) => set({ cluster_ids })}
          placeholder="Rechercher un cluster"
          emptyText="Aucun cluster"
        />
      </Field>

      <Field label="Espaces de noms" hint="Noms exacts ou motifs (team-*, app-?). * accorde tous les espaces de noms.">
        <div className="space-y-2">
          <div className="flex min-h-6 flex-wrap gap-1">
            {form.namespaces.map((n) => (
              <Chip key={n} onRemove={() => set({ namespaces: form.namespaces.filter((x) => x !== n) })}>
                <span className="font-mono">{n === "*" ? "* (tous)" : n}</span>
              </Chip>
            ))}
            {form.namespaces.length === 0 && <span className="text-xs text-muted-foreground">Aucun espace de noms</span>}
          </div>
          <div className="flex gap-2">
            <Input
              value={nsInput}
              onChange={(e) => setNsInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addNs();
                }
              }}
              placeholder="production, team-*, *"
              className="font-mono"
            />
            <Button type="button" variant="outline" size="icon" onClick={addNs} disabled={!nsInput.trim()} title="Ajouter">
              <Plus />
            </Button>
          </div>
        </div>
      </Field>

      <Field label="Actions" hint="Logs, Shell et Gérer donnent aussi Consulter. Le rôle plafonne : un lecteur n'a jamais que Consulter et Logs.">
        <div className="grid gap-2 sm:grid-cols-2">
          {K8S_ACTIONS.map((a) => (
            <label key={a} className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
              <Checkbox checked={form.actions.includes(a)} onCheckedChange={() => toggleAction(a)} className="mt-0.5" />
              <span>
                <span className="font-medium">{K8S_ACTION_LABELS[a]}</span>
                <span className="block text-xs text-muted-foreground">{K8S_ACTION_HELP[a]}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Valide à partir du">
          <Input type="datetime-local" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} />
        </Field>
        <Field label="Valide jusqu'au">
          <Input type="datetime-local" value={form.valid_until} onChange={(e) => set({ valid_until: e.target.value })} />
        </Field>
      </div>
      <Toggle checked={form.is_active} onChange={(v) => set({ is_active: v })} label="Règle active" />
    </Modal>
  );
}
