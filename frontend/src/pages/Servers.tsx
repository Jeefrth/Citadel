import { useEffect, useState } from "react";
import { api } from "@/services/api";
import {
  Server,
  Plus,
  Wifi,
  WifiOff,
  Loader2,
  Info,
  Play,
  X,
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
  status: "online" | "offline" | "unknown";
  credential_id: string | null;
  created_at: string;
}

interface ConnectionTestResult {
  server_id: string;
  server_name: string;
  success: boolean;
  message: string;
  latency_ms: number | null;
}

interface SystemInfoData {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  cpu_count: string;
  memory_total: string;
  memory_used: string;
  disk_usage: string;
}

interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export default function Servers() {
  const [servers, setServers] = useState<ServerData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  // Command execution modal
  const [cmdServer, setCmdServer] = useState<ServerData | null>(null);
  const [cmdInput, setCmdInput] = useState("");
  const [cmdResult, setCmdResult] = useState<CommandResult | null>(null);
  const [cmdLoading, setCmdLoading] = useState(false);

  // System info modal
  const [infoServer, setInfoServer] = useState<ServerData | null>(null);
  const [sysInfo, setSysInfo] = useState<SystemInfoData | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  useEffect(() => {
    api
      .get<ServerData[]>("/api/servers/")
      .then(setServers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleTestConnection = async (srv: ServerData) => {
    setTestingId(srv.id);
    setTestResult(null);
    try {
      const result = await api.post<ConnectionTestResult>(
        `/api/servers/${srv.id}/test-connection`,
        {}
      );
      setTestResult(result);
      // Update server status locally
      setServers((prev) =>
        prev.map((s) =>
          s.id === srv.id
            ? { ...s, status: result.success ? "online" : "offline" }
            : s
        )
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setTestResult({
        server_id: srv.id,
        server_name: srv.name,
        success: false,
        message: msg,
        latency_ms: null,
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleExecute = async () => {
    if (!cmdServer || !cmdInput.trim()) return;
    setCmdLoading(true);
    setCmdResult(null);
    try {
      const result = await api.post<CommandResult>(
        `/api/servers/${cmdServer.id}/execute`,
        { command: cmdInput, timeout: 30 }
      );
      setCmdResult(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setCmdResult({ exit_code: -1, stdout: "", stderr: msg });
    } finally {
      setCmdLoading(false);
    }
  };

  const handleShowInfo = async (srv: ServerData) => {
    setInfoServer(srv);
    setSysInfo(null);
    setInfoLoading(true);
    try {
      const info = await api.get<SystemInfoData>(`/api/servers/${srv.id}/info`);
      setSysInfo(info);
    } catch {
      setSysInfo(null);
    } finally {
      setInfoLoading(false);
    }
  };

  const statusColor = {
    online: "bg-green-500",
    offline: "bg-red-500",
    unknown: "bg-gray-400",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Serveurs</h2>
        <button className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90">
          <Plus size={16} />
          Ajouter un serveur
        </button>
      </div>

      {/* Test result banner */}
      {testResult && (
        <div
          className={`mb-4 p-3 rounded-md text-sm flex items-center justify-between ${
            testResult.success
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          <div className="flex items-center gap-2">
            {testResult.success ? <Wifi size={16} /> : <WifiOff size={16} />}
            <span>
              <strong>{testResult.server_name}</strong> — {testResult.message}
              {testResult.latency_ms && ` (${testResult.latency_ms}ms)`}
            </span>
          </div>
          <button onClick={() => setTestResult(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {loading && <p className="text-muted-foreground">Chargement...</p>}
      {error && <p className="text-destructive">Erreur : {error}</p>}

      {!loading && servers.length === 0 && !error && (
        <div className="bg-card border rounded-lg p-12 text-center">
          <Server size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            Aucun serveur configuré. Cliquez sur "Ajouter un serveur" pour
            commencer.
          </p>
        </div>
      )}

      {servers.length > 0 && (
        <div className="bg-card border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Statut</th>
                <th className="text-left p-3 font-medium">Nom</th>
                <th className="text-left p-3 font-medium">Hostname</th>
                <th className="text-left p-3 font-medium">IP</th>
                <th className="text-left p-3 font-medium">OS</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((srv) => (
                <tr key={srv.id} className="border-b hover:bg-muted/30">
                  <td className="p-3">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor[srv.status]}`}
                    />
                  </td>
                  <td className="p-3 font-medium">{srv.name}</td>
                  <td className="p-3 text-muted-foreground">{srv.hostname}</td>
                  <td className="p-3 font-mono text-xs">{srv.ip_address}</td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded text-xs bg-secondary">
                      {srv.os_type}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleTestConnection(srv)}
                        disabled={testingId === srv.id}
                        className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                        title="Tester la connexion"
                      >
                        {testingId === srv.id ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Wifi size={16} />
                        )}
                      </button>
                      <button
                        onClick={() => handleShowInfo(srv)}
                        className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                        title="Infos système"
                      >
                        <Info size={16} />
                      </button>
                      <button
                        onClick={() => {
                          setCmdServer(srv);
                          setCmdInput("");
                          setCmdResult(null);
                        }}
                        className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                        title="Exécuter une commande"
                      >
                        <Play size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Command execution modal */}
      {cmdServer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-2xl mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">
                Exécuter — {cmdServer.name}{" "}
                <span className="text-xs text-muted-foreground">
                  ({cmdServer.os_type === "linux" ? "SSH / Bash" : "PowerShell"})
                </span>
              </h3>
              <button onClick={() => setCmdServer(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleExecute()}
                  placeholder={
                    cmdServer.os_type === "linux"
                      ? "ls -la /var/log"
                      : "Get-Service | Select-Object -First 5"
                  }
                  className="flex-1 px-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  autoFocus
                />
                <button
                  onClick={handleExecute}
                  disabled={cmdLoading || !cmdInput.trim()}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {cmdLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    "Exécuter"
                  )}
                </button>
              </div>
              {cmdResult && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded ${
                        cmdResult.exit_code === 0
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      Exit: {cmdResult.exit_code}
                    </span>
                  </div>
                  {cmdResult.stdout && (
                    <pre className="p-3 rounded-md bg-muted text-xs font-mono whitespace-pre-wrap max-h-64 overflow-auto">
                      {cmdResult.stdout}
                    </pre>
                  )}
                  {cmdResult.stderr && (
                    <pre className="p-3 rounded-md bg-red-50 text-red-800 text-xs font-mono whitespace-pre-wrap max-h-32 overflow-auto">
                      {cmdResult.stderr}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* System info modal */}
      {infoServer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">
                Infos — {infoServer.name}
              </h3>
              <button onClick={() => setInfoServer(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4">
              {infoLoading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={24} className="animate-spin text-muted-foreground" />
                </div>
              )}
              {sysInfo && (
                <dl className="space-y-3 text-sm">
                  {[
                    ["Hostname", sysInfo.hostname],
                    ["OS", sysInfo.os],
                    ["Kernel", sysInfo.kernel],
                    ["Uptime", sysInfo.uptime],
                    ["CPU", sysInfo.cpu_count + " cores"],
                    ["Mémoire", `${sysInfo.memory_used} / ${sysInfo.memory_total}`],
                    ["Disque", sysInfo.disk_usage],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-mono text-xs">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {!infoLoading && !sysInfo && (
                <p className="text-sm text-destructive text-center py-4">
                  Impossible de récupérer les infos. Vérifiez la connexion et les
                  credentials.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
