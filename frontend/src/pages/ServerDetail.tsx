import { useEffect, useState, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { hasAction, type ServerData } from "@/services/types";
import Sparkline from "@/components/Sparkline";
import AccountsSection from "@/components/AccountsSection";
import { DiscoveredAccountsSection } from "@/components/DiscoveredAccounts";
import FilesSection from "@/components/FilesSection";
import { ServerOriginChips } from "@/components/opsUi";
import { Chip, EmptyState, LabelChips, PageHeader } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Cpu,
  MemoryStick,
  HardDrive,
  Activity,
  Clock,
  Network,
  RefreshCw,
  Loader2,
  Wifi,
  WifiOff,
  Star,
  Monitor,
  Terminal as TerminalIcon,
  type LucideIcon,
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

interface HistoryPoint {
  timestamp: string;
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} jours, ${h}h ${m}min`;
  return `${h}h ${m}min`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** Usage level carried by colour: calm under 75 %, amber above, red above 90 %. */
function levelTone(percent: number): string {
  return percent > 90 ? "text-danger" : percent > 75 ? "text-live" : "text-info";
}

function MetricBlock({
  icon: Icon,
  label,
  value,
  subValue,
  percent,
  history,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  subValue?: string;
  percent: number;
  history: number[];
}) {
  const tone = levelTone(percent);
  return (
    <div className="min-w-0 space-y-2 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </span>
        <span className={cn("tabular text-xl font-semibold", percent > 75 ? tone : "text-foreground")}>{value}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full bg-current transition-[width]", tone)}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      {subValue && <p className="tabular text-xs text-muted-foreground">{subValue}</p>}
      <Sparkline data={history} width={260} height={36} className={cn("w-full", tone, "opacity-80")} />
    </div>
  );
}

function StatusBadge({ status }: { status: ServerData["status"] }) {
  const map = {
    online: { label: "En ligne", tone: "green" as const, dot: "bg-success" },
    offline: { label: "Hors ligne", tone: "red" as const, dot: "bg-danger" },
    unknown: { label: "Inconnu", tone: "default" as const, dot: "bg-muted-foreground/50" },
  };
  const m = map[status] || map.unknown;
  return (
    <Chip tone={m.tone}>
      <span className={cn("size-1.5 rounded-full", m.dot)} />
      {m.label}
    </Chip>
  );
}

function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="flex items-center gap-2 text-muted-foreground">{label}</dt>
      <dd className="tabular font-mono text-xs">{children}</dd>
    </div>
  );
}

export default function ServerDetail() {
  const { serverId } = useParams<{ serverId: string }>();
  const navigate = useNavigate();
  const [server, setServer] = useState<ServerData | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { can } = useCurrentUser();
  // Accounts: inventory ("servers") or secrets lifecycle ("secrets"); the API checks each action
  const isAdmin = can("servers") || can("secrets");
  // Bumped when managed accounts change, so both account blocks reload
  const [accountsVersion, setAccountsVersion] = useState(0);

  useEffect(() => {
    if (!serverId) return;
    Promise.all([
      api.get<ServerData>(`/api/servers/${serverId}`),
      api.get<MetricsData | null>(`/api/servers/${serverId}/metrics/latest`).catch(() => null),
      api.get<HistoryPoint[]>(`/api/servers/${serverId}/metrics/history?hours=24`).catch(() => []),
    ])
      .then(([srv, met, hist]) => {
        setServer(srv);
        setMetrics(met);
        setHistory(hist);
      })
      .catch(() => navigate("/servers"))
      .finally(() => setLoading(false));
  }, [serverId, navigate]);

  const handleCollect = async () => {
    if (!serverId) return;
    setCollecting(true);
    try {
      const met = await api.post<MetricsData>(`/api/servers/${serverId}/metrics`, {});
      setMetrics(met);
      // Refresh history
      const hist = await api.get<HistoryPoint[]>(
        `/api/servers/${serverId}/metrics/history?hours=24`
      );
      setHistory(hist);
    } catch {
      // handled silently
    } finally {
      setCollecting(false);
    }
  };

  const handleTest = async () => {
    if (!serverId) return;
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await api.post<{ success: boolean; message: string; latency_ms: number | null }>(
        `/api/servers/${serverId}/test-connection`,
        {}
      );
      setTestMsg({ ok: r.success, text: r.message + (r.latency_ms ? ` (${r.latency_ms}ms)` : "") });
      setServer((s) => (s ? { ...s, status: r.success ? "online" : "offline" } : s));
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : "Erreur" });
    } finally {
      setTesting(false);
    }
  };

  const toggleFavorite = async () => {
    if (!server) return;
    const next = !server.is_favorite;
    setServer({ ...server, is_favorite: next });
    try {
      if (next) await api.put(`/api/servers/${server.id}/favorite`, {});
      else await api.delete(`/api/servers/${server.id}/favorite`);
    } catch {
      setServer((s) => (s ? { ...s, is_favorite: !next } : s));
    }
  };

  const reloadServer = () => {
    if (!serverId) return;
    api.get<ServerData>(`/api/servers/${serverId}`).then(setServer).catch(() => {});
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!server) return null;

  const cpuHistory = history.map((h) => h.cpu_percent);
  const memHistory = history.map((h) => h.memory_percent);
  const diskHistory = history.map((h) => h.disk_percent);

  const canConnect = hasAction(server, "connect");
  const canFiles = server.os_type === "linux" && (hasAction(server, "upload") || hasAction(server, "download"));

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => navigate("/servers")} className="-ml-2 mb-2 text-muted-foreground">
        <ArrowLeft /> Serveurs
      </Button>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {server.name}
            <FavoriteStar on={server.is_favorite} onToggle={toggleFavorite} />
            <StatusBadge status={server.status} />
            <ServerOriginChips server={server} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-foreground">{server.ip_address}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{server.hostname}</span>
            <span aria-hidden>·</span>
            <span>
              {server.os_type}
              {server.os_version && ` ${server.os_version}`}
            </span>
            {server.node_path && (
              <>
                <span aria-hidden>·</span>
                <span>{server.node_path}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={handleTest} disabled={testing}>
              {testing ? <Loader2 className="animate-spin" /> : <Wifi />}
              Tester la connexion
            </Button>
            <Button variant="outline" onClick={handleCollect} disabled={collecting}>
              {collecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Collecter les métriques
            </Button>
            <Button
              onClick={() => navigate(`/terminal?server=${server.id}`)}
              disabled={!canConnect}
              title={canConnect ? undefined : "Connexion non autorisée"}
            >
              {server.os_type === "windows" ? <Monitor /> : <TerminalIcon />}
              {server.os_type === "windows" ? "Ouvrir une session RDP" : "Ouvrir un terminal"}
            </Button>
          </>
        }
      />

      <div className="-mt-3 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {server.tags && Object.keys(server.tags).length > 0 && <LabelChips tags={server.tags} />}
        <span className="text-muted-foreground">
          Compte par défaut :{" "}
          {server.default_account ? (
            <span className="font-mono text-foreground">{server.default_account.username}</span>
          ) : (
            "aucun"
          )}
        </span>
        <AnimatePresence initial={false}>
          {testMsg && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className={cn("flex items-center gap-1.5 text-xs", testMsg.ok ? "text-success" : "text-danger")}
            >
              {testMsg.ok ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {testMsg.text}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Metrics */}
      {metrics ? (
        <>
          <section className="mb-6 overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <h2 className="text-sm font-medium">Ressources</h2>
              <span className="text-xs text-muted-foreground">Tendance sur 24 h</span>
            </div>
            <div className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
              <MetricBlock
                icon={Cpu}
                label="CPU"
                value={`${metrics.cpu_percent.toFixed(1)} %`}
                subValue={`${metrics.cpu_count} cœurs, charge ${metrics.load_average}`}
                percent={metrics.cpu_percent}
                history={cpuHistory}
              />
              <MetricBlock
                icon={MemoryStick}
                label="Mémoire"
                value={`${metrics.memory_percent.toFixed(1)} %`}
                subValue={`${Math.round(metrics.memory_used_mb / 1024)} / ${Math.round(metrics.memory_total_mb / 1024)} GB`}
                percent={metrics.memory_percent}
                history={memHistory}
              />
              <MetricBlock
                icon={HardDrive}
                label="Disque"
                value={`${metrics.disk_percent.toFixed(0)} %`}
                subValue={`${metrics.disk_used_gb} / ${metrics.disk_total_gb} GB`}
                percent={metrics.disk_percent}
                history={diskHistory}
              />
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card className="rounded-lg shadow-none">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Activity className="size-4 text-muted-foreground" /> Système
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <dl className="divide-y text-sm">
                  <InfoRow label={<><Clock className="size-3.5" /> Uptime</>}>{formatUptime(metrics.uptime_seconds)}</InfoRow>
                  <InfoRow label="Processus">{metrics.process_count}</InfoRow>
                  <InfoRow label="Charge moyenne">{metrics.load_average}</InfoRow>
                </dl>
              </CardContent>
            </Card>
            <Card className="rounded-lg shadow-none">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Network className="size-4 text-muted-foreground" /> Réseau
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <dl className="divide-y text-sm">
                  <InfoRow label="Reçu (RX)">{formatBytes(metrics.network_rx_bytes)}</InfoRow>
                  <InfoRow label="Envoyé (TX)">{formatBytes(metrics.network_tx_bytes)}</InfoRow>
                  <InfoRow label={server.os_type === "linux" ? "Port SSH" : "Port WinRM"}>
                    {server.os_type === "linux" ? server.ssh_port : server.winrm_port}
                  </InfoRow>
                </dl>
              </CardContent>
            </Card>
          </div>
        </>
      ) : (
        <EmptyState
          icon={Activity}
          title="Aucune métrique collectée"
          action={
            <Button variant="outline" onClick={handleCollect} disabled={collecting}>
              {collecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Collecter les métriques
            </Button>
          }
        >
          Lancez une première collecte pour suivre le CPU, la mémoire et le disque de ce serveur.
        </EmptyState>
      )}

      {canFiles && <FilesSection server={server} />}

      {isAdmin && (
        <>
          <AccountsSection
            server={server}
            reloadKey={accountsVersion}
            onChanged={() => {
              reloadServer();
              setAccountsVersion((v) => v + 1);
            }}
          />
          <DiscoveredAccountsSection
            server={server}
            reloadKey={accountsVersion}
            onManaged={() => {
              reloadServer();
              setAccountsVersion((v) => v + 1);
            }}
          />
        </>
      )}
    </div>
  );
}

/** Favourite toggle: the star pops when it changes. */
function FavoriteStar({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const label = on ? "Retirer des favoris" : "Ajouter aux favoris";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className="flex rounded p-0.5 text-muted-foreground transition-colors hover:text-live"
    >
      <motion.span
        key={on ? "on" : "off"}
        initial={{ scale: 0.6, rotate: on ? -30 : 0 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 18 }}
        className="flex"
      >
        <Star className={cn("size-[18px]", on && "fill-live text-live")} />
      </motion.span>
    </button>
  );
}
