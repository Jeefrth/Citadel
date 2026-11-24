import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  hasAction,
  isReviewMessage,
  type CredentialData,
  type NodeData,
  type OSType,
  type ServerData,
  type ZoneData,
} from "@/services/types";
import { ServerOriginChips } from "@/components/opsUi";
import NodeTree from "@/components/NodeTree";
import { GovernanceNotice } from "@/components/governanceUi";
import { AuthModePicker, CheckField, RowAction } from "@/components/AccountsSection";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  LabelChips,
  LabelEditor,
  Modal,
  Notice,
  PageHeader,
  SaveButton,
  type NoticeData,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Server,
  Plus,
  Wifi,
  Loader2,
  Info,
  Play,
  X,
  Key,
  Trash2,
  Pencil,
  Star,
  Search,
  Monitor,
  Terminal as TerminalIcon,
  Tag,
  ShieldCheck,
} from "lucide-react";

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

// ── Server add / edit form ─────────────────────────────────

interface ServerFormState {
  name: string;
  hostname: string;
  ip_address: string;
  os_type: OSType;
  os_version: string;
  ssh_port: number;
  winrm_port: number;
  rdp_port: number;
  node_id: string;
  zone_id: string;
  tags: Record<string, string>;
  // Creation only: optional default account
  with_account: boolean;
  acc_username: string;
  acc_mode: "credential" | "cert";
  acc_credential_id: string;
  acc_privileged: boolean;
}

const emptyForm = (nodeId: string | null): ServerFormState => ({
  name: "",
  hostname: "",
  ip_address: "",
  os_type: "linux",
  os_version: "",
  ssh_port: 22,
  winrm_port: 5985,
  rdp_port: 3389,
  node_id: nodeId || "",
  zone_id: "",
  tags: {},
  with_account: false,
  acc_username: "",
  acc_mode: "credential",
  acc_credential_id: "",
  acc_privileged: true,
});

const ROOT_NODE = "__root__";
const NO_ZONE = "__direct__";

