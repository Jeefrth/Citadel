import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { CustomRoleData } from "@/services/types";
import MaskingPanel from "@/components/settings/MaskingPanel";
import BackupsPanel from "@/components/settings/BackupsPanel";
import ApplicationsPanel from "@/components/settings/ApplicationsPanel";
import RolesPanel from "@/components/settings/RolesPanel";
import MembersPanel from "@/components/settings/MembersPanel";
import { api } from "@/services/api";
import SecretsVaultCard from "@/components/SecretsVaultCard";
import NotificationChannelsPanel from "@/components/NotificationChannels";
import RecordingStorageCard from "@/components/RecordingStorageCard";
import SiemTargetsPanel from "@/components/SiemTargets";
import {
  Settings as SettingsIcon,
  Shield,
  Key,
  Users,
  Terminal,
  Globe,
  Save,
  RotateCcw,
  Loader2,
  Plus,
  X,
  Copy,
  Check,
  Info,
  Vault,
  Bell,
  FileSearch,
  Archive,
  EyeOff,
  DatabaseBackup,
  AppWindow,
  UserCog,
  ShieldAlert,
} from "lucide-react";
import { PageHeader, Tabs } from "@/components/kit";
import { FactRow, SettingsCard, Tip } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/** Readable labels for the known setting keys (fallback: the key in sentence case). */
const SETTING_LABELS: Record<string, string> = {
  idle_timeout_minutes: "Délai d'inactivité (minutes)",
  rate_limit_requests: "Limite de requêtes",
  rate_limit_window_seconds: "Fenêtre de la limite (secondes)",
  mfa_required_for_terminal: "MFA obligatoire pour le terminal",
  session_recording_enabled: "Enregistrement des sessions",
  max_session_recordings: "Nombre maximal d'enregistrements",
  command_filter_enabled: "Filtrage des commandes",
  default_cert_validity_minutes: "Validité par défaut (minutes)",
  min_cert_validity_minutes: "Validité minimale (minutes)",
  max_cert_validity_minutes: "Validité maximale (minutes)",
  recording_retention_days: "Rétention des enregistrements (jours)",
  command_log_retention_days: "Rétention du journal des commandes (jours)",
  notify_user_on_monitor: "Prévenir l'utilisateur observé",
  access_expiry_notice_days: "Rappel avant la fin d'une règle d'accès (jours)",
  risk_secret_max_age_days: "Âge maximal d'un mot de passe géré (jours)",
  risk_dormant_days: "Utilisateur inactif après (jours)",
};

