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
  Key,
  Trash2,
  Pencil,
} from "lucide-react";

interface CredentialData {
  id: string;
  name: string;
  type: string;
  username: string;
  created_at: string;
}

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

  // Credentials
  const [credentials, setCredentials] = useState<CredentialData[]>([]);
  const [showCredModal, setShowCredModal] = useState(false);
  const [credForm, setCredForm] = useState({
    name: "",
    type: "ssh_password" as string,
    username: "",
    password: "",
    ssh_key: "",
    cert_validity_minutes: 480,
  });
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  // Add server modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    hostname: "",
    ip_address: "",
    os_type: "linux" as "linux" | "windows",
    os_version: "",
    ssh_port: 22,
    winrm_port: 5985,
    credential_id: "" as string,
    ssh_username: "",
    cert_auth_enabled: false,
  });
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit server modal
  const [editServer, setEditServer] = useState<ServerData | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    hostname: "",
    ip_address: "",
    os_type: "linux" as "linux" | "windows",
    os_version: "",
    ssh_port: 22,
    winrm_port: 5985,
    credential_id: "" as string,
  });
  const [editLoading, setEditLoading] = useState(false);

  // Edit credential modal
  const [editCred, setEditCred] = useState<CredentialData | null>(null);
  const [editCredForm, setEditCredForm] = useState({
    name: "",
    username: "",
    password: "",
    ssh_key: "",
  });
  const [editCredLoading, setEditCredLoading] = useState(false);

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
    Promise.all([
      api.get<ServerData[]>("/api/servers/"),
      api.get<CredentialData[]>("/api/servers/credentials/").catch(() => []),
    ])
      .then(([srvs, creds]) => {
        setServers(srvs);
        setCredentials(creds);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleDeleteCredential = async (credId: string) => {
    if (!confirm("Supprimer ce credential ? Les serveurs liés seront déconnectés.")) return;
    try {
      await api.delete(`/api/servers/credentials/${credId}`);
      setCredentials((prev) => prev.filter((c) => c.id !== credId));
      // Unlink from servers locally
      setServers((prev) =>
        prev.map((s) => (s.credential_id === credId ? { ...s, credential_id: null } : s))
      );
    } catch {
      // silently fail
    }
  };

  const handleAddCredential = async () => {
    if (!credForm.name || !credForm.username) return;
    setCredLoading(true);
    setCredError(null);
    try {
      const body: Record<string, unknown> = {
        name: credForm.name,
        type: credForm.type,
        username: credForm.username,
      };
      if (credForm.type === "ephemeral_cert") {
        body.cert_validity_minutes = credForm.cert_validity_minutes;
      } else {
        body.password = credForm.password || null;
        body.ssh_key = credForm.ssh_key || null;
      }
      const newCred = await api.post<CredentialData>("/api/servers/credentials/", body);
      setCredentials((prev) => [...prev, newCred]);
      setCredForm({ name: "", type: "ssh_password", username: "", password: "", ssh_key: "", cert_validity_minutes: 480 });
      setShowCredModal(false);
    } catch (e: unknown) {
      setCredError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setCredLoading(false);
    }
  };

  const handleAssignCredential = async (serverId: string, credentialId: string) => {
    try {
      const updated = await api.patch<ServerData>(`/api/servers/${serverId}`, {
        credential_id: credentialId,
      });
      setServers((prev) => prev.map((s) => (s.id === serverId ? updated : s)));
    } catch {
      // silently fail
    }
  };

  const openEditServer = (srv: ServerData) => {
    setEditServer(srv);
    setEditForm({
      name: srv.name,
      hostname: srv.hostname,
      ip_address: srv.ip_address,
      os_type: srv.os_type,
      os_version: srv.os_version || "",
      ssh_port: srv.ssh_port,
      winrm_port: srv.winrm_port,
      credential_id: srv.credential_id || "",
    });
  };

  const handleEditServer = async () => {
    if (!editServer) return;
    setEditLoading(true);
    try {
      const updated = await api.patch<ServerData>(`/api/servers/${editServer.id}`, {
        name: editForm.name,
        hostname: editForm.hostname,
        ip_address: editForm.ip_address,
        os_type: editForm.os_type,
        os_version: editForm.os_version || null,
        ssh_port: editForm.ssh_port,
        winrm_port: editForm.winrm_port,
        credential_id: editForm.credential_id || null,
      });
      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditServer(null);
    } catch {
      // silently fail
    } finally {
      setEditLoading(false);
    }
  };

  const openEditCred = (cred: CredentialData) => {
    setEditCred(cred);
    setEditCredForm({
      name: cred.name,
      username: cred.username,
      password: "",
      ssh_key: "",
    });
  };

  const handleEditCredential = async () => {
    if (!editCred) return;
    setEditCredLoading(true);
    try {
      const body: Record<string, string> = {};
      if (editCredForm.name !== editCred.name) body.name = editCredForm.name;
      if (editCredForm.username !== editCred.username) body.username = editCredForm.username;
      if (editCredForm.password) body.password = editCredForm.password;
      if (editCredForm.ssh_key) body.ssh_key = editCredForm.ssh_key;

      const updated = await api.patch<CredentialData>(
        `/api/servers/credentials/${editCred.id}`,
        body
      );
      setCredentials((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditCred(null);
    } catch {
      // silently fail
    } finally {
      setEditCredLoading(false);
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    if (!confirm("Supprimer ce serveur ?")) return;
    try {
      await api.delete(`/api/servers/${serverId}`);
      setServers((prev) => prev.filter((s) => s.id !== serverId));
    } catch {
      // silently fail
    }
  };

  const handleAddServer = async () => {
    if (!addForm.name || !addForm.hostname || !addForm.ip_address) return;
    setAddLoading(true);
    setAddError(null);
    try {
      const newServer = await api.post<ServerData>("/api/servers/", {
        name: addForm.name,
        hostname: addForm.hostname,
        ip_address: addForm.ip_address,
        os_type: addForm.os_type,
        os_version: addForm.os_version || null,
        ssh_port: addForm.ssh_port,
        winrm_port: addForm.winrm_port,
        credential_id: addForm.credential_id || null,
        ssh_username: addForm.ssh_username || null,
        cert_auth_enabled: addForm.cert_auth_enabled,
      });
      setServers((prev) => [...prev, newServer]);
      setShowAddModal(false);
      setAddForm({
        name: "",
        hostname: "",
        ip_address: "",
        os_type: "linux",
        os_version: "",
        ssh_port: 22,
        winrm_port: 5985,
        credential_id: "",
      });
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally {
      setAddLoading(false);
    }
  };

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCredModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-md border text-sm font-medium hover:bg-accent"
          >
            <Key size={16} />
            Credentials ({credentials.length})
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={16} />
            Ajouter un serveur
          </button>
        </div>
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
                <th className="text-left p-3 font-medium">Credential</th>
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
                  <td className="p-3">
                    <select
                      value={srv.credential_id || ""}
                      onChange={(e) => handleAssignCredential(srv.id, e.target.value)}
                      className="px-2 py-1 rounded border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">-- aucun --</option>
                      {credentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.username})
                        </option>
                      ))}
                    </select>
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
                      <button
                        onClick={() => openEditServer(srv)}
                        className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                        title="Modifier"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteServer(srv.id)}
                        className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600"
                        title="Supprimer"
                      >
                        <Trash2 size={16} />
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
      {/* Add server modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">Ajouter un serveur</h3>
              <button onClick={() => setShowAddModal(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {addError && (
                <div className="p-2 rounded bg-red-50 text-red-700 text-sm">
                  {addError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Nom *</label>
                  <input
                    type="text"
                    value={addForm.name}
                    onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                    placeholder="web-prod-01"
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Hostname *</label>
                  <input
                    type="text"
                    value={addForm.hostname}
                    onChange={(e) => setAddForm({ ...addForm, hostname: e.target.value })}
                    placeholder="web-prod-01.local"
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Adresse IP *</label>
                  <input
                    type="text"
                    value={addForm.ip_address}
                    onChange={(e) => setAddForm({ ...addForm, ip_address: e.target.value })}
                    placeholder="192.168.1.10"
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Type OS *</label>
                  <select
                    value={addForm.os_type}
                    onChange={(e) => setAddForm({ ...addForm, os_type: e.target.value as "linux" | "windows" })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="linux">Linux</option>
                    <option value="windows">Windows</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Version OS</label>
                  <input
                    type="text"
                    value={addForm.os_version}
                    onChange={(e) => setAddForm({ ...addForm, os_version: e.target.value })}
                    placeholder="Ubuntu 22.04"
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Port SSH</label>
                  <input
                    type="number"
                    value={addForm.ssh_port}
                    onChange={(e) => setAddForm({ ...addForm, ssh_port: parseInt(e.target.value) || 22 })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Port WinRM</label>
                  <input
                    type="number"
                    value={addForm.winrm_port}
                    onChange={(e) => setAddForm({ ...addForm, winrm_port: parseInt(e.target.value) || 5985 })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                {addForm.os_type === "linux" && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1">User SSH</label>
                      <input
                        type="text"
                        value={addForm.ssh_username}
                        onChange={(e) => setAddForm({ ...addForm, ssh_username: e.target.value })}
                        placeholder="root"
                        className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div className="flex items-center gap-2 pt-6">
                      <input
                        type="checkbox"
                        checked={addForm.cert_auth_enabled}
                        onChange={(e) => setAddForm({ ...addForm, cert_auth_enabled: e.target.checked })}
                        className="w-4 h-4 rounded"
                      />
                      <label className="text-sm">Cert auto (CA)</label>
                    </div>
                  </>
                )}
                {!addForm.cert_auth_enabled && (
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Credential</label>
                  <div className="flex gap-2">
                    <select
                      value={addForm.credential_id}
                      onChange={(e) => setAddForm({ ...addForm, credential_id: e.target.value })}
                      className="flex-1 px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="">-- aucun --</option>
                      {credentials.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.username})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowCredModal(true)}
                      className="px-3 py-2 rounded-md border text-sm hover:bg-accent"
                      title="Nouveau credential"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
                )}
              </div>

              {addForm.cert_auth_enabled && (
                <div className="p-3 rounded bg-blue-50 border border-blue-200 text-sm text-blue-800">
                  <p className="font-medium">Mode certificat automatique</p>
                  <p className="text-xs mt-1">
                    Pas de credential nécessaire. Un certificat SSH éphémère sera généré à chaque connexion.
                    Le serveur doit avoir la clé CA dans sshd_config.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-md border text-sm hover:bg-accent"
                >
                  Annuler
                </button>
                <button
                  onClick={handleAddServer}
                  disabled={addLoading || !addForm.name || !addForm.hostname || !addForm.ip_address}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {addLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    "Ajouter"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Credentials modal */}
      {showCredModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">Credentials</h3>
              <button onClick={() => setShowCredModal(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Existing credentials */}
              {credentials.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground uppercase">
                    Existants
                  </h4>
                  {credentials.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between p-2 rounded border text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <Key size={14} className="text-muted-foreground" />
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {c.username} — {c.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEditCred(c)}
                          className="p-1 rounded hover:bg-accent text-muted-foreground"
                          title="Modifier"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => handleDeleteCredential(c.id)}
                          className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600"
                          title="Supprimer"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add new credential */}
              <div className="border-t pt-4">
                <h4 className="text-xs font-medium text-muted-foreground uppercase mb-3">
                  Nouveau credential
                </h4>

                {credError && (
                  <div className="p-2 rounded bg-red-50 text-red-700 text-sm mb-3">
                    {credError}
                  </div>
                )}

                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Nom *</label>
                      <input
                        type="text"
                        value={credForm.name}
                        onChange={(e) => setCredForm({ ...credForm, name: e.target.value })}
                        placeholder="ssh-admin-prod"
                        className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Type *</label>
                      <select
                        value={credForm.type}
                        onChange={(e) => setCredForm({ ...credForm, type: e.target.value })}
                        className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="ssh_password">SSH (mot de passe)</option>
                        <option value="ssh_key">SSH (clé privée)</option>
                        <option value="winrm">WinRM</option>
                        <option value="ephemeral_cert">Certificat éphémère (CA)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Utilisateur *</label>
                    <input
                      type="text"
                      value={credForm.username}
                      onChange={(e) => setCredForm({ ...credForm, username: e.target.value })}
                      placeholder="root"
                      className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {(credForm.type === "ssh_password" || credForm.type === "winrm") && (
                    <div>
                      <label className="block text-sm font-medium mb-1">Mot de passe</label>
                      <input
                        type="password"
                        value={credForm.password}
                        onChange={(e) => setCredForm({ ...credForm, password: e.target.value })}
                        className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  )}

                  {credForm.type === "ssh_key" && (
                    <div>
                      <label className="block text-sm font-medium mb-1">Clé privée SSH</label>
                      <textarea
                        value={credForm.ssh_key}
                        onChange={(e) => setCredForm({ ...credForm, ssh_key: e.target.value })}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        rows={4}
                        className="w-full px-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  )}

                  {credForm.type === "ephemeral_cert" && (
                    <div className="space-y-3">
                      <div className="p-3 rounded-md bg-blue-50 border border-blue-200 text-sm text-blue-800">
                        <p className="font-medium mb-1">Certificat SSH éphémère</p>
                        <p className="text-xs">
                          Citadel signera un certificat SSH de courte durée à chaque connexion.
                          Aucun mot de passe ni clé stockée. Le serveur cible doit faire confiance à la CA.
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Durée du certificat
                        </label>
                        <select
                          value={credForm.cert_validity_minutes || 480}
                          onChange={(e) =>
                            setCredForm({
                              ...credForm,
                              cert_validity_minutes: parseInt(e.target.value),
                            })
                          }
                          className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value={5}>5 minutes</option>
                          <option value={15}>15 minutes</option>
                          <option value={30}>30 minutes</option>
                          <option value={60}>1 heure</option>
                          <option value={120}>2 heures</option>
                          <option value={240}>4 heures</option>
                          <option value={480}>8 heures (défaut)</option>
                          <option value={720}>12 heures</option>
                          <option value={1440}>24 heures</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Setup serveur cible
                        </label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Récupérez les instructions via l'API : GET /api/ca/setup-instructions?hostname=mon-serveur
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            window.open("/api/ca/setup-instructions?hostname=my-server", "_blank");
                          }}
                          className="text-xs text-primary hover:underline"
                        >
                          Voir les instructions de setup
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleAddCredential}
                    disabled={credLoading || !credForm.name || !credForm.username}
                    className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    {credLoading ? (
                      <Loader2 size={16} className="animate-spin mx-auto" />
                    ) : (
                      "Ajouter le credential"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Edit server modal */}
      {editServer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">Modifier — {editServer.name}</h3>
              <button onClick={() => setEditServer(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Nom</label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Hostname</label>
                  <input
                    type="text"
                    value={editForm.hostname}
                    onChange={(e) => setEditForm({ ...editForm, hostname: e.target.value })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Adresse IP</label>
                  <input
                    type="text"
                    value={editForm.ip_address}
                    onChange={(e) => setEditForm({ ...editForm, ip_address: e.target.value })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Type OS</label>
                  <select
                    value={editForm.os_type}
                    onChange={(e) => setEditForm({ ...editForm, os_type: e.target.value as "linux" | "windows" })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="linux">Linux</option>
                    <option value="windows">Windows</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Version OS</label>
                  <input
                    type="text"
                    value={editForm.os_version}
                    onChange={(e) => setEditForm({ ...editForm, os_version: e.target.value })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Port SSH</label>
                  <input
                    type="number"
                    value={editForm.ssh_port}
                    onChange={(e) => setEditForm({ ...editForm, ssh_port: parseInt(e.target.value) || 22 })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Port WinRM</label>
                  <input
                    type="number"
                    value={editForm.winrm_port}
                    onChange={(e) => setEditForm({ ...editForm, winrm_port: parseInt(e.target.value) || 5985 })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1">Credential</label>
                  <select
                    value={editForm.credential_id}
                    onChange={(e) => setEditForm({ ...editForm, credential_id: e.target.value })}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">-- aucun --</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.username})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setEditServer(null)}
                  className="px-4 py-2 rounded-md border text-sm hover:bg-accent"
                >
                  Annuler
                </button>
                <button
                  onClick={handleEditServer}
                  disabled={editLoading}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {editLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    "Enregistrer"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit credential modal */}
      {editCred && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">Modifier — {editCred.name}</h3>
              <button onClick={() => setEditCred(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Nom</label>
                <input
                  type="text"
                  value={editCredForm.name}
                  onChange={(e) => setEditCredForm({ ...editCredForm, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Utilisateur</label>
                <input
                  type="text"
                  value={editCredForm.username}
                  onChange={(e) => setEditCredForm({ ...editCredForm, username: e.target.value })}
                  className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Nouveau mot de passe
                  <span className="text-xs text-muted-foreground ml-1">(laisser vide pour ne pas changer)</span>
                </label>
                <input
                  type="password"
                  value={editCredForm.password}
                  onChange={(e) => setEditCredForm({ ...editCredForm, password: e.target.value })}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              {editCred.type === "ssh_key" && (
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Nouvelle clé SSH
                    <span className="text-xs text-muted-foreground ml-1">(laisser vide pour ne pas changer)</span>
                  </label>
                  <textarea
                    value={editCredForm.ssh_key}
                    onChange={(e) => setEditCredForm({ ...editCredForm, ssh_key: e.target.value })}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={4}
                    className="w-full px-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setEditCred(null)}
                  className="px-4 py-2 rounded-md border text-sm hover:bg-accent"
                >
                  Annuler
                </button>
                <button
                  onClick={handleEditCredential}
                  disabled={editCredLoading}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {editCredLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    "Enregistrer"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
