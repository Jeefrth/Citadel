// Kubernetes cluster (lot 8): pods, workloads and events of one namespace, logs,
// shell (opened as a tab of the Terminal page) and actions (permission "manage").
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { reauthenticate } from "@/services/reauth";
import { toast } from "sonner";
import {
  Activity,
  Boxes,
  ChevronDown,
  Container,
  Copy,
  Download,
  FileText,
  Layers,
  RefreshCw,
  RotateCcw,
  Scaling,
  Terminal as TerminalIcon,
} from "lucide-react";
import { api } from "@/services/api";
import { errorMessage } from "@/services/types";
import {
  K8S_KIND_LABELS,
  canK8s,
  formatAge,
  type K8sCluster,
  type K8sEvent,
  type K8sNamespace,
  type K8sPod,
  type K8sWorkload,
} from "@/services/k8s";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  SaveButton,
  Tabs,
  formatDate,
  type ChipTone,
} from "@/components/kit";
import { TableSkeleton, Tip } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Tab = "pods" | "workloads" | "events";
const TABS: Tab[] = ["pods", "workloads", "events"];

const BAD_REASONS = /BackOff|Err|Error|OOMKilled|Invalid|Failed|Evicted/i;

/** Pod state: the reason when a container is waiting, otherwise the phase. Colour = state only. */
function podState(p: K8sPod): { label: string; tone: ChipTone } {
  if (p.reason) return { label: p.reason, tone: BAD_REASONS.test(p.reason) ? "red" : "amber" };
  const [ready, total] = p.ready.split("/").map((n) => parseInt(n, 10));
  switch (p.phase) {
    case "Running":
      return { label: "Running", tone: ready === total ? "green" : "amber" };
    case "Pending":
      return { label: "Pending", tone: "amber" };
    case "Failed":
      return { label: "Failed", tone: "red" };
    case "Succeeded":
      return { label: "Succeeded", tone: "default" };
    default:
      return { label: p.phase || "Inconnu", tone: "default" };
  }
}

function workloadTone(w: K8sWorkload): ChipTone {
  if (w.desired === 0) return "default";
  if (w.ready >= w.desired) return "green";
  return w.ready === 0 ? "red" : "amber";
}

