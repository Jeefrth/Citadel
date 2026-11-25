import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import type { ApprovalData, ApprovalKind, CountResponse, LiveSession } from "@/services/types";
import { Chip, EmptyState, PageHeader, formatDate } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  RefreshCw,
  Server,
} from "lucide-react";

interface MetricsData {
  cpu_percent: number;
  cpu_count: number;
  load_average: string;
  memory_total_mb: number;
  memory_used_mb: number;
  memory_percent: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_percent: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  uptime_seconds: number;
  process_count: number;
}

interface ServerSummary {
  id: string;
  name: string;
  hostname: string;
  ip_address: string;
  os_type: string;
  status: string;
  last_seen: string | null;
  metrics: MetricsData | null;
  alerts: string[];
}

interface DashboardData {
  total_servers: number;
  online_servers: number;
  offline_servers: number;
  unknown_servers: number;
  total_alerts: number;
  avg_cpu: number;
  avg_memory: number;
  avg_disk: number;
  servers: ServerSummary[];
}

const POLL_MS = 15_000;

const KIND_LABEL: Record<ApprovalKind, string> = {
  access: "Demande d'accès",
  connect: "Connexion",
  command: "Commande",
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d} j ${h} h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} h ${m} min`;
}

/** "12 min", "2 h 05" from a unix timestamp (seconds). */
function since(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")}`;
}

/** Usage level carried by colour: calm under 75 %, amber above, red above 90 %. */
function levelTone(v: number): string {
  return v > 90 ? "bg-danger" : v > 75 ? "bg-live" : "bg-muted-foreground/50";
}

function MiniBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", levelTone(value))} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span className={cn("tabular w-9 text-right text-xs", value > 75 ? "text-foreground" : "text-muted-foreground")}>
        {value.toFixed(0)} %
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls = status === "online" ? "bg-success" : status === "offline" ? "bg-danger" : "bg-muted-foreground/40";
  const label = status === "online" ? "En ligne" : status === "offline" ? "Hors ligne" : "État inconnu";
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", cls)} title={label} aria-label={label} role="img" />;
}