function settingLabel(key: string): string {
  if (SETTING_LABELS[key]) return SETTING_LABELS[key];
  const t = key.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

interface SettingMeta {
  key: string;
  value: string;
  description: string;
  is_default: boolean;
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

type Tab =
  | "security"
  | "commands"
  | "masking"
  | "network"
  | "ca"
  | "vault"
  | "backups"
  | "applications"
  | "notifications"
  | "audit"
  | "users"
  | "roles"
  | "system";
const TAB_IDS: Tab[] = [
  "security", "commands", "masking", "network", "ca", "vault", "backups",
  "applications", "notifications", "audit", "users", "roles", "system",
];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const activeTab: Tab = TAB_IDS.find((t) => t === params.get("tab")) ?? "security";
  const setActiveTab = (t: Tab) => setParams(t === "security" ? {} : { tab: t }, { replace: true });
  const [customRoles, setCustomRoles] = useState<CustomRoleData[]>([]);
  const [settings, setSettings] = useState<Record<string, SettingMeta>>({});
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
      api.get<CaInfo>("/api/admin/ca/info").catch(() => null),
      api.get<SystemInfo>("/api/admin/system").catch(() => null),
    ])
      .then(([s, ca, sys]) => {
        setSettings(s);
        const vals: Record<string, string> = {};
        for (const [key, meta] of Object.entries(s)) vals[key] = meta.value;
        setEditValues(vals);
        setCaInfo(ca);
        setSystemInfo(sys);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadCustomRoles = useCallback(() => {
    api.get<CustomRoleData[]>("/api/custom-roles").then(setCustomRoles).catch(() => {});
  }, []);
  useEffect(() => {
    loadCustomRoles();
  }, [loadCustomRoles]);

  /** Re-read every setting (after a panel saved one of them). */
  const reloadSettings = useCallback(async () => {
    const fresh = await api.get<Record<string, SettingMeta>>("/api/admin/settings").catch(() => null);
    if (!fresh) return;
    setSettings(fresh);
    setEditValues((prev) => {
      const vals = { ...prev };
      for (const [k, meta] of Object.entries(fresh)) vals[k] = meta.value;
      return vals;
    });
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
    { id: "masking", icon: EyeOff, label: "Masquage" },
    { id: "network", icon: Globe, label: "Réseau" },
    { id: "ca", icon: Key, label: "Certificats" },
    { id: "vault", icon: Vault, label: "Coffre de secrets" },
    { id: "backups", icon: DatabaseBackup, label: "Sauvegardes" },
    { id: "applications", icon: AppWindow, label: "Applications" },
    { id: "notifications", icon: Bell, label: "Notifications" },
    { id: "audit", icon: FileSearch, label: "Audit" },
    { id: "users", icon: Users, label: "Membres" },
    { id: "roles", icon: UserCog, label: "Rôles" },
    { id: "system", icon: Info, label: "Système" },
  ];

  if (loading) {
    return (
      <div>
        <PageHeader title="Paramètres" description="Sécurité, masquage, réseau, certificats, coffre, sauvegardes, applications, notifications, audit, membres et rôles." />
        <div className="mb-6 flex gap-4 border-b pb-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-20" />
          ))}
        </div>
        <div className="space-y-3 rounded-lg border p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
              <Skeleton className="h-8 w-24" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const renderSettingRow = (key: string, type: "number" | "bool" | "text" = "text") => {
    const meta = settings[key];
    if (!meta) return null;
    const dirty = editValues[key] !== meta.value;

    return (
      <div key={key} className="flex items-center justify-between gap-4 border-b py-3 first:pt-0 last:border-0 last:pb-0">
        <div className="min-w-0 flex-1">
          <label htmlFor={`setting-${key}`} className="text-sm font-medium">
            {settingLabel(key)}
          </label>
          <p className="text-xs text-muted-foreground">{meta.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {type === "bool" ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{editValues[key] === "true" ? "Activé" : "Désactivé"}</span>
              <Switch
                id={`setting-${key}`}
                checked={editValues[key] === "true"}
                onCheckedChange={(v) => setEditValues((prev) => ({ ...prev, [key]: v ? "true" : "false" }))}
              />
            </div>
          ) : type === "number" ? (
            <Input
              id={`setting-${key}`}
              type="number"
              value={editValues[key] || ""}
              onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
              className="tabular h-8 w-24 text-right"
            />
          ) : (
            <Input
              id={`setting-${key}`}
              type="text"
              value={editValues[key] || ""}
              onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
              className="h-8 w-48"
            />
          )}
          <div className="flex w-[4.25rem] items-center justify-end gap-1">
            {dirty && (
              <Tip content="Enregistrer">
                <Button size="icon" className="size-8" onClick={() => saveSetting(key)} disabled={saving === key} aria-label="Enregistrer">
                  {saving === key ? <Loader2 className="animate-spin" /> : <Save />}
                </Button>
              </Tip>
            )}
            {!meta.is_default && (
              <Tip content="Revenir à la valeur par défaut">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground"
                  onClick={() => resetSetting(key)}
                  aria-label="Réinitialiser"
                >
                  <RotateCcw />
                </Button>
              </Tip>
            )}
          </div>
        </div>
      </div>
    );
  };

  /** Removable list row (blocked pattern, allowed IP). */
  const listRow = (value: string, onRemove: () => void, icon?: ReactNode) => (
    <div key={value} className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
      {icon}
      <code className="flex-1 break-all font-mono text-xs">{value}</code>
      <Tip content="Retirer">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:bg-danger/10 hover:text-danger"
          onClick={onRemove}
          aria-label="Retirer"
        >
          <X />
        </Button>
      </Tip>
    </div>
  );

  return (
    <div>
      <PageHeader title="Paramètres" description="Sécurité, masquage, réseau, certificats, coffre, sauvegardes, applications, notifications, audit, membres et rôles." />

      <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="max-w-4xl space-y-4">
        {activeTab === "security" && (
          <SettingsCard icon={Shield} title="Sécurité" description="Inactivité, limitation de débit, MFA et enregistrement des sessions.">
            {renderSettingRow("idle_timeout_minutes", "number")}
            {renderSettingRow("rate_limit_requests", "number")}
            {renderSettingRow("rate_limit_window_seconds", "number")}
            {renderSettingRow("mfa_required_for_terminal", "bool")}
            {renderSettingRow("session_recording_enabled", "bool")}
            {renderSettingRow("max_session_recordings", "number")}
          </SettingsCard>
        )}

        {activeTab === "commands" && (
          <>
            <SettingsCard icon={Terminal} title="Filtrage des commandes">
              {renderSettingRow("command_filter_enabled", "bool")}
            </SettingsCard>

            <SettingsCard
              title="Motifs bloqués (regex)"
              description="Les commandes qui correspondent à ces motifs sont bloquées sur l'exécution (/execute)."
            >
              <div className="space-y-3">
                {getPatterns().length === 0 && <p className="text-sm text-muted-foreground">Aucun motif bloqué.</p>}
                <div className="space-y-1.5">{getPatterns().map((pattern) => listRow(pattern, () => removePattern(pattern)))}</div>
                <div className="flex gap-2">
                  <Input
                    value={newPattern}
                    onChange={(e) => setNewPattern(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPattern()}
                    placeholder="Nouveau motif, ex. rm\s+-rf"
                    className="font-mono"
                  />
                  <Button variant="outline" onClick={addPattern} disabled={!newPattern.trim()}>
                    <Plus /> Ajouter
                  </Button>
                </div>
                {editValues["command_blocklist"] !== settings["command_blocklist"]?.value && (
                  <Button onClick={() => saveSetting("command_blocklist")} disabled={saving === "command_blocklist"}>
                    {saving === "command_blocklist" ? <Loader2 className="animate-spin" /> : <Save />}
                    Enregistrer les motifs
                  </Button>
                )}
              </div>
            </SettingsCard>
          </>
        )}

        {activeTab === "network" && (
          <SettingsCard
            icon={Globe}
            title="Adresses IP autorisées"
            description="Liste vide : toutes les adresses sont autorisées. Sinon, seules les adresses et plages listées accèdent à l'application."
          >
            <div className="space-y-3">
              {getIpList().length === 0 && (
                <div className="flex items-center gap-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm text-success">
                  <Check className="size-4" />
                  Aucune restriction : toutes les adresses IP sont autorisées.
                </div>
              )}
              <div className="space-y-1.5">
                {getIpList().map((ip) =>
                  listRow(ip, () => removeIp(ip), <Globe className="size-3.5 shrink-0 text-muted-foreground" />),
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newIp}
                  onChange={(e) => setNewIp(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addIp()}
                  placeholder="192.168.1.0/24 ou 10.0.0.5"
                  className="font-mono"
                />
                <Button variant="outline" onClick={addIp} disabled={!newIp.trim()}>
                  <Plus /> Ajouter
                </Button>
              </div>
              {editValues["ip_allowlist"] !== settings["ip_allowlist"]?.value && (
                <Button onClick={() => saveSetting("ip_allowlist")} disabled={saving === "ip_allowlist"}>
                  {saving === "ip_allowlist" ? <Loader2 className="animate-spin" /> : <Save />}
                  Enregistrer la liste
                </Button>
              )}
            </div>
          </SettingsCard>
        )}

        {activeTab === "ca" && (
          <>
            <SettingsCard icon={Key} title="Certificats éphémères" description="Durée de validité des certificats SSH signés à la demande.">
              {renderSettingRow("default_cert_validity_minutes", "number")}
              {renderSettingRow("min_cert_validity_minutes", "number")}
              {renderSettingRow("max_cert_validity_minutes", "number")}
            </SettingsCard>

            {caInfo && (
              <SettingsCard title="Autorité de certification" description="Clé publique à déclarer sur chaque serveur cible.">
                <div className="space-y-4">
                  <dl>
                    <FactRow label="Algorithme">
                      <span className="font-mono">{caInfo.algorithm}</span>
                    </FactRow>
                    <FactRow label="Chemin de la clé">
                      <span className="break-all font-mono text-xs">{caInfo.key_path}</span>
                    </FactRow>
                  </dl>
                  <div className="space-y-1.5">
                    <p className="text-sm text-muted-foreground">Clé publique</p>
                    <div className="relative">
                      <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 pr-12 font-mono text-xs">
                        {caInfo.public_key}
                      </pre>
                      <Tip content={copied ? "Copiée" : "Copier la clé"}>
                        <Button
                          variant="outline"
                          size="icon"
                          className="absolute right-2 top-2 size-7"
                          onClick={() => copyToClipboard(caInfo.public_key)}
                          aria-label="Copier"
                        >
                          {copied ? <Check className="text-success" /> : <Copy />}
                        </Button>
                      </Tip>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Info className="size-3.5" /> Configuration du serveur cible
                    </p>
                    <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs">
{`echo '${caInfo.public_key}' | sudo tee /etc/ssh/Citadel_ca.pub
echo 'TrustedUserCAKeys /etc/ssh/Citadel_ca.pub' | sudo tee -a /etc/ssh/sshd_config
sudo systemctl restart sshd`}
                    </pre>
                  </div>
                </div>
              </SettingsCard>
            )}
          </>
        )}

        {activeTab === "vault" && <SecretsVaultCard />}

        {activeTab === "masking" && <MaskingPanel value={settings["data_masking_rules"]?.value} onSaved={reloadSettings} />}

        {activeTab === "backups" && <BackupsPanel settings={settings} onSettingsSaved={reloadSettings} />}

        {activeTab === "applications" && <ApplicationsPanel />}

        {activeTab === "roles" && <RolesPanel onChanged={loadCustomRoles} />}

        {activeTab === "notifications" && (
          <>
            <SettingsCard icon={Bell} title="Rappels" description="Prévenir avant la fin d'un accès accordé.">
              {renderSettingRow("access_expiry_notice_days", "number")}
            </SettingsCard>
            <NotificationChannelsPanel />
          </>
        )}

        {/* Audit: recording storage, retention, SIEM export */}
        {activeTab === "audit" && (
          <>
            <RecordingStorageCard />
            <SettingsCard
              icon={Archive}
              title="Rétention et surveillance"
              description="Durées de conservation en jours (0 : conservation illimitée). La purge est automatique et journalisée."
            >
              {renderSettingRow("recording_retention_days", "number")}
              {renderSettingRow("command_log_retention_days", "number")}
              {renderSettingRow("notify_user_on_monitor", "bool")}
            </SettingsCard>
            <SettingsCard
              icon={ShieldAlert}
              title="Détection des risques"
              description="Seuils de l'analyse quotidienne (Audit > Risques)."
            >
              {renderSettingRow("risk_secret_max_age_days", "number")}
              {renderSettingRow("risk_dormant_days", "number")}
            </SettingsCard>
            <SiemTargetsPanel />
          </>
        )}

        {activeTab === "users" && <MembersPanel customRoles={customRoles} onChanged={loadCustomRoles} />}

        {activeTab === "system" && systemInfo && (
          <SettingsCard icon={Info} title="Système">
            <dl>
              {[
                ["Version", systemInfo.version],
                ["Serveurs", systemInfo.servers],
                ["Utilisateurs", systemInfo.users],
                ["Sessions enregistrées", systemInfo.sessions],
                ["Entrées d'audit", systemInfo.audit_entries],
                ["Règles d'alerte", systemInfo.alert_rules],
              ].map(([label, value]) => (
                <FactRow key={String(label)} label={String(label)}>
                  <span className="tabular font-mono font-medium">{String(value)}</span>
                </FactRow>
              ))}
            </dl>
          </SettingsCard>
        )}
      </div>

    </div>
  );
}