export default function KubernetesCluster() {
  const { clusterId = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [cluster, setCluster] = useState<K8sCluster | null | undefined>(undefined);
  const [namespaces, setNamespaces] = useState<K8sNamespace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const tab: Tab = TABS.find((t) => t === params.get("tab")) ?? "pods";
  const ns = params.get("ns") || "";

  const setQuery = useCallback(
    (p: { ns?: string; tab?: Tab }) => {
      const next = new URLSearchParams(params);
      if (p.ns !== undefined) next.set("ns", p.ns);
      if (p.tab !== undefined) {
        if (p.tab === "pods") next.delete("tab");
        else next.set("tab", p.tab);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // Cluster (with the user's actions) then the namespaces the user is granted
  useEffect(() => {
    let alive = true;
    api
      .get<K8sCluster[]>("/api/k8s/clusters")
      .then((list) => alive && setCluster(list.find((c) => c.id === clusterId) ?? null))
      .catch((e) => {
        if (!alive) return;
        setCluster(null);
        setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [clusterId]);

  useEffect(() => {
    if (!cluster) return;
    let alive = true;
    api
      .get<K8sNamespace[]>(`/api/k8s/clusters/${clusterId}/namespaces`)
      .then((list) => {
        if (!alive) return;
        setNamespaces(list);
        setError(null);
        if (!list.some((n) => n.name === ns) && list.length > 0) {
          setQuery({ ns: (list.find((n) => n.name === "default") ?? list[0]).name });
        }
      })
      .catch((e) => {
        if (!alive) return;
        setNamespaces([]);
        setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
    // ns / setQuery deliberately left out: the namespace list does not depend on the selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, clusterId, refresh]);

  if (cluster === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (cluster === null) {
    return (
      <EmptyState
        icon={Container}
        title="Cluster introuvable"
        action={
          <Button variant="outline" onClick={() => navigate("/kubernetes")}>
            Voir les clusters
          </Button>
        }
      >
        {error || "Ce cluster n'existe pas, est désactivé, ou ne vous est pas accordé."}
      </EmptyState>
    );
  }

  const ready = !!ns && !!namespaces?.some((n) => n.name === ns);
  // Buttons follow the actions granted in the selected namespace, not on the whole cluster
  const current = namespaces?.find((n) => n.name === ns);
  const nsCluster = { ...cluster, actions: current?.actions ?? cluster.actions };

  return (
    <div>
      <PageHeader
        title={cluster.name}
        description={
          <>
            <span className="font-mono">{cluster.api_url}</span>
            {cluster.version && <span className="font-mono"> · {cluster.version}</span>}
            {cluster.description && <> · {cluster.description}</>}
          </>
        }
        actions={
          <>
            <Select value={ready ? ns : undefined} onValueChange={(v) => setQuery({ ns: v })} disabled={!namespaces?.length}>
              <SelectTrigger className="h-9 w-56 font-mono">
                <SelectValue placeholder={namespaces === null ? "Chargement..." : "Aucun espace de noms"} />
              </SelectTrigger>
              <SelectContent>
                {(namespaces || []).map((n) => (
                  <SelectItem key={n.name} value={n.name} className="font-mono">
                    {n.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => setRefresh((r) => r + 1)}>
              <RefreshCw /> Actualiser
            </Button>
          </>
        }
      />

      <Tabs
        tabs={[
          { id: "pods" as Tab, label: "Pods", icon: Boxes },
          { id: "workloads" as Tab, label: "Charges", icon: Layers },
          { id: "events" as Tab, label: "Événements", icon: Activity },
        ]}
        active={tab}
        onChange={(t) => setQuery({ tab: t })}
      />
      <ErrorBox message={error} />

      {namespaces !== null && namespaces.length === 0 && !error ? (
        <EmptyState icon={Container} title="Aucun espace de noms accordé">
          Vos règles d'accès ne couvrent aucun espace de noms existant sur ce cluster.
        </EmptyState>
      ) : !ready ? (
        <Skeleton className="h-64 w-full" />
      ) : tab === "pods" ? (
        <PodsPanel cluster={nsCluster} ns={ns} refresh={refresh} />
      ) : tab === "workloads" ? (
        <WorkloadsPanel cluster={nsCluster} ns={ns} refresh={refresh} />
      ) : (
        <EventsPanel cluster={nsCluster} ns={ns} refresh={refresh} />
      )}
    </div>
  );
}

/** GET a namespace listing, reloaded on namespace change and on manual refresh. */
function useNsList<T>(path: string, refresh: number) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .get<T[]>(path)
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setItems([]);
        setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [path, refresh, tick]);
  return { items, error, reload: () => setTick((t) => t + 1) };
}

function base(cluster: K8sCluster, ns: string) {
  return `/api/k8s/clusters/${cluster.id}/namespaces/${encodeURIComponent(ns)}`;
}

// ── Pods ──────────────────────────────────────────────────

function PodsPanel({ cluster, ns, refresh }: { cluster: K8sCluster; ns: string; refresh: number }) {
  const navigate = useNavigate();
  const { items: pods, error, reload } = useNsList<K8sPod>(`${base(cluster, ns)}/pods`, refresh);
  const [logsPod, setLogsPod] = useState<K8sPod | null>(null);
  const [restartPod, setRestartPod] = useState<K8sPod | null>(null);
  const [busy, setBusy] = useState(false);
  const canLogs = canK8s(cluster, "logs");
  const canExec = canK8s(cluster, "exec");
  const canManage = canK8s(cluster, "manage");

  // Same rule as an SSH terminal: sign in again at the provider right on the click,
  // so the popup isn't blocked by the browser
  const openShell = async (p: K8sPod, container: string) => {
    try {
      await reauthenticate();
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    const q = new URLSearchParams({ k8s: cluster.id, name: cluster.name, ns, pod: p.name, container });
    navigate(`/terminal?${q.toString()}`);
  };

  const restart = async (p: K8sPod) => {
    setBusy(true);
    try {
      await api.post(`${base(cluster, ns)}/pods/${encodeURIComponent(p.name)}/delete`, {});
      toast.success(p.owner ? `Pod ${p.name} redémarré` : `Pod ${p.name} supprimé`);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      setRestartPod(null);
    }
  };

  if (pods !== null && pods.length === 0 && !error) {
    return <EmptyState icon={Boxes} title="Aucun pod">Cet espace de noms ne contient aucun pod.</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <ErrorBox message={error} />
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Pod</TableHead>
              <TableHead>État</TableHead>
              <TableHead>Prêts</TableHead>
              <TableHead>Redémarrages</TableHead>
              <TableHead>Nœud</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Âge</TableHead>
              <TableHead className="pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pods === null ? (
              <TableSkeleton cols={8} rows={4} />
            ) : (
              pods.map((p) => {
                const st = podState(p);
                return (
                  <TableRow key={p.name} className="h-11">
                    <TableCell className="py-2 pl-4">
                      <p className="font-mono text-sm">{p.name}</p>
                      {p.owner && (
                        <p className="text-xs text-muted-foreground">
                          {p.owner.kind} <span className="font-mono">{p.owner.name}</span>
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip tone={st.tone}>{st.label}</Chip>
                    </TableCell>
                    <TableCell className="tabular font-mono text-xs">{p.ready}</TableCell>
                    <TableCell className={cn("tabular", p.restarts > 0 ? "text-live" : "text-muted-foreground")}>
                      {p.restarts}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{p.node || "-"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{p.ip || "-"}</TableCell>
                    <TableCell className="tabular whitespace-nowrap text-muted-foreground">{formatAge(p.age_seconds)}</TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-1">
                        {canLogs && (
                          <Button size="sm" variant="ghost" onClick={() => setLogsPod(p)}>
                            <FileText /> Logs
                          </Button>
                        )}
                        {canExec &&
                          p.phase === "Running" &&
                          (p.containers.length > 1 ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="ghost">
                                  <TerminalIcon /> Shell <ChevronDown className="size-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Conteneur</DropdownMenuLabel>
                                {p.containers.map((c) => (
                                  <DropdownMenuItem key={c} onSelect={() => openShell(p, c)} className="font-mono">
                                    {c}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => openShell(p, p.containers[0] || "")}>
                              <TerminalIcon /> Shell
                            </Button>
                          ))}
                        {canManage && (
                          <Button size="sm" variant="ghost" onClick={() => setRestartPod(p)}>
                            <RotateCcw /> Redémarrer
                          </Button>
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

      {logsPod && <LogsDialog cluster={cluster} ns={ns} pod={logsPod} onClose={() => setLogsPod(null)} />}
      {restartPod && (
        <ConfirmModal
          title={restartPod.owner ? "Redémarrer le pod" : "Supprimer le pod"}
          confirmLabel={restartPod.owner ? "Redémarrer le pod" : "Supprimer le pod"}
          danger
          loading={busy}
          onConfirm={() => restart(restartPod)}
          onClose={() => setRestartPod(null)}
        >
          <p>
            Le pod <strong className="font-mono">{restartPod.name}</strong> sera supprimé.
          </p>
          {restartPod.owner ? (
            <p>
              Son contrôleur ({restartPod.owner.kind} <strong className="font-mono">{restartPod.owner.name}</strong>) le
              recréera aussitôt. Les connexions en cours sur ce pod seront coupées.
            </p>
          ) : (
            <p>
              <strong>Il n'a pas de contrôleur : il ne sera pas recréé.</strong> Il faudra le redéployer à la main.
            </p>
          )}
          <p>L'action est tracée dans le journal d'audit.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

// ── Logs ──────────────────────────────────────────────────

const TAILS = [100, 500, 2000];

function LogsDialog({ cluster, ns, pod, onClose }: { cluster: K8sCluster; ns: string; pod: K8sPod; onClose: () => void }) {
  const [container, setContainer] = useState(pod.containers[0] || "");
  const [tail, setTail] = useState(500);
  const [previous, setPrevious] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ tail: String(tail), previous: String(previous) });
    if (container) q.set("container", container);
    try {
      const r = await api.get<{ logs: string }>(`${base(cluster, ns)}/pods/${encodeURIComponent(pod.name)}/logs?${q}`);
      setLogs(r.logs);
    } catch (e) {
      setLogs(null);
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [cluster, ns, pod.name, container, tail, previous]);

  useEffect(() => {
    load();
  }, [load]);

  // Latest lines in view after each load (no animation)
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [logs]);

  const label = `${pod.name}${container ? `/${container}` : ""}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logs || "");
      toast.success("Logs copiés");
    } catch {
      toast.error("Copie impossible : le navigateur refuse l'accès au presse-papiers.");
    }
  };

  const download = () => {
    const blob = new Blob([logs || ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${cluster.name}_${ns}_${pod.name}${container ? `_${container}` : ""}${previous ? "_previous" : ""}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[85vh] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 border-b py-3 pl-4 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-sm font-medium">{label}</DialogTitle>
            <DialogDescription className="truncate text-xs">
              Logs du conteneur, {cluster.name} / {ns}. Les données sensibles sont masquées et chaque lecture est tracée.
            </DialogDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
          {pod.containers.length > 1 && (
            <Select value={container} onValueChange={setContainer}>
              <SelectTrigger className="h-8 w-48 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pod.containers.map((c) => (
                  <SelectItem key={c} value={c} className="font-mono">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={String(tail)} onValueChange={(v) => setTail(parseInt(v, 10))}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TAILS.map((t) => (
                <SelectItem key={t} value={String(t)}>
                  {t} dernières lignes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={previous} onCheckedChange={(v) => setPrevious(v === true)} />
            Instance précédente
          </label>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw /> Recharger
            </Button>
            <Button size="sm" variant="ghost" onClick={copy} disabled={!logs}>
              <Copy /> Copier
            </Button>
            <Button size="sm" variant="ghost" onClick={download} disabled={!logs}>
              <Download /> Télécharger
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <ErrorBox message={error} />
          {logs === null && loading ? (
            <Skeleton className="h-full w-full" />
          ) : (
            <pre
              ref={preRef}
              className={cn(
                "h-full overflow-auto whitespace-pre rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed",
                loading && "opacity-50",
              )}
            >
              {logs || (error ? "" : "Aucune ligne.")}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Workloads ─────────────────────────────────────────────

function WorkloadsPanel({ cluster, ns, refresh }: { cluster: K8sCluster; ns: string; refresh: number }) {
  const { items, error, reload } = useNsList<K8sWorkload>(`${base(cluster, ns)}/workloads`, refresh);
  const canManage = canK8s(cluster, "manage");
  const [scaling, setScaling] = useState<K8sWorkload | null>(null);
  const [restarting, setRestarting] = useState<K8sWorkload | null>(null);
  const [busy, setBusy] = useState(false);

  const restart = async (w: K8sWorkload) => {
    setBusy(true);
    try {
      await api.post(`${base(cluster, ns)}/workloads/${w.kind}/${encodeURIComponent(w.name)}/restart`, {});
      toast.success(`${K8S_KIND_LABELS[w.kind]} ${w.name} redémarré`);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      setRestarting(null);
    }
  };

  if (items !== null && items.length === 0 && !error) {
    return (
      <EmptyState icon={Layers} title="Aucune charge">
        Aucun deployment, statefulset ni daemonset dans cet espace de noms.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox message={error} />
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Charge</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Prêts</TableHead>
              <TableHead>Images</TableHead>
              <TableHead>Âge</TableHead>
              <TableHead className="pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items === null ? (
              <TableSkeleton cols={6} rows={4} />
            ) : (
              items.map((w) => (
                <TableRow key={`${w.kind}/${w.name}`} className="h-11">
                  <TableCell className="py-2 pl-4 font-mono text-sm">{w.name}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{K8S_KIND_LABELS[w.kind] || w.kind}</TableCell>
                  <TableCell>
                    <Chip tone={workloadTone(w)}>
                      <span className="tabular">
                        {w.ready}/{w.desired}
                      </span>
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-md space-y-0.5">
                      {w.images.map((img, i) => (
                        <p key={`${img}-${i}`} className="truncate font-mono text-xs text-muted-foreground" title={img}>
                          {img}
                        </p>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">{formatAge(w.age_seconds)}</TableCell>
                  <TableCell className="pr-4">
                    {canManage && (
                      <div className="flex items-center justify-end gap-1">
                        {w.kind !== "daemonsets" && (
                          <Button size="sm" variant="ghost" onClick={() => setScaling(w)}>
                            <Scaling /> Mettre à l'échelle
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setRestarting(w)}>
                          <RotateCcw /> Redémarrer
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {scaling && (
        <ScaleDialog
          cluster={cluster}
          ns={ns}
          workload={scaling}
          onClose={() => setScaling(null)}
          onDone={() => {
            setScaling(null);
            reload();
          }}
        />
      )}
      {restarting && (
        <ConfirmModal
          title="Redémarrer la charge"
          confirmLabel="Redémarrer"
          loading={busy}
          onConfirm={() => restart(restarting)}
          onClose={() => setRestarting(null)}
        >
          <p>
            Les pods de {K8S_KIND_LABELS[restarting.kind]} <strong className="font-mono">{restarting.name}</strong> seront
            remplacés progressivement, comme avec <span className="font-mono">kubectl rollout restart</span>.
          </p>
          <p>L'action est tracée dans le journal d'audit.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

function ScaleDialog({
  cluster,
  ns,
  workload,
  onClose,
  onDone,
}: {
  cluster: K8sCluster;
  ns: string;
  workload: K8sWorkload;
  onClose: () => void;
  onDone: () => void;
}) {
  const [replicas, setReplicas] = useState(String(workload.desired));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = parseInt(replicas, 10);
  const valid = /^\d+$/.test(replicas) && n >= 0 && n <= 500;

  const save = async () => {
    if (!valid) return setError("Indiquez un nombre de réplicas entre 0 et 500.");
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base(cluster, ns)}/workloads/${workload.kind}/${encodeURIComponent(workload.name)}/scale`, {
        replicas: n,
      });
      toast.success(`${workload.name} mis à l'échelle : ${n} réplica(s)`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Mettre à l'échelle"
      description={
        <>
          {K8S_KIND_LABELS[workload.kind]} <span className="font-mono">{workload.name}</span>, actuellement {workload.desired}{" "}
          réplica(s) demandé(s).
        </>
      }
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={saving} disabled={!valid || n === workload.desired}>
            Mettre à l'échelle
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Réplicas" hint={n === 0 ? "0 arrête tous les pods de la charge." : undefined}>
        <Input
          type="number"
          min={0}
          max={500}
          value={replicas}
          onChange={(e) => setReplicas(e.target.value)}
          className="tabular w-32"
          autoFocus
        />
      </Field>
    </Modal>
  );
}

// ── Events ────────────────────────────────────────────────

function EventsPanel({ cluster, ns, refresh }: { cluster: K8sCluster; ns: string; refresh: number }) {
  const { items, error } = useNsList<K8sEvent>(`${base(cluster, ns)}/events`, refresh);
  const sorted = items;

  if (sorted !== null && sorted.length === 0 && !error) {
    return (
      <EmptyState icon={Activity} title="Aucun événement récent">
        Kubernetes ne garde les événements que quelques heures.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox message={error} />
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Vu</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Motif</TableHead>
              <TableHead>Objet</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="pr-4 text-right">Nombre</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted === null ? (
              <TableSkeleton cols={6} rows={5} />
            ) : (
              sorted.map((e, i) => (
                <TableRow key={`${e.object}-${e.reason}-${e.last_seen}-${i}`} className="h-11">
                  <TableCell className="tabular whitespace-nowrap py-2 pl-4 text-muted-foreground">{formatDate(e.last_seen)}</TableCell>
                  <TableCell>
                    <Chip tone={e.type === "Warning" ? "orange" : "default"}>{e.type || "-"}</Chip>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{e.reason || "-"}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{e.object}</TableCell>
                  <TableCell className="py-2">
                    <Tip content={e.message && e.message.length > 120 ? e.message : undefined} className="max-w-xl">
                      <p className="max-w-xl truncate text-sm">{e.message || "-"}</p>
                    </Tip>
                  </TableCell>
                  <TableCell className="tabular pr-4 text-right text-muted-foreground">{e.count ?? "-"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        200 événements au plus, du plus récent au plus ancien.
      </p>
    </div>
  );
}
