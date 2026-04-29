import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@/services/api";
import Sparkline from "@/components/Sparkline";
import {
  ArrowLeft,
  Cpu,
  MemoryStick,
  HardDrive,
  Activity,
  Clock,
  Network,
  Server,
  RefreshCw,
  Loader2,
  Wifi,
  Play,
} from "lucide-react";

interface ServerData {
  id: string;
  name: string;
  hostname: string;
  ip_address: string;
  os_type: "linux" | "windows";
  os_version: string | null;
  ssh_port: number;
  winrm_port: number;
  status: string;
  last_seen: string | null;
  tags: Record<string, string> | null;
}

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

function MetricCard({
  icon: Icon,
  label,
  value,
  subValue,
  percent,
  color,
  history,
  sparkColor,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  subValue?: string;
  percent: number;
  color: string;
  history: number[];
  sparkColor: string;
}) {
  const barColor =
    percent > 90 ? "bg-red-500" :
    percent > 75 ? "bg-amber-500" :
    color;

  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className="text-muted-foreground" />
          <span className="text-sm font-medium">{label}</span>
        </div>
        <span className="text-2xl font-bold">{value}</span>
      </div>
      {subValue && (
        <p className="text-xs text-muted-foreground mb-2">{subValue}</p>
      )}
      <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden mb-3">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      <Sparkline data={history} width={260} height={45} color={sparkColor} />
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!server) return null;

  const cpuHistory = history.map((h) => h.cpu_percent);
  const memHistory = history.map((h) => h.memory_percent);
  const diskHistory = history.map((h) => h.disk_percent);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => navigate("/servers")}
          className="p-2 rounded-md hover:bg-accent"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-3 flex-1">
          <Server
            size={24}
            className={server.os_type === "linux" ? "text-green-500" : "text-blue-500"}
          />
          <div>
            <h2 className="text-2xl font-bold">{server.name}</h2>
            <p className="text-sm text-muted-foreground">
              {server.ip_address} · {server.hostname} · {server.os_type}
              {server.os_version && ` · ${server.os_version}`}
            </p>
          </div>
          <span
            className={`ml-3 px-2.5 py-0.5 rounded-full text-xs font-medium ${
              server.status === "online"
                ? "bg-green-100 text-green-700"
                : server.status === "offline"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-700"
            }`}
          >
            {server.status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCollect}
            disabled={collecting}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {collecting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            Collecter métriques
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => navigate("/terminal")}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm hover:bg-accent"
        >
          <Play size={14} /> Terminal
        </button>
        <button className="flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm hover:bg-accent">
          <Wifi size={14} /> Test connexion
        </button>
      </div>

      {/* Metrics cards */}
      {metrics ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <MetricCard
            icon={Cpu}
            label="CPU"
            value={`${metrics.cpu_percent.toFixed(1)}%`}
            subValue={`${metrics.cpu_count} cores · Load: ${metrics.load_average}`}
            percent={metrics.cpu_percent}
            color="bg-purple-500"
            history={cpuHistory}
            sparkColor="#8b5cf6"
          />
          <MetricCard
            icon={MemoryStick}
            label="Mémoire"
            value={`${metrics.memory_percent.toFixed(1)}%`}
            subValue={`${Math.round(metrics.memory_used_mb / 1024)} / ${Math.round(metrics.memory_total_mb / 1024)} GB`}
            percent={metrics.memory_percent}
            color="bg-blue-500"
            history={memHistory}
            sparkColor="#7aa2f7"
          />
          <MetricCard
            icon={HardDrive}
            label="Disque"
            value={`${metrics.disk_percent.toFixed(0)}%`}
            subValue={`${metrics.disk_used_gb} / ${metrics.disk_total_gb} GB`}
            percent={metrics.disk_percent}
            color="bg-amber-500"
            history={diskHistory}
            sparkColor="#f59e0b"
          />
        </div>
      ) : (
        <div className="bg-card border rounded-lg p-8 text-center mb-6">
          <Activity size={36} className="mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground text-sm">
            Aucune métrique collectée. Cliquez sur "Collecter métriques" pour démarrer.
          </p>
        </div>
      )}

      {/* System info */}
      {metrics && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card border rounded-lg p-4">
            <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
              <Activity size={16} /> Système
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground flex items-center gap-2">
                  <Clock size={14} /> Uptime
                </dt>
                <dd className="font-mono">{formatUptime(metrics.uptime_seconds)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Processus</dt>
                <dd className="font-mono">{metrics.process_count}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Load Average</dt>
                <dd className="font-mono">{metrics.load_average}</dd>
              </div>
            </dl>
          </div>

          <div className="bg-card border rounded-lg p-4">
            <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
              <Network size={16} /> Réseau
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Reçu (RX)</dt>
                <dd className="font-mono">{formatBytes(metrics.network_rx_bytes)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Envoyé (TX)</dt>
                <dd className="font-mono">{formatBytes(metrics.network_tx_bytes)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Port SSH/WinRM</dt>
                <dd className="font-mono">
                  {server.os_type === "linux" ? server.ssh_port : server.winrm_port}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
