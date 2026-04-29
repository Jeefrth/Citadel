import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/services/api";
import {
  Server,
  Cpu,
  MemoryStick,
  HardDrive,
  Activity,
  AlertTriangle,
  Wifi,
  WifiOff,
  HelpCircle,
  RefreshCw,
  Loader2,
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

function ProgressBar({ value, color }: { value: number; color: string }) {
  const bgColor =
    value > 90 ? "bg-red-500" :
    value > 75 ? "bg-amber-500" :
    color;

  return (
    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${bgColor}`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}j ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const navigate = useNavigate();

  const fetchDashboard = (showRefresh = false) => {
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
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  // If no backend, show a nice placeholder
  if (!loading && !data) {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-6">Dashboard</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Serveurs", icon: Server, color: "text-blue-500", value: "—" },
            { label: "En ligne", icon: Wifi, color: "text-green-500", value: "—" },
            { label: "Alertes", icon: AlertTriangle, color: "text-amber-500", value: "—" },
            { label: "CPU moyen", icon: Cpu, color: "text-purple-500", value: "—" },
          ].map(({ label, icon: Icon, color, value }) => (
            <div key={label} className="bg-card border rounded-lg p-5 flex items-center gap-4">
              <Icon size={22} className={color} />
              <div>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="bg-card border rounded-lg p-8 text-center">
          <Activity size={48} className="mx-auto text-muted-foreground mb-4" />
          <h3 className="font-semibold mb-2">Bienvenue dans srv_gest</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Connectez le backend et ajoutez des serveurs pour voir les métriques en temps réel.
          </p>
          <button
            onClick={() => navigate("/servers")}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
          >
            Gérer les serveurs
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const d = data!;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <button
          onClick={() => fetchDashboard(true)}
          disabled={refreshing}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
          Rafraîchir
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-5">
          <div className="flex items-center gap-3 mb-2">
            <Server size={20} className="text-blue-500" />
            <span className="text-xs text-muted-foreground">Serveurs</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{d.total_servers}</span>
            <div className="flex gap-1 text-xs">
              <span className="text-green-600">{d.online_servers} on</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-red-600">{d.offline_servers} off</span>
            </div>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-5">
          <div className="flex items-center gap-3 mb-2">
            <Cpu size={20} className="text-purple-500" />
            <span className="text-xs text-muted-foreground">CPU moyen</span>
          </div>
          <span className="text-3xl font-bold">{d.avg_cpu}%</span>
          <ProgressBar value={d.avg_cpu} color="bg-purple-500" />
        </div>

        <div className="bg-card border rounded-lg p-5">
          <div className="flex items-center gap-3 mb-2">
            <MemoryStick size={20} className="text-blue-500" />
            <span className="text-xs text-muted-foreground">RAM moyen</span>
          </div>
          <span className="text-3xl font-bold">{d.avg_memory}%</span>
          <ProgressBar value={d.avg_memory} color="bg-blue-500" />
        </div>

        <div className="bg-card border rounded-lg p-5">
          <div className="flex items-center gap-3 mb-2">
            {d.total_alerts > 0 ? (
              <AlertTriangle size={20} className="text-red-500" />
            ) : (
              <Activity size={20} className="text-green-500" />
            )}
            <span className="text-xs text-muted-foreground">Alertes</span>
          </div>
          <span className={`text-3xl font-bold ${d.total_alerts > 0 ? "text-red-600" : "text-green-600"}`}>
            {d.total_alerts}
          </span>
        </div>
      </div>

      {/* Server cards with metrics */}
      <h3 className="font-semibold mb-3">Serveurs</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {d.servers.map((srv) => (
          <div
            key={srv.id}
            className="bg-card border rounded-lg p-4 hover:border-primary/50 transition-colors cursor-pointer"
            onClick={() => navigate(`/servers`)}
          >
            {/* Header */}
            <div className="flex items-center gap-3 mb-3">
              <div className="relative">
                <Server
                  size={18}
                  className={srv.os_type === "linux" ? "text-green-500" : "text-blue-500"}
                />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card ${
                    srv.status === "online" ? "bg-green-500" :
                    srv.status === "offline" ? "bg-red-500" : "bg-gray-400"
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{srv.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {srv.ip_address} · {srv.os_type}
                </p>
              </div>
              {srv.alerts.length > 0 && (
                <AlertTriangle size={16} className="text-red-500" />
              )}
            </div>

            {/* Metrics */}
            {srv.metrics ? (
              <div className="space-y-2.5">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Cpu size={12} /> CPU
                    </span>
                    <span className="font-mono">{srv.metrics.cpu_percent.toFixed(1)}%</span>
                  </div>
                  <ProgressBar value={srv.metrics.cpu_percent} color="bg-purple-500" />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <MemoryStick size={12} /> RAM
                    </span>
                    <span className="font-mono">
                      {srv.metrics.memory_percent.toFixed(1)}%
                      <span className="text-muted-foreground ml-1">
                        ({Math.round(srv.metrics.memory_used_mb / 1024)}
                        /{Math.round(srv.metrics.memory_total_mb / 1024)} GB)
                      </span>
                    </span>
                  </div>
                  <ProgressBar value={srv.metrics.memory_percent} color="bg-blue-500" />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <HardDrive size={12} /> Disque
                    </span>
                    <span className="font-mono">
                      {srv.metrics.disk_percent.toFixed(0)}%
                      <span className="text-muted-foreground ml-1">
                        ({srv.metrics.disk_used_gb}/{srv.metrics.disk_total_gb} GB)
                      </span>
                    </span>
                  </div>
                  <ProgressBar value={srv.metrics.disk_percent} color="bg-amber-500" />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t">
                  <span>Uptime: {formatUptime(srv.metrics.uptime_seconds)}</span>
                  <span>{srv.metrics.process_count} proc</span>
                  <span>Net: {formatBytes(srv.metrics.network_rx_bytes)}↓</span>
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <HelpCircle size={20} className="mx-auto text-muted-foreground mb-1" />
                <p className="text-xs text-muted-foreground">Pas de métriques</p>
              </div>
            )}

            {/* Alerts */}
            {srv.alerts.length > 0 && (
              <div className="mt-2 space-y-1">
                {srv.alerts.map((alert, i) => (
                  <div
                    key={i}
                    className="text-xs px-2 py-1 rounded bg-red-50 text-red-700 flex items-center gap-1"
                  >
                    <AlertTriangle size={10} />
                    {alert}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
