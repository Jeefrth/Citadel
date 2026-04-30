import { useEffect, useState } from "react";
import { api } from "@/services/api";
import {
  Settings as SettingsIcon,
  Shield,
  Key,
  Users,
  Terminal,
  Globe,
  AlertTriangle,
  Save,
  RotateCcw,
  Loader2,
  Trash2,
  Plus,
  X,
  Copy,
  Check,
  Info,
} from "lucide-react";

interface SettingMeta {
  key: string;
  value: string;
  description: string;
  is_default: boolean;
}

interface UserData {
  id: string;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
  last_login: string | null;
}

interface CaInfo {
  public_key: string;
  key_path: string;
  algorithm: string;
}

interface SystemInfo {
  version: string;
  servers: number;
  users: number;
  sessions: number;
  audit_entries: number;
  alert_rules: number;
}

type Tab = "security" | "commands" | "network" | "ca" | "users" | "system";

export default function Settings() {
  const [activeTab, setActiveTab] = useState<Tab>("security");
  const [settings, setSettings] = useState<Record<string, SettingMeta>>({});
  const [users, setUsers] = useState<UserData[]>([]);
  const [caInfo, setCaInfo] = useState<CaInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Editable state
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  // IP allowlist editing
  const [newIp, setNewIp] = useState("");

  // Command filter editing
  const [newPattern, setNewPattern] = useState("");

  useEffect(() => {
    Promise.all([
      api.get<Record<string, SettingMeta>>("/api/admin/settings"),
      api.get<UserData[]>("/api/admin/users"),
      api.get<CaInfo>("/api/admin/ca/info").catch(() => null),
      api.get<SystemInfo>("/api/admin/system").catch(() => null),
    ])
      .then(([s, u, ca, sys]) => {
        setSettings(s);
        const vals: Record<string, string> = {};
        for (const [key, meta] of Object.entries(s)) vals[key] = meta.value;
        setEditValues(vals);
        setUsers(u);
        setCaInfo(ca);
        setSystemInfo(sys);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveSetting = async (key: string) => {
    setSaving(key);
    try {
      await api.put(`/api/admin/settings/${key}`, { value: editValues[key] });

      // Reload all settings from backend to ensure consistency
      const freshSettings = await api.get<Record<string, SettingMeta>>("/api/admin/settings");
      setSettings(freshSettings);
      const vals: Record<string, string> = {};
      for (const [k, meta] of Object.entries(freshSettings)) vals[k] = meta.value;
      setEditValues(vals);
    } catch {
      // revert
      setEditValues((prev) => ({ ...prev, [key]: settings[key]?.value || "" }));
    } finally {
      setSaving(null);
    }
  };

  const resetSetting = async (key: string) => {
    setSaving(key);
    try {
      const result = await api.post<{ value: string }>(`/api/admin/settings/reset/${key}`, {});
      setEditValues((prev) => ({ ...prev, [key]: result.value }));
      setSettings((prev) => ({
        ...prev,
        [key]: { ...prev[key], value: result.value, is_default: true },
      }));
    } catch {
      // ignore
    } finally {
      setSaving(null);
    }
  };

  const updateUserRole = async (userId: string, role: string) => {
    try {
      await api.patch(`/api/admin/users/${userId}`, { role });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role } : u))
      );
    } catch {
      // ignore
    }
  };

  const toggleUserActive = async (userId: string, isActive: boolean) => {
    try {
      await api.patch(`/api/admin/users/${userId}`, { is_active: isActive });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, is_active: isActive } : u))
      );
    } catch {
      // ignore
    }
  };

  const deleteUser = async (userId: string) => {
    if (!confirm("Supprimer cet utilisateur ?")) return;
    try {
      await api.delete(`/api/admin/users/${userId}`);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch {
      // ignore
    }
  };

  // IP allowlist helpers
  const getIpList = (): string[] => {
    const raw = editValues["ip_allowlist"] || "[]";
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      try {
        const parsed = JSON.parse(JSON.parse(raw));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  };

  const addIp = () => {
    if (!newIp.trim()) return;
    const list = getIpList();
    if (!list.includes(newIp.trim())) {
      const updated = JSON.stringify([...list, newIp.trim()]);
      setEditValues((prev) => ({ ...prev, ip_allowlist: updated }));
    }
    setNewIp("");
  };

  const removeIp = (ip: string) => {
    const updated = JSON.stringify(getIpList().filter((i) => i !== ip));
    setEditValues((prev) => ({ ...prev, ip_allowlist: updated }));
  };

  // Command filter helpers
  const getPatterns = (): string[] => {
    const raw = editValues["command_blocklist"] || "[]";
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Might be double-encoded JSON string
      try {
        const parsed = JSON.parse(JSON.parse(raw));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
  };

  const addPattern = () => {
    if (!newPattern.trim()) return;
    const list = getPatterns();
    if (!list.includes(newPattern.trim())) {
      const updated = JSON.stringify([...list, newPattern.trim()]);
      setEditValues((prev) => ({ ...prev, command_blocklist: updated }));
    }
    setNewPattern("");
  };

  const removePattern = (pattern: string) => {
    const updated = JSON.stringify(getPatterns().filter((p) => p !== pattern));
    setEditValues((prev) => ({ ...prev, command_blocklist: updated }));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tabs: { id: Tab; icon: typeof SettingsIcon; label: string }[] = [
    { id: "security", icon: Shield, label: "Sécurité" },
    { id: "commands", icon: Terminal, label: "Commandes" },
    { id: "network", icon: Globe, label: "Réseau" },
    { id: "ca", icon: Key, label: "Certificats" },
    { id: "users", icon: Users, label: "Utilisateurs" },
    { id: "system", icon: Info, label: "Système" },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderSettingRow = (key: string, type: "number" | "bool" | "text" = "text") => {
    const meta = settings[key];
    if (!meta) return null;

    return (
      <div className="flex items-center justify-between py-3 border-b last:border-0">
        <div className="flex-1 min-w-0 mr-4">
          <p className="text-sm font-medium">{key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</p>
          <p className="text-xs text-muted-foreground">{meta.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {type === "bool" ? (
            <button
              onClick={() => {
                const newVal = editValues[key] === "true" ? "false" : "true";
                setEditValues((prev) => ({ ...prev, [key]: newVal }));
              }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                editValues[key] === "true"
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {editValues[key] === "true" ? "Activé" : "Désactivé"}
            </button>
          ) : type === "number" ? (
            <input
              type="number"
              value={editValues[key] || ""}
              onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
              className="w-24 px-2 py-1 rounded border bg-background text-sm text-right focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <input
              type="text"
              value={editValues[key] || ""}
              onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
              className="w-48 px-2 py-1 rounded border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
          {editValues[key] !== meta.value && (
            <button
              onClick={() => saveSetting(key)}
              disabled={saving === key}
              className="p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
              title="Enregistrer"
            >
              {saving === key ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            </button>
          )}
          {!meta.is_default && (
            <button
              onClick={() => resetSetting(key)}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground"
              title="Réinitialiser"
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Paramètres</h2>

      <div className="flex gap-6">
        {/* Sidebar tabs */}
        <div className="w-48 shrink-0 space-y-1">
          {tabs.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                activeTab === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1">
          {/* Security */}
          {activeTab === "security" && (
            <div className="bg-card border rounded-lg p-6">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <Shield size={18} /> Sécurité
              </h3>
              {renderSettingRow("idle_timeout_minutes", "number")}
              {renderSettingRow("rate_limit_requests", "number")}
              {renderSettingRow("rate_limit_window_seconds", "number")}
              {renderSettingRow("mfa_required_for_terminal", "bool")}
              {renderSettingRow("session_recording_enabled", "bool")}
              {renderSettingRow("max_session_recordings", "number")}
            </div>
          )}

          {/* Commands */}
          {activeTab === "commands" && (
            <div className="space-y-4">
              <div className="bg-card border rounded-lg p-6">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Terminal size={18} /> Filtrage de commandes
                </h3>
                {renderSettingRow("command_filter_enabled", "bool")}
              </div>

              <div className="bg-card border rounded-lg p-6">
                <h3 className="font-semibold mb-2">Patterns bloqués (regex)</h3>
                <p className="text-xs text-muted-foreground mb-4">
                  Les commandes correspondant à ces patterns seront bloquées sur le endpoint /execute.
                </p>

                <div className="space-y-2 mb-4">
                  {getPatterns().map((pattern, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/50">
                      <code className="flex-1 text-xs font-mono break-all">{pattern}</code>
                      <button
                        onClick={() => removePattern(pattern)}
                        className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 shrink-0"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newPattern}
                    onChange={(e) => setNewPattern(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPattern()}
                    placeholder="Nouveau pattern regex..."
                    className="flex-1 px-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={addPattern}
                    className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
                  >
                    <Plus size={16} />
                  </button>
                </div>

                {editValues["command_blocklist"] !== settings["command_blocklist"]?.value && (
                  <button
                    onClick={() => saveSetting("command_blocklist")}
                    disabled={saving === "command_blocklist"}
                    className="mt-4 flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                  >
                    {saving === "command_blocklist" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    Enregistrer les patterns
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Network */}
          {activeTab === "network" && (
            <div className="bg-card border rounded-lg p-6">
              <h3 className="font-semibold mb-2 flex items-center gap-2">
                <Globe size={18} /> IP Allowlist
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                Si la liste est vide, toutes les IPs sont autorisées. Sinon, seules les IPs listées peuvent accéder à l'application.
              </p>

              <div className="space-y-2 mb-4">
                {getIpList().length === 0 && (
                  <div className="p-3 rounded bg-green-50 text-green-700 text-sm flex items-center gap-2">
                    <Check size={16} />
                    Toutes les IPs sont autorisées (pas de restriction)
                  </div>
                )}
                {getIpList().map((ip) => (
                  <div key={ip} className="flex items-center gap-2 p-2 rounded bg-muted/50">
                    <Globe size={14} className="text-muted-foreground shrink-0" />
                    <span className="flex-1 text-sm font-mono">{ip}</span>
                    <button
                      onClick={() => removeIp(ip)}
                      className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newIp}
                  onChange={(e) => setNewIp(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addIp()}
                  placeholder="192.168.1.0/24 ou 10.0.0.5"
                  className="flex-1 px-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={addIp}
                  className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
                >
                  <Plus size={16} />
                </button>
              </div>

              {editValues["ip_allowlist"] !== settings["ip_allowlist"]?.value && (
                <button
                  onClick={() => saveSetting("ip_allowlist")}
                  disabled={saving === "ip_allowlist"}
                  className="mt-4 flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  {saving === "ip_allowlist" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Enregistrer
                </button>
              )}
            </div>
          )}

          {/* CA */}
          {activeTab === "ca" && (
            <div className="space-y-4">
              <div className="bg-card border rounded-lg p-6">
                <h3 className="font-semibold mb-4 flex items-center gap-2">
                  <Key size={18} /> Certificats éphémères
                </h3>
                {renderSettingRow("default_cert_validity_minutes", "number")}
                {renderSettingRow("min_cert_validity_minutes", "number")}
                {renderSettingRow("max_cert_validity_minutes", "number")}
              </div>

              {caInfo && (
                <div className="bg-card border rounded-lg p-6">
                  <h3 className="font-semibold mb-4">Autorité de Certification (CA)</h3>
                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground mb-1">Algorithme</dt>
                      <dd className="font-mono">{caInfo.algorithm}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground mb-1">Chemin</dt>
                      <dd className="font-mono text-xs">{caInfo.key_path}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground mb-1">Clé publique CA</dt>
                      <dd className="relative">
                        <pre className="p-3 rounded bg-muted text-xs font-mono break-all whitespace-pre-wrap">
                          {caInfo.public_key}
                        </pre>
                        <button
                          onClick={() => copyToClipboard(caInfo.public_key)}
                          className="absolute top-2 right-2 p-1.5 rounded bg-background border hover:bg-accent"
                          title="Copier"
                        >
                          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                        </button>
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 p-3 rounded bg-amber-50 border border-amber-200 text-sm">
                    <p className="font-medium text-amber-800 flex items-center gap-1 mb-1">
                      <AlertTriangle size={14} /> Setup serveur cible
                    </p>
                    <pre className="text-xs text-amber-700 whitespace-pre-wrap">
{`echo '${caInfo.public_key}' | sudo tee /etc/ssh/Citadel_ca.pub
echo 'TrustedUserCAKeys /etc/ssh/Citadel_ca.pub' | sudo tee -a /etc/ssh/sshd_config
sudo systemctl restart sshd`}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Users */}
          {activeTab === "users" && (
            <div className="bg-card border rounded-lg overflow-hidden">
              <div className="p-4 border-b">
                <h3 className="font-semibold flex items-center gap-2">
                  <Users size={18} /> Utilisateurs ({users.length})
                </h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Nom</th>
                    <th className="text-left p-3 font-medium">Email</th>
                    <th className="text-left p-3 font-medium">Rôle</th>
                    <th className="text-left p-3 font-medium">Actif</th>
                    <th className="text-left p-3 font-medium">Dernier login</th>
                    <th className="text-right p-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b">
                      <td className="p-3 font-medium">{u.display_name}</td>
                      <td className="p-3 text-muted-foreground text-xs">{u.email || "—"}</td>
                      <td className="p-3">
                        <select
                          value={u.role}
                          onChange={(e) => updateUserRole(u.id, e.target.value)}
                          className="px-2 py-1 rounded border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="ADMIN">Admin</option>
                          <option value="OPERATOR">Operator</option>
                          <option value="VIEWER">Viewer</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <button
                          onClick={() => toggleUserActive(u.id, !u.is_active)}
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            u.is_active
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {u.is_active ? "Oui" : "Non"}
                        </button>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {u.last_login
                          ? new Date(u.last_login).toLocaleString("fr-FR")
                          : "Jamais"}
                      </td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => deleteUser(u.id)}
                          className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600"
                          title="Supprimer"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* System */}
          {activeTab === "system" && systemInfo && (
            <div className="bg-card border rounded-lg p-6">
              <h3 className="font-semibold mb-4 flex items-center gap-2">
                <Info size={18} /> Système
              </h3>
              <dl className="space-y-3 text-sm">
                {[
                  ["Version", systemInfo.version],
                  ["Serveurs", systemInfo.servers],
                  ["Utilisateurs", systemInfo.users],
                  ["Sessions enregistrées", systemInfo.sessions],
                  ["Entrées d'audit", systemInfo.audit_entries],
                  ["Règles d'alerte", systemInfo.alert_rules],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex justify-between py-2 border-b last:border-0">
                    <dt className="text-muted-foreground">{String(label)}</dt>
                    <dd className="font-mono font-medium">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