function NodeSelect({
  nodes,
  value,
  onChange,
  exclude,
}: {
  nodes: NodeData[];
  value: string;
  onChange: (v: string) => void;
  exclude?: string;
}) {
  return (
    <Select value={value || ROOT_NODE} onValueChange={(v) => onChange(v === ROOT_NODE ? "" : v)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ROOT_NODE}>Racine (aucun nœud)</SelectItem>
        {nodes
          .filter((n) => !exclude || (n.id !== exclude && !n.path.startsWith(pathOf(nodes, exclude) + "/")))
          .map((n) => (
            <SelectItem key={n.id} value={n.id}>
              {n.path}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function pathOf(nodes: NodeData[], id: string): string {
  return nodes.find((n) => n.id === id)?.path || "\u0000";
}

function ServerFormModal({
  server,
  initialNode,
  nodes,
  zones,
  credentials,
  labelSuggestions,
  onClose,
  onSaved,
}: {
  server: ServerData | null; // null = creation
  initialNode: string | null;
  nodes: NodeData[];
  zones: ZoneData[];
  credentials: CredentialData[];
  labelSuggestions: Record<string, string[]>;
  onClose: () => void;
  onSaved: (srv: ServerData) => void;
}) {
  const [form, setForm] = useState<ServerFormState>(() =>
    server
      ? {
          ...emptyForm(null),
          name: server.name,
          hostname: server.hostname,
          ip_address: server.ip_address,
          os_type: server.os_type,
          os_version: server.os_version || "",
          ssh_port: server.ssh_port,
          winrm_port: server.winrm_port,
          rdp_port: server.rdp_port,
          node_id: server.node_id || "",
          zone_id: server.zone_id || "",
          tags: { ...(server.tags || {}) },
        }
      : emptyForm(initialNode)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ServerFormState>) => setForm((f) => ({ ...f, ...patch }));

  const accountValid =
    !form.with_account ||
    (form.acc_username.trim() !== "" &&
      (form.acc_mode === "cert" ? form.os_type === "linux" : form.acc_credential_id !== ""));
  const valid = form.name && form.hostname && form.ip_address && accountValid;

  const save = async () => {
    setLoading(true);
    setError(null);
    const body: Record<string, unknown> = {
      name: form.name,
      hostname: form.hostname,
      ip_address: form.ip_address,
      os_type: form.os_type,
      os_version: form.os_version || null,
      ssh_port: form.ssh_port,
      winrm_port: form.winrm_port,
      rdp_port: form.rdp_port,
      node_id: form.node_id || null,
      zone_id: form.zone_id || null,
      tags: form.tags,
    };
    if (!server && form.with_account) {
      body.default_account = {
        username: form.acc_username.trim(),
        credential_id: form.acc_mode === "credential" ? form.acc_credential_id : null,
        use_cert: form.acc_mode === "cert",
        privileged: form.acc_privileged,
      };
    }
    try {
      const saved = server
        ? await api.patch<ServerData>(`/api/servers/${server.id}`, body)
        : await api.post<ServerData>("/api/servers/", body);
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={server ? `Modifier ${server.name}` : "Ajouter un serveur"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {server ? "Enregistrer" : "Ajouter le serveur"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Nom *">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="web-prod-01" />
          </Field>
        </div>
        <Field label="Nom d'hôte *">
          <Input
            value={form.hostname}
            onChange={(e) => set({ hostname: e.target.value })}
            placeholder="web-prod-01.local"
            className="font-mono"
          />
        </Field>
        <Field label="Adresse IP *">
          <Input
            value={form.ip_address}
            onChange={(e) => set({ ip_address: e.target.value })}
            placeholder="192.168.1.10"
            className="font-mono"
          />
        </Field>
        <Field label="Système *">
          <Select
            value={form.os_type}
            onValueChange={(v) => {
              const os = v as OSType;
              set({ os_type: os, acc_mode: os === "windows" ? "credential" : form.acc_mode });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="linux">Linux</SelectItem>
              <SelectItem value="windows">Windows</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Version du système">
          <Input
            value={form.os_version}
            onChange={(e) => set({ os_version: e.target.value })}
            placeholder={form.os_type === "linux" ? "Ubuntu 22.04" : "Windows Server 2022"}
          />
        </Field>
        {form.os_type === "linux" ? (
          <Field label="Port SSH">
            <Input
              type="number"
              value={form.ssh_port}
              onChange={(e) => set({ ssh_port: parseInt(e.target.value) || 22 })}
              className="tabular font-mono"
            />
          </Field>
        ) : (
          <>
            <Field label="Port WinRM">
              <Input
                type="number"
                value={form.winrm_port}
                onChange={(e) => set({ winrm_port: parseInt(e.target.value) || 5985 })}
                className="tabular font-mono"
              />
            </Field>
            <Field label="Port RDP">
              <Input
                type="number"
                value={form.rdp_port}
                onChange={(e) => set({ rdp_port: parseInt(e.target.value) || 3389 })}
                className="tabular font-mono"
              />
            </Field>
          </>
        )}
        <div className={form.os_type === "linux" ? "" : "col-span-2"}>
          <Field label="Nœud">
            <NodeSelect nodes={nodes} value={form.node_id} onChange={(v) => set({ node_id: v })} />
          </Field>
        </div>
        <div className={form.os_type === "linux" ? "" : "col-span-2"}>
          <Field
            label="Zone réseau"
            hint="Sans zone, Citadel joint le serveur directement. Avec une zone, tout passe par ses passerelles SSH."
          >
            <Select value={form.zone_id || NO_ZONE} onValueChange={(v) => set({ zone_id: v === NO_ZONE ? "" : v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ZONE}>Aucune (accès direct)</SelectItem>
                {zones.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.name}
                    <span className="text-muted-foreground">
                      {" "}
                      ({z.gateways.length} passerelle{z.gateways.length > 1 ? "s" : ""})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="col-span-2">
          <Field
            label="Étiquettes"
            hint="Paires clé=valeur (ex. env=prod, app=web). Utilisées pour filtrer et dans les règles d'accès."
          >
            <LabelEditor value={form.tags} onChange={(tags) => set({ tags })} suggestions={labelSuggestions} />
          </Field>
        </div>
      </div>

      {!server && (
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-1">
            <CheckField
              checked={form.with_account}
              onChange={(v) => set({ with_account: v })}
              label={<span className="font-medium">Créer un compte par défaut</span>}
            />
            <p className="pl-6 text-xs text-muted-foreground">
              Le compte par défaut sert à l'automatisation (test de connexion, métriques, mises à jour,
              commandes). Ajoutez d'autres comptes depuis la fiche du serveur.
            </p>
          </div>
          {form.with_account && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Utilisateur *">
                <Input
                  value={form.acc_username}
                  onChange={(e) => set({ acc_username: e.target.value })}
                  placeholder={form.os_type === "linux" ? "root" : "Administrator"}
                  className="font-mono"
                />
              </Field>
              <div className="flex items-center pt-6">
                <CheckField
                  checked={form.acc_privileged}
                  onChange={(v) => set({ acc_privileged: v })}
                  label="Compte privilégié"
                />
              </div>
              <div className="col-span-2">
                <Field label="Authentification">
                  <div className="space-y-2">
                    <AuthModePicker
                      mode={form.acc_mode}
                      onMode={(acc_mode) => set({ acc_mode })}
                      certAllowed={form.os_type === "linux"}
                      credentialId={form.acc_credential_id}
                      onCredential={(acc_credential_id) => set({ acc_credential_id })}
                      credentials={credentials}
                    />
                    {form.acc_mode === "cert" && (
                      <InfoBox>
                        Aucun secret stocké : un certificat SSH de courte durée est signé à chaque connexion. Le
                        serveur doit faire confiance à la clé de la CA (<span className="font-mono">TrustedUserCAKeys</span>{" "}
                        dans <span className="font-mono">sshd_config</span>).
                      </InfoBox>
                    )}
                  </div>
                </Field>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Neutral information block (info token). */
function InfoBox({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-xs">
      <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
      <div className="space-y-1 text-foreground">
        {title && <p className="text-sm font-medium">{title}</p>}
        <div className="text-muted-foreground">{children}</div>
      </div>
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
      className="flex rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-live"
    >
      <motion.span
        key={on ? "on" : "off"}
        initial={{ scale: 0.6, rotate: on ? -30 : 0 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 18 }}
        className="flex"
      >
        <Star className={cn("size-4", on && "fill-live text-live")} />
      </motion.span>
    </button>
  );
}

const STATUS_DOT: Record<ServerData["status"], { cls: string; label: string }> = {
  online: { cls: "bg-success", label: "En ligne" },
  offline: { cls: "bg-danger", label: "Hors ligne" },
  unknown: { cls: "bg-muted-foreground/40", label: "État inconnu" },
};

// ── Node create / edit ──────────────────────────────────────

function NodeFormModal({
  node,
  parentId,
  nodes,
  onClose,
  onSaved,
}: {
  node: NodeData | null;
  parentId: string | null;
  nodes: NodeData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(node?.name || "");
  const [description, setDescription] = useState(node?.description || "");
  const [parent, setParent] = useState(node ? node.parent_id || "" : parentId || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setLoading(true);
    setError(null);
    const body = { name: name.trim(), description: description || null, parent_id: parent || null };
    try {
      if (node) await api.patch(`/api/nodes/${node.id}`, body);
      else await api.post("/api/nodes", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={node ? `Modifier le nœud ${node.name}` : "Nouveau nœud"}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!name.trim()}>
            {node ? "Enregistrer" : "Créer le nœud"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom *">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prod" autoFocus />
      </Field>
      <Field label="Nœud parent">
        <NodeSelect nodes={nodes} value={parent} onChange={setParent} exclude={node?.id} />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default function Servers() {
  const navigate = useNavigate();
  const { isAdmin } = useCurrentUser();

  const [servers, setServers] = useState<ServerData[]>([]);
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [zones, setZones] = useState<ZoneData[]>([]);
  const [labels, setLabels] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  // Filters
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [labelFilters, setLabelFilters] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);

  // Credentials (admin)
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

  // Server form: undefined = closed, null = create, ServerData = edit
  const [formServer, setFormServer] = useState<ServerData | null | undefined>(undefined);

  // Node form
  const [nodeForm, setNodeForm] = useState<{ node: NodeData | null; parentId: string | null } | null>(null);

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
  // 403 from the execute API (rights, command / connection ACL, review)
  const [cmdDenied, setCmdDenied] = useState<string | null>(null);
  const [cmdLoading, setCmdLoading] = useState(false);

  // Confirmation of destructive actions + page-level errors
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "server"; srv: ServerData } | { kind: "node"; node: NodeData } | { kind: "cred"; cred: CredentialData } | null
  >(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [pageNotice, setPageNotice] = useState<NoticeData | null>(null);

  // System info modal
  const [infoServer, setInfoServer] = useState<ServerData | null>(null);
  const [sysInfo, setSysInfo] = useState<SystemInfoData | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadServers = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedNode) {
      params.set("node_id", selectedNode);
      params.set("recursive", "true");
    }
    labelFilters.forEach((l) => params.append("label", l));
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (favOnly) params.set("favorites", "true");
    const qs = params.toString();
    try {
      const list = await api.get<ServerData[]>(`/api/servers/${qs ? `?${qs}` : ""}`);
      setServers(list);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [selectedNode, labelFilters, debouncedSearch, favOnly]);

  const loadNodes = useCallback(() => {
    api.get<NodeData[]>("/api/nodes").then(setNodes).catch(() => {});
  }, []);

  const loadZones = useCallback(() => {
    api.get<ZoneData[]>("/api/zones").then(setZones).catch(() => {});
  }, []);

  const loadLabels = useCallback(() => {
    api.get<Record<string, string[]>>("/api/servers/labels/").then(setLabels).catch(() => {});
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  useEffect(() => {
    loadNodes();
    loadLabels();
    loadZones();
  }, [loadNodes, loadLabels, loadZones]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<CredentialData[]>("/api/servers/credentials/")
      .then(setCredentials)
      .catch(() => {});
  }, [isAdmin]);

  const refreshAll = () => {
    loadServers();
    loadNodes();
    loadLabels();
  };

  const selectedNodeData = useMemo(
    () => nodes.find((n) => n.id === selectedNode) || null,
    [nodes, selectedNode]
  );

  // ── Credentials ──

  const handleDeleteCredential = async (credId: string) => {
    setCredError(null);
    try {
      await api.delete(`/api/servers/credentials/${credId}`);
      setCredentials((prev) => prev.filter((c) => c.id !== credId));
    } catch (e) {
      const msg = errorMessage(e);
      setCredError(
        msg.toLowerCase().includes("used by")
          ? "Ce credential est utilisé par au moins un compte. Retirez-le des comptes concernés avant de le supprimer."
          : msg
      );
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
    } catch (e: unknown) {
      setCredError(errorMessage(e, "Erreur"));
    } finally {
      setCredLoading(false);
    }
  };

  const openEditCred = (cred: CredentialData) => {
    setEditCred(cred);
    setEditCredForm({ name: cred.name, username: cred.username, password: "", ssh_key: "" });
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
      const updated = await api.patch<CredentialData>(`/api/servers/credentials/${editCred.id}`, body);
      setCredentials((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditCred(null);
    } catch {
      // silently fail
    } finally {
      setEditCredLoading(false);
    }
  };

  // ── Servers ──

  const handleDeleteServer = async (srv: ServerData) => {
    try {
      await api.delete(`/api/servers/${srv.id}`);
      setServers((prev) => prev.filter((s) => s.id !== srv.id));
      loadNodes();
      loadLabels();
    } catch (e) {
      setPageNotice({ ok: false, text: errorMessage(e) });
    }
  };

  const toggleFavorite = async (srv: ServerData) => {
    const next = !srv.is_favorite;
    setServers((prev) => prev.map((s) => (s.id === srv.id ? { ...s, is_favorite: next } : s)));
    try {
      if (next) await api.put(`/api/servers/${srv.id}/favorite`, {});
      else await api.delete(`/api/servers/${srv.id}/favorite`);
      if (favOnly && !next) setServers((prev) => prev.filter((s) => s.id !== srv.id));
    } catch {
      setServers((prev) => prev.map((s) => (s.id === srv.id ? { ...s, is_favorite: !next } : s)));
    }
  };

  const handleTestConnection = async (srv: ServerData) => {
    setTestingId(srv.id);
    setTestResult(null);
    try {
      const result = await api.post<ConnectionTestResult>(`/api/servers/${srv.id}/test-connection`, {});
      setTestResult(result);
      setServers((prev) =>
        prev.map((s) => (s.id === srv.id ? { ...s, status: result.success ? "online" : "offline" } : s))
      );
    } catch (e: unknown) {
      setTestResult({
        server_id: srv.id,
        server_name: srv.name,
        success: false,
        message: errorMessage(e, "Unknown error"),
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
    setCmdDenied(null);
    try {
      const result = await api.post<CommandResult>(`/api/servers/${cmdServer.id}/execute`, {
        command: cmdInput,
        timeout: 30,
      });
      setCmdResult(result);
    } catch (e: unknown) {
      const msg = errorMessage(e, "Unknown error");
      if (isReviewMessage(msg) || /refusée par la règle/i.test(msg)) setCmdDenied(msg);
      else setCmdResult({ exit_code: -1, stdout: "", stderr: msg });
    } finally {
      setCmdLoading(false);
    }
  };

  const handleShowInfo = async (srv: ServerData) => {
    setInfoServer(srv);
    setSysInfo(null);
    setInfoLoading(true);
    try {
      setSysInfo(await api.get<SystemInfoData>(`/api/servers/${srv.id}/info`));
    } catch {
      setSysInfo(null);
    } finally {
      setInfoLoading(false);
    }
  };

  // ── Nodes ──

  const handleDeleteNode = async (node: NodeData) => {
    try {
      await api.delete(`/api/nodes/${node.id}`);
      if (selectedNode && (selectedNode === node.id || selectedNodeData?.path.startsWith(node.path + "/")))
        setSelectedNode(null);
      refreshAll();
    } catch (e) {
      setPageNotice({ ok: false, text: errorMessage(e) });
    }
  };

  const toggleLabelFilter = (sel: string) =>
    setLabelFilters((prev) => (prev.includes(sel) ? prev.filter((x) => x !== sel) : [...prev, sel]));

  const hasFilters = !!selectedNode || labelFilters.length > 0 || !!debouncedSearch || favOnly;

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleteLoading(true);
    try {
      if (pendingDelete.kind === "server") await handleDeleteServer(pendingDelete.srv);
      else if (pendingDelete.kind === "node") await handleDeleteNode(pendingDelete.node);
      else await handleDeleteCredential(pendingDelete.cred.id);
    } finally {
      setDeleteLoading(false);
      setPendingDelete(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Serveurs"
        description={
          selectedNodeData ? (
            <>
              Serveurs du nœud <span className="font-medium text-foreground">{selectedNodeData.path}</span> et de
              ses sous-nœuds.
            </>
          ) : (
            "Les serveurs auxquels vous avez accès. Ouvrez une session, testez la connexion ou lancez une commande."
          )
        }
        actions={
          isAdmin && (
            <>
              <Button variant="outline" onClick={() => setShowCredModal(true)}>
                <Key />
                Credentials
                <span className="tabular text-muted-foreground">{credentials.length}</span>
              </Button>
              <Button onClick={() => setFormServer(null)}>
                <Plus />
                Ajouter un serveur
              </Button>
            </>
          )
        }
      />

      <div className="flex items-start gap-4">
        {/* Node tree */}
        <aside className="hidden w-60 shrink-0 md:block">
          <NodeTree
            nodes={nodes}
            selected={selectedNode}
            onSelect={setSelectedNode}
            isAdmin={isAdmin}
            onCreate={(parentId) => setNodeForm({ node: null, parentId })}
            onRename={(node) => setNodeForm({ node, parentId: null })}
            onDelete={(node) => setPendingDelete({ kind: "node", node })}
          />
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          {/* Search + filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher (nom, hôte, IP)"
                className="pl-9"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => setFavOnly((v) => !v)}
              aria-pressed={favOnly}
              className={cn(favOnly && "border-live/40 bg-live/10 text-live hover:bg-live/15 hover:text-live")}
            >
              <Star className={cn(favOnly && "fill-live")} />
              Favoris
            </Button>
            <Popover open={showLabelPicker} onOpenChange={setShowLabelPicker}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  disabled={Object.keys(labels).length === 0}
                  title={Object.keys(labels).length === 0 ? "Aucune étiquette définie" : undefined}
                >
                  <Tag />
                  Étiquettes
                  {labelFilters.length > 0 && (
                    <span className="tabular rounded bg-foreground/10 px-1.5 text-xs">{labelFilters.length}</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="max-h-80 w-72 space-y-3 overflow-auto p-3">
                {Object.entries(labels).map(([key, values]) => (
                  <div key={key}>
                    <p className="mb-1 font-mono text-xs text-muted-foreground">{key}</p>
                    <div className="flex flex-wrap gap-1">
                      {values.map((v) => {
                        const sel = `${key}=${v}`;
                        const on = labelFilters.includes(sel);
                        return (
                          <button
                            key={sel}
                            onClick={() => toggleLabelFilter(sel)}
                            aria-pressed={on}
                            className={cn(
                              "h-6 rounded-md border px-2 font-mono text-xs transition-colors",
                              on ? "border-foreground bg-foreground text-background" : "hover:bg-accent",
                            )}
                          >
                            {v === "" ? "(vide)" : v}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </PopoverContent>
            </Popover>
            {labelFilters.map((l) => (
              <Chip key={l} tone="primary" onRemove={() => toggleLabelFilter(l)}>
                <span className="font-mono">{l}</span>
              </Chip>
            ))}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedNode(null);
                  setLabelFilters([]);
                  setSearch("");
                  setFavOnly(false);
                }}
                className="text-muted-foreground"
              >
                <X />
                Réinitialiser
              </Button>
            )}
            {servers.length > 0 && (
              <span className="tabular ml-auto text-xs text-muted-foreground">
                {servers.length} serveur{servers.length > 1 ? "s" : ""}
              </span>
            )}
          </div>

          <Notice notice={pageNotice} onClose={() => setPageNotice(null)} />

          {/* Test result banner */}
          <Notice
            notice={
              testResult && {
                ok: testResult.success,
                text: (
                  <span className="flex flex-wrap items-center gap-x-2">
                    <strong>{testResult.server_name}</strong>
                    <span>{testResult.message}</span>
                    {testResult.latency_ms && (
                      <span className="tabular font-mono text-xs text-muted-foreground">{testResult.latency_ms} ms</span>
                    )}
                  </span>
                ),
              }
            }
            onClose={() => setTestResult(null)}
          />

          <ErrorBox message={error} />

          {loading && (
            <div className="space-y-2 rounded-lg border bg-card p-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          )}

          {!loading && servers.length === 0 && !error && (
            <EmptyState
              icon={Server}
              title={hasFilters ? "Aucun serveur ne correspond aux filtres" : "Aucun serveur"}
              action={
                hasFilters ? undefined : isAdmin ? (
                  <Button onClick={() => setFormServer(null)}>
                    <Plus />
                    Ajouter un serveur
                  </Button>
                ) : undefined
              }
            >
              {hasFilters
                ? "Élargissez la recherche ou réinitialisez les filtres."
                : isAdmin
                  ? "Ajoutez un premier serveur pour commencer."
                  : "Aucun serveur ne vous est accessible. Demandez un accès à un administrateur."}
            </EmptyState>
          )}

          {servers.length > 0 && (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-9 pl-3" />
                    <TableHead>Serveur</TableHead>
                    <TableHead>Adresse</TableHead>
                    <TableHead>Système</TableHead>
                    <TableHead>Étiquettes</TableHead>
                    <TableHead>Compte par défaut</TableHead>
                    <TableHead className="pr-3 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {servers.map((srv) => {
                      const canConnect = hasAction(srv, "connect");
                      const canExecute = hasAction(srv, "execute");
                      const dot = STATUS_DOT[srv.status] || STATUS_DOT.unknown;
                      return (
                        <motion.tr
                          key={srv.id}
                          layout="position"
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="h-11 border-b transition-colors hover:bg-muted/50"
                        >
                          <TableCell className="pl-3">
                            <FavoriteStar on={srv.is_favorite} onToggle={() => toggleFavorite(srv)} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className={cn("size-2 shrink-0 rounded-full", dot.cls)}
                                    aria-label={dot.label}
                                    role="img"
                                  />
                                </TooltipTrigger>
                                <TooltipContent>{dot.label}</TooltipContent>
                              </Tooltip>
                              <div className="min-w-0">
                                <button
                                  onClick={() => navigate(`/servers/${srv.id}`)}
                                  className="text-left font-medium hover:underline"
                                >
                                  {srv.name}
                                </button>
                                {srv.node_path && (
                                  <p className="truncate text-xs text-muted-foreground">{srv.node_path}</p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <p className="tabular font-mono text-xs">{srv.ip_address}</p>
                            <p className="font-mono text-xs text-muted-foreground">{srv.hostname}</p>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">
                              {srv.os_type === "windows" ? "Windows" : "Linux"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              <ServerOriginChips server={srv} />
                              <LabelChips tags={srv.tags} />
                            </div>
                          </TableCell>
                          <TableCell>
                            {srv.default_account ? (
                              <span className="flex items-center gap-1.5 text-xs">
                                <span className="font-mono">{srv.default_account.username}</span>
                                {srv.default_account.auth === "cert" && (
                                  <span title="Certificat éphémère">
                                    <ShieldCheck className="size-3.5 text-info" />
                                  </span>
                                )}
                                {srv.accounts_count > 1 && (
                                  <span className="tabular text-muted-foreground">+{srv.accounts_count - 1}</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">aucun</span>
                            )}
                          </TableCell>
                          <TableCell className="pr-3 text-right">
                            <div className="flex items-center justify-end gap-0.5">
                              <RowAction
                                label={
                                  canConnect
                                    ? srv.os_type === "windows"
                                      ? "Ouvrir une session RDP"
                                      : "Ouvrir un terminal"
                                    : "Connexion non autorisée"
                                }
                                onClick={() => navigate(`/terminal?server=${srv.id}`)}
                                disabled={!canConnect}
                              >
                                {srv.os_type === "windows" ? <Monitor /> : <TerminalIcon />}
                              </RowAction>
                              <RowAction
                                label="Tester la connexion"
                                onClick={() => handleTestConnection(srv)}
                                disabled={testingId === srv.id}
                              >
                                {testingId === srv.id ? <Loader2 className="animate-spin" /> : <Wifi />}
                              </RowAction>
                              <RowAction label="Infos système" onClick={() => handleShowInfo(srv)}>
                                <Info />
                              </RowAction>
                              {canExecute && (
                                <RowAction
                                  label="Exécuter une commande"
                                  onClick={() => {
                                    setCmdServer(srv);
                                    setCmdInput("");
                                    setCmdResult(null);
                                    setCmdDenied(null);
                                  }}
                                >
                                  <Play />
                                </RowAction>
                              )}
                              {isAdmin && (
                                <>
                                  <RowAction label="Modifier" onClick={() => setFormServer(srv)}>
                                    <Pencil />
                                  </RowAction>
                                  <RowAction
                                    label="Supprimer"
                                    danger
                                    onClick={() => setPendingDelete({ kind: "server", srv })}
                                  >
                                    <Trash2 />
                                  </RowAction>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>

      {/* Command execution modal */}
      {cmdServer && (
        <Modal
          title={
            <>
              Exécuter sur {cmdServer.name}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({cmdServer.os_type === "linux" ? "SSH, Bash" : "PowerShell"}
                {cmdServer.default_account && (
                  <>
                    , compte <span className="font-mono">{cmdServer.default_account.username}</span>
                  </>
                )}
                )
              </span>
            </>
          }
          onClose={() => setCmdServer(null)}
          size="2xl"
        >
          <div className="flex gap-2">
            <Input
              type="text"
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleExecute()}
              placeholder={cmdServer.os_type === "linux" ? "ls -la /var/log" : "Get-Service | Select-Object -First 5"}
              className="flex-1 font-mono"
              autoFocus
            />
            <Button onClick={handleExecute} disabled={cmdLoading || !cmdInput.trim()}>
              {cmdLoading ? <Loader2 className="animate-spin" /> : <Play />}
              Exécuter
            </Button>
          </div>
          {cmdDenied && <GovernanceNotice message={cmdDenied} />}
          {cmdResult && (
            <div className="space-y-2">
              <Chip tone={cmdResult.exit_code === 0 ? "green" : "red"}>
                <span className="font-mono">exit {cmdResult.exit_code}</span>
              </Chip>
              {cmdResult.stdout && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 font-mono text-xs">
                  {cmdResult.stdout}
                </pre>
              )}
              {cmdResult.stderr && (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/10 p-3 font-mono text-xs text-danger">
                  {cmdResult.stderr}
                </pre>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* System info modal */}
      {infoServer && (
        <Modal title={`Infos système de ${infoServer.name}`} onClose={() => setInfoServer(null)} size="md">
          {infoLoading && (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          )}
          {sysInfo && (
            <dl className="divide-y text-sm">
              {[
                ["Nom d'hôte", sysInfo.hostname],
                ["Système", sysInfo.os],
                ["Noyau", sysInfo.kernel],
                ["Uptime", sysInfo.uptime],
                ["CPU", sysInfo.cpu_count + " cœurs"],
                ["Mémoire", `${sysInfo.memory_used} / ${sysInfo.memory_total}`],
                ["Disque", sysInfo.disk_usage],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-mono text-xs">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {!infoLoading && !sysInfo && (
            <ErrorBox message="Impossible de récupérer les infos. Vérifiez la connexion et le compte par défaut du serveur." />
          )}
        </Modal>
      )}

      {/* Add / edit server */}
      {formServer !== undefined && (
        <ServerFormModal
          server={formServer}
          initialNode={selectedNode}
          nodes={nodes}
          zones={zones}
          credentials={credentials}
          labelSuggestions={labels}
          onClose={() => setFormServer(undefined)}
          onSaved={() => {
            setFormServer(undefined);
            refreshAll();
          }}
        />
      )}

      {/* Add / edit node */}
      {nodeForm && (
        <NodeFormModal
          node={nodeForm.node}
          parentId={nodeForm.parentId}
          nodes={nodes}
          onClose={() => setNodeForm(null)}
          onSaved={() => {
            setNodeForm(null);
            refreshAll();
          }}
        />
      )}

      {/* Credentials modal */}
      {showCredModal && (
        <Modal
          title="Credentials"
          description="Secrets chiffrés, référencés par les comptes des serveurs. Un credential utilisé par un compte ne peut pas être supprimé."
          onClose={() => setShowCredModal(false)}
        >
          {credentials.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Enregistrés</h3>
              <div className="divide-y rounded-md border">
                {credentials.map((c) => (
                  <div key={c.id} className="flex h-10 items-center justify-between gap-2 px-3 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <Key className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {c.username} · {c.type}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <RowAction label="Modifier" onClick={() => openEditCred(c)}>
                        <Pencil />
                      </RowAction>
                      <RowAction label="Supprimer" danger onClick={() => setPendingDelete({ kind: "cred", cred: c })}>
                        <Trash2 />
                      </RowAction>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-medium">Nouveau credential</h3>
            <ErrorBox message={credError} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nom *">
                <Input
                  value={credForm.name}
                  onChange={(e) => setCredForm({ ...credForm, name: e.target.value })}
                  placeholder="ssh-admin-prod"
                />
              </Field>
              <Field label="Type *">
                <Select value={credForm.type} onValueChange={(v) => setCredForm({ ...credForm, type: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ssh_password">SSH (mot de passe)</SelectItem>
                    <SelectItem value="ssh_key">SSH (clé privée)</SelectItem>
                    <SelectItem value="winrm">WinRM</SelectItem>
                    <SelectItem value="ephemeral_cert">Certificat éphémère (CA)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Utilisateur *">
              <Input
                value={credForm.username}
                onChange={(e) => setCredForm({ ...credForm, username: e.target.value })}
                placeholder="root"
                className="font-mono"
              />
            </Field>
            {(credForm.type === "ssh_password" || credForm.type === "winrm") && (
              <Field label="Mot de passe">
                <Input
                  type="password"
                  value={credForm.password}
                  onChange={(e) => setCredForm({ ...credForm, password: e.target.value })}
                  autoComplete="new-password"
                />
              </Field>
            )}
            {credForm.type === "ssh_key" && (
              <Field label="Clé privée SSH">
                <Textarea
                  value={credForm.ssh_key}
                  onChange={(e) => setCredForm({ ...credForm, ssh_key: e.target.value })}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={4}
                  className="font-mono text-xs"
                />
              </Field>
            )}
            {credForm.type === "ephemeral_cert" && (
              <div className="space-y-3">
                <InfoBox title="Certificat SSH éphémère">
                  Citadel signe un certificat SSH de courte durée à chaque connexion. Aucun mot de passe ni clé
                  stockés. Le serveur cible doit faire confiance à la CA.
                </InfoBox>
                <Field label="Durée du certificat">
                  <Select
                    value={String(credForm.cert_validity_minutes || 480)}
                    onValueChange={(v) => setCredForm({ ...credForm, cert_validity_minutes: parseInt(v) })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CERT_DURATIONS.map(([v, l]) => (
                        <SelectItem key={v} value={String(v)}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="space-y-1">
                  <p className="text-sm font-medium">Préparer le serveur cible</p>
                  <p className="text-xs text-muted-foreground">
                    Instructions disponibles via l'API :{" "}
                    <code className="font-mono">GET /api/ca/setup-instructions?hostname=mon-serveur</code>
                  </p>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => window.open("/api/ca/setup-instructions?hostname=my-server", "_blank")}
                    className="h-auto p-0 text-xs"
                  >
                    Voir les instructions
                  </Button>
                </div>
              </div>
            )}
            <Button
              onClick={handleAddCredential}
              disabled={credLoading || !credForm.name || !credForm.username}
              className="w-full"
            >
              {credLoading ? <Loader2 className="animate-spin" /> : <Plus />}
              Ajouter le credential
            </Button>
          </div>
        </Modal>
      )}

      {/* Edit credential modal */}
      {editCred && (
        <Modal
          title={`Modifier ${editCred.name}`}
          onClose={() => setEditCred(null)}
          size="md"
          footer={
            <>
              <Button variant="outline" onClick={() => setEditCred(null)}>
                Annuler
              </Button>
              <SaveButton onClick={handleEditCredential} loading={editCredLoading} />
            </>
          }
        >
          <Field label="Nom">
            <Input value={editCredForm.name} onChange={(e) => setEditCredForm({ ...editCredForm, name: e.target.value })} />
          </Field>
          <Field label="Utilisateur">
            <Input
              value={editCredForm.username}
              onChange={(e) => setEditCredForm({ ...editCredForm, username: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field label="Nouveau mot de passe" hint="Laissez vide pour ne pas le changer.">
            <Input
              type="password"
              value={editCredForm.password}
              onChange={(e) => setEditCredForm({ ...editCredForm, password: e.target.value })}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
          {editCred.type === "ssh_key" && (
            <Field label="Nouvelle clé SSH" hint="Laissez vide pour ne pas la changer.">
              <Textarea
                value={editCredForm.ssh_key}
                onChange={(e) => setEditCredForm({ ...editCredForm, ssh_key: e.target.value })}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={4}
                className="font-mono text-xs"
              />
            </Field>
          )}
        </Modal>
      )}

      {/* Destructive confirmations */}
      {pendingDelete && (
        <ConfirmModal
          title={
            pendingDelete.kind === "server"
              ? `Supprimer le serveur ${pendingDelete.srv.name}`
              : pendingDelete.kind === "node"
                ? `Supprimer le nœud ${pendingDelete.node.path}`
                : `Supprimer le credential ${pendingDelete.cred.name}`
          }
          confirmLabel="Supprimer"
          danger
          loading={deleteLoading}
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        >
          {pendingDelete.kind === "server" && (
            <p>
              Le serveur <strong>{pendingDelete.srv.name}</strong> et ses comptes seront retirés de Citadel.
            </p>
          )}
          {pendingDelete.kind === "node" && (
            <p>
              Le nœud <strong>{pendingDelete.node.path}</strong> et tous ses sous-nœuds seront supprimés. Leurs
              serveurs seront déplacés à la racine.
            </p>
          )}
          {pendingDelete.kind === "cred" && (
            <p>
              Le credential <strong>{pendingDelete.cred.name}</strong> sera supprimé. Un credential utilisé par
              un compte ne peut pas l'être.
            </p>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}

const CERT_DURATIONS: [number, string][] = [
  [5, "5 minutes"],
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 heure"],
  [120, "2 heures"],
  [240, "4 heures"],
  [480, "8 heures (défaut)"],
  [720, "12 heures"],
  [1440, "24 heures"],
];