/** Amber pulse, reserved for the live state. */
function LivePulse() {
  return (
    <span className="relative flex size-2.5 items-center justify-center">
      <motion.span
        className="absolute inset-0 rounded-full bg-live"
        initial={{ scale: 1, opacity: 0.6 }}
        animate={{ scale: 2.6, opacity: 0 }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
      />
      <span className="relative size-2 rounded-full bg-live" />
    </span>
  );
}

/** One item of the status strip: a count that links to where you act. */
function StripItem({
  to,
  count,
  label,
  tone,
  lead,
}: {
  to: string;
  count: number | string;
  label: string;
  tone?: "live" | "danger" | "success";
  lead?: ReactNode;
}) {
  const color = tone === "live" ? "text-live" : tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "";
  return (
    <Link
      to={to}
      className={cn(
        "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/50",
        tone === "live" && "bg-live/10 hover:bg-live/15",
      )}
    >
      {lead}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={String(count)}
          initial={{ y: 6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -6, opacity: 0 }}
          transition={{ duration: 0.18 }}
          className={cn("tabular font-semibold", color)}
        >
          {count}
        </motion.span>
      </AnimatePresence>
      <span className="text-muted-foreground group-hover:text-foreground">{label}</span>
    </Link>
  );
}

function Section({
  title,
  description,
  link,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  link?: { to: string; label: string };
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {link && (
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <Link to={link.to}>
              {link.label}
            </Link>
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

/** Quiet single line when a section has nothing to act on. */
function AllClear({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
      <CheckCircle2 className="size-4 text-success" />
      {children}
    </p>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const isAdmin = useCurrentUser().can("audit");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState<LiveSession[] | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [todo, setTodo] = useState<ApprovalData[] | null>(null);

  const fetchDashboard = useCallback((showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    api
      .get<DashboardData>("/api/dashboard/summary")
      .then(setData)
      .catch(() => {
        // In dev mode without backend, show empty state
        setData(null);
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  // What needs attention now: approvals for me, live sessions (admin only)
  const fetchNow = useCallback(() => {
    api
      .get<CountResponse>("/api/approvals/pending-count")
      .then((r) => setPendingCount(r.count))
      .catch(() => setPendingCount(null));
    api
      .get<ApprovalData[]>("/api/approvals?scope=todo")
      .then((r) => setTodo(r.filter((a) => a.status === "pending")))
      .catch(() => setTodo(null));
    if (isAdmin) {
      api
        .get<LiveSession[]>("/api/live-sessions")
        .then(setLive)
        .catch(() => setLive(null));
    }
  }, [isAdmin]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    fetchNow();
    const t = window.setInterval(fetchNow, POLL_MS);
    return () => window.clearInterval(t);
  }, [fetchNow]);

  const refresh = () => {
    fetchDashboard(true);
    fetchNow();
  };

  const header = (
    <PageHeader
      title="Tableau de bord"
      description="Ce qui demande votre attention maintenant : sessions en cours, validations et serveurs en alerte."
      actions={
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          Rafraîchir
        </Button>
      }
    />
  );

  if (loading) {
    return (
      <div>
        {header}
        <div className="space-y-6">
          <Skeleton className="h-11 w-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-28 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const d = data;
  const pending = pendingCount ?? todo?.length ?? 0;
  const watch = d ? d.servers.filter((s) => s.alerts.length > 0 || s.status === "offline") : [];

  return (
    <div className="space-y-8">
      <div>
        {header}

        {/* Status strip */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1">
          {isAdmin && live !== null && (
            <StripItem
              to="/live"
              count={live.length}
              label={live.length > 1 ? "sessions en direct" : "session en direct"}
              tone={live.length > 0 ? "live" : undefined}
              lead={live.length > 0 ? <LivePulse /> : <Eye className="size-3.5 text-muted-foreground" />}
            />
          )}
          <StripItem
            to="/approvals"
            count={pending}
            label={pending > 1 ? "validations à traiter" : "validation à traiter"}
            tone={pending > 0 ? "live" : undefined}
            lead={<ClipboardCheck className={cn("size-3.5", pending > 0 ? "text-live" : "text-muted-foreground")} />}
          />
          {d && (
            <>
              <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
              <StripItem
                to="/servers"
                count={d.online_servers}
                label="en ligne"
                lead={<span className="size-2 rounded-full bg-success" />}
              />
              <StripItem
                to="/servers"
                count={d.offline_servers}
                label="hors ligne"
                tone={d.offline_servers > 0 ? "danger" : undefined}
                lead={<span className="size-2 rounded-full bg-danger" />}
              />
              {d.unknown_servers > 0 && (
                <StripItem
                  to="/servers"
                  count={d.unknown_servers}
                  label="inconnus"
                  lead={<span className="size-2 rounded-full bg-muted-foreground/40" />}
                />
              )}
              <StripItem
                to="/servers"
                count={d.total_alerts}
                label={d.total_alerts > 1 ? "alertes" : "alerte"}
                tone={d.total_alerts > 0 ? "live" : undefined}
                lead={
                  <AlertTriangle
                    className={cn("size-3.5", d.total_alerts > 0 ? "text-live" : "text-muted-foreground")}
                  />
                }
              />
            </>
          )}
        </div>
      </div>

      {/* Live sessions (admin) */}
      {isAdmin && live !== null && (
        <Section
          title={
            <>
              Sessions en direct
              {live.length > 0 && <Chip tone="amber">{live.length}</Chip>}
            </>
          }
          link={{ to: "/live", label: "Observer" }}
        >
          {live.length === 0 ? (
            <AllClear>Aucune session ouverte en ce moment.</AllClear>
          ) : (
            <div className="overflow-hidden rounded-lg border border-live/30 bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Utilisateur</TableHead>
                    <TableHead>Serveur</TableHead>
                    <TableHead>Compte</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Depuis</TableHead>
                    <TableHead className="pr-4 text-right">Observateurs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {live.map((s) => (
                      <motion.tr
                        key={s.session_id}
                        layout="position"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        onClick={() => navigate("/live")}
                        className="h-10 cursor-pointer border-b transition-colors hover:bg-muted/50"
                      >
                        <TableCell className="pl-4">
                          <span className="flex items-center gap-2">
                            <span className="size-1.5 rounded-full bg-live" />
                            {s.user}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="mr-2 rounded border px-1 font-mono text-2xs text-muted-foreground">
                            {s.protocol === "rdp" ? "RDP" : "SSH"}
                          </span>
                          {s.server}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{s.account || "-"}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{s.client_ip || "-"}</TableCell>
                        <TableCell className="tabular text-xs text-muted-foreground">{since(s.started_at)}</TableCell>
                        <TableCell className="tabular pr-4 text-right text-xs text-muted-foreground">
                          {s.watchers.length}
                        </TableCell>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                </TableBody>
              </Table>
            </div>
          )}
        </Section>
      )}

      {/* Approvals for me */}
      {todo !== null && (
        <Section
          title={
            <>
              À valider
              {pending > 0 && <Chip tone="amber">{pending}</Chip>}
            </>
          }
          description={todo.length > 0 ? "Demandes qui attendent votre décision." : undefined}
          link={{ to: "/approvals", label: "Ouvrir les validations" }}
        >
          {todo.length === 0 ? (
            <AllClear>Aucune demande n'attend votre décision.</AllClear>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Demande</TableHead>
                    <TableHead>Demandeur</TableHead>
                    <TableHead>Cible</TableHead>
                    <TableHead>Motif</TableHead>
                    <TableHead className="pr-4 text-right">Expire</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {todo.slice(0, 8).map((a) => (
                    <TableRow key={a.id} className="h-10 cursor-pointer" onClick={() => navigate("/approvals")}>
                      <TableCell className="pl-4">
                        <span className="tabular mr-2 font-mono text-xs text-muted-foreground">#{a.number}</span>
                        {KIND_LABEL[a.kind] || a.kind}
                      </TableCell>
                      <TableCell>{a.requester?.name || "-"}</TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="truncate">
                          {a.server?.name || (a.kind === "access" ? "Accès temporaire" : "-")}
                          {a.account_username && (
                            <span className="ml-2 font-mono text-xs text-muted-foreground">{a.account_username}</span>
                          )}
                        </div>
                        {a.command && (
                          <code className="block truncate font-mono text-xs text-muted-foreground">{a.command}</code>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground">
                        {a.reason || "-"}
                      </TableCell>
                      <TableCell className="tabular pr-4 text-right text-xs text-muted-foreground">
                        {formatDate(a.expires_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {todo.length > 8 && (
                <Link
                  to="/approvals"
                  className="block border-t px-4 py-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  {todo.length - 8} autre{todo.length - 8 > 1 ? "s" : ""} demande{todo.length - 8 > 1 ? "s" : ""}
                </Link>
              )}
            </div>
          )}
        </Section>
      )}

      {!d ? (
        <EmptyState
          icon={Activity}
          title="État des serveurs indisponible"
          action={
            <Button variant="outline" onClick={() => navigate("/servers")}>
              <Server />
              Gérer les serveurs
            </Button>
          }
        >
          Le résumé des serveurs n'a pas pu être chargé. Vérifiez que le backend répond, puis rafraîchissez.
        </EmptyState>
      ) : (
        <>
          {/* Servers needing attention */}
          <Section
            title={
              <>
                Serveurs à surveiller
                {watch.length > 0 && <Chip tone="orange">{watch.length}</Chip>}
              </>
            }
            description={watch.length > 0 ? "Serveurs hors ligne ou au-dessus d'un seuil d'alerte." : undefined}
            link={{ to: "/servers", label: "Tous les serveurs" }}
          >
            {d.total_servers === 0 ? (
              <EmptyState
                icon={Server}
                title="Aucun serveur"
                action={
                  <Button onClick={() => navigate("/servers")}>
                    <Server />
                    Gérer les serveurs
                  </Button>
                }
              >
                Ajoutez un premier serveur pour suivre son état ici.
              </EmptyState>
            ) : watch.length === 0 ? (
              <AllClear>Tous les serveurs répondent, aucune alerte en cours.</AllClear>
            ) : (
              <div className="overflow-hidden rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Serveur</TableHead>
                      <TableHead>Adresse</TableHead>
                      <TableHead>Alertes</TableHead>
                      <TableHead className="pr-4 text-right">Vu pour la dernière fois</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {watch.map((srv) => (
                      <TableRow key={srv.id} className="h-11 cursor-pointer" onClick={() => navigate(`/servers/${srv.id}`)}>
                        <TableCell className="pl-4">
                          <span className="flex items-center gap-2.5">
                            <StatusDot status={srv.status} />
                            <span className="font-medium">{srv.name}</span>
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{srv.ip_address}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {srv.status === "offline" && <Chip tone="red">hors ligne</Chip>}
                            {srv.alerts.map((alert, i) => (
                              <Chip key={i} tone="orange">
                                <AlertTriangle className="size-3" />
                                {alert}
                              </Chip>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="tabular pr-4 text-right text-xs text-muted-foreground">
                          {formatDate(srv.last_seen)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>

          {/* Resources: quieter, for context */}
          {d.servers.length > 0 && (
            <Section
              title="Ressources"
              description={
                <span className="tabular">
                  Moyennes : CPU {d.avg_cpu} %, mémoire {d.avg_memory} %, disque {d.avg_disk} %
                </span>
              }
            >
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Serveur</TableHead>
                      <TableHead>CPU</TableHead>
                      <TableHead>Mémoire</TableHead>
                      <TableHead>Disque</TableHead>
                      <TableHead>Uptime</TableHead>
                      <TableHead className="pr-4 text-right">Processus</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.servers.map((srv) => (
                      <TableRow
                        key={srv.id}
                        className="h-10 cursor-pointer text-muted-foreground"
                        onClick={() => navigate(`/servers/${srv.id}`)}
                      >
                        <TableCell className="pl-4">
                          <span className="flex items-center gap-2.5">
                            <StatusDot status={srv.status} />
                            <span className="text-foreground">{srv.name}</span>
                            <span className="font-mono text-xs">{srv.ip_address}</span>
                          </span>
                        </TableCell>
                        {srv.metrics ? (
                          <>
                            <TableCell>
                              <MiniBar value={srv.metrics.cpu_percent} />
                            </TableCell>
                            <TableCell>
                              <MiniBar value={srv.metrics.memory_percent} />
                            </TableCell>
                            <TableCell>
                              <MiniBar value={srv.metrics.disk_percent} />
                            </TableCell>
                            <TableCell className="tabular text-xs">{formatUptime(srv.metrics.uptime_seconds)}</TableCell>
                            <TableCell className="tabular pr-4 text-right text-xs">{srv.metrics.process_count}</TableCell>
                          </>
                        ) : (
                          <TableCell colSpan={5} className="pr-4 text-xs">
                            Pas de métriques collectées
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
