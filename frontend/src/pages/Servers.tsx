import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
} from "@/services/types";
import NodeTree from "@/components/NodeTree";
import { GovernanceNotice } from "@/components/governanceUi";
import {
  Chip,
  ErrorBox,
  Field,
  LabelChips,
  LabelEditor,
  Modal,
  SaveButton,
  btnSecondary,
  iconBtn,
  iconBtnDanger,
  inputCls,
} from "@/components/kit";
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
  Star,
  Search,
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
  tags: {},
  with_account: false,
  acc_username: "",
  acc_mode: "credential",
  acc_credential_id: "",
  acc_privileged: true,
});

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
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">Racine (aucun nœud)</option>
      {nodes
        .filter((n) => !exclude || (n.id !== exclude && !n.path.startsWith(pathOf(nodes, exclude) + "/")))
        .map((n) => (
          <option key={n.id} value={n.id}>
            {n.path}
          </option>
        ))}
    </select>
  );
}

function pathOf(nodes: NodeData[], id: string): string {
  return nodes.find((n) => n.id === id)?.path || "\u0000";
}

function ServerFormModal({
  server,
  initialNode,
  nodes,
  credentials,
  labelSuggestions,
  onClose,
  onSaved,
}: {
  server: ServerData | null; // null = creation
  initialNode: string | null;
  nodes: NodeData[];
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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {server ? "Enregistrer" : "Ajouter"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Nom *">
            <input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="web-prod-01"
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Hostname *">
          <input
            value={form.hostname}
            onChange={(e) => set({ hostname: e.target.value })}
            placeholder="web-prod-01.local"
            className={inputCls}
          />
        </Field>
        <Field label="Adresse IP *">
          <input
            value={form.ip_address}
            onChange={(e) => set({ ip_address: e.target.value })}
            placeholder="192.168.1.10"
            className={inputCls}
          />
        </Field>
        <Field label="Type OS *">
          <select
            value={form.os_type}
            onChange={(e) => {
              const os = e.target.value as OSType;
              set({ os_type: os, acc_mode: os === "windows" ? "credential" : form.acc_mode });
            }}
            className={inputCls}
          >
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select>
        </Field>
        <Field label="Version OS">
          <input
            value={form.os_version}
            onChange={(e) => set({ os_version: e.target.value })}
            placeholder={form.os_type === "linux" ? "Ubuntu 22.04" : "Windows Server 2022"}
            className={inputCls}
          />
        </Field>
        {form.os_type === "linux" ? (
          <Field label="Port SSH">
            <input
              type="number"
              value={form.ssh_port}
              onChange={(e) => set({ ssh_port: parseInt(e.target.value) || 22 })}
              className={inputCls}
            />
          </Field>
        ) : (
          <>
            <Field label="Port WinRM">
              <input
                type="number"
                value={form.winrm_port}
                onChange={(e) => set({ winrm_port: parseInt(e.target.value) || 5985 })}
                className={inputCls}
              />
            </Field>
            <Field label="Port RDP">
              <input
                type="number"
                value={form.rdp_port}
                onChange={(e) => set({ rdp_port: parseInt(e.target.value) || 3389 })}
                className={inputCls}
              />
            </Field>
          </>
        )}
        <div className={form.os_type === "linux" ? "" : "col-span-2"}>
          <Field label="Nœud">
            <NodeSelect nodes={nodes} value={form.node_id} onChange={(v) => set({ node_id: v })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field
            label="Étiquettes"
            hint="Paires clé=valeur (ex. env=prod, app=web). Utilisées pour filtrer et dans les règles d'accès."
          >
            <LabelEditor
              value={form.tags}
              onChange={(tags) => set({ tags })}
              suggestions={labelSuggestions}
            />
          </Field>
        </div>
      </div>

      {!server && (
        <div className="border-t pt-4 space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.with_account}
              onChange={(e) => set({ with_account: e.target.checked })}
              className="w-4 h-4 rounded"
            />
            Créer un compte par défaut
          </label>
          <p className="text-xs text-muted-foreground -mt-2">
            Le compte par défaut est utilisé par l'automatisation (test de connexion, métriques,
            mises à jour, commandes). D'autres comptes peuvent être ajoutés depuis la fiche du
            serveur.
          </p>
          {form.with_account && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Utilisateur *">
                <input
                  value={form.acc_username}
                  onChange={(e) => set({ acc_username: e.target.value })}
                  placeholder={form.os_type === "linux" ? "root" : "Administrator"}
                  className={inputCls}
                />
              </Field>
              <div className="flex items-center gap-2 pt-6">
                <input
                  type="checkbox"
                  checked={form.acc_privileged}
                  onChange={(e) => set({ acc_privileged: e.target.checked })}
                  className="w-4 h-4 rounded"
                />
                <label className="text-sm">Compte privilégié</label>
              </div>
              <div className="col-span-2">
                <Field label="Authentification">
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        checked={form.acc_mode === "credential"}
                        onChange={() => set({ acc_mode: "credential" })}
                      />
                      Credential enregistré
                    </label>
                    {form.acc_mode === "credential" && (
                      <select
                        value={form.acc_credential_id}
                        onChange={(e) => set({ acc_credential_id: e.target.value })}
                        className={inputCls}
                      >
                        <option value="">Choisir un credential</option>
                        {credentials.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.username}, {c.type})
                          </option>
                        ))}
                      </select>
                    )}
                    <label
                      className={`flex items-center gap-2 text-sm ${
                        form.os_type !== "linux" ? "opacity-50" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        disabled={form.os_type !== "linux"}
                        checked={form.acc_mode === "cert"}
                        onChange={() => set({ acc_mode: "cert" })}
                      />
                      Certificat éphémère (CA Citadel, Linux uniquement)
                    </label>
                    {form.acc_mode === "cert" && (
                      <div className="p-3 rounded bg-blue-50 border border-blue-200 text-xs text-blue-800">
                        Aucun secret stocké : un certificat SSH de courte durée est signé à chaque
                        connexion. Le serveur doit faire confiance à la clé CA (TrustedUserCAKeys
                        dans sshd_config).
                      </div>
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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!name.trim()}>
            {node ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom *">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Prod"
          className={inputCls}
          autoFocus
        />
      </Field>
      <Field label="Nœud parent">
        <NodeSelect nodes={nodes} value={parent} onChange={setParent} exclude={node?.id} />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
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

  const loadLabels = useCallback(() => {
    api.get<Record<string, string[]>>("/api/servers/labels/").then(setLabels).catch(() => {});
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  useEffect(() => {
    loadNodes();
    loadLabels();
  }, [loadNodes, loadLabels]);

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
    if (!confirm("Supprimer ce credential ?")) return;
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
    if (!confirm(`Supprimer le serveur ${srv.name} ?`)) return;
    try {
      await api.delete(`/api/servers/${srv.id}`);
      setServers((prev) => prev.filter((s) => s.id !== srv.id));
      loadNodes();
      loadLabels();
    } catch (e) {
      alert(errorMessage(e));
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
    if (
      !confirm(
        `Supprimer le nœud ${node.path} et tous ses sous-nœuds ? Leurs serveurs seront déplacés à la racine.`
      )
    )
      return;
    try {
      await api.delete(`/api/nodes/${node.id}`);
      if (selectedNode && (selectedNode === node.id || selectedNodeData?.path.startsWith(node.path + "/")))
        setSelectedNode(null);
      refreshAll();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const toggleLabelFilter = (sel: string) =>
    setLabelFilters((prev) => (prev.includes(sel) ? prev.filter((x) => x !== sel) : [...prev, sel]));

  const statusColor = {
    online: "bg-green-500",
    offline: "bg-red-500",
    unknown: "bg-gray-400",
  };

  const hasFilters = !!selectedNode || labelFilters.length > 0 || !!debouncedSearch || favOnly;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Serveurs</h2>
          {selectedNodeData && (
            <p className="text-sm text-muted-foreground mt-0.5">{selectedNodeData.path}</p>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCredModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-md border text-sm font-medium hover:bg-accent"
            >
              <Key size={16} />
              Credentials ({credentials.length})
            </button>
            <button
              onClick={() => setFormServer(null)}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
            >
              <Plus size={16} />
              Ajouter un serveur
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-4 items-start">
        {/* Node tree */}
        <div className="w-60 shrink-0">
          <NodeTree
            nodes={nodes}
            selected={selectedNode}
            onSelect={setSelectedNode}
            isAdmin={isAdmin}
            onCreate={(parentId) => setNodeForm({ node: null, parentId })}
            onRename={(node) => setNodeForm({ node, parentId: null })}
            onDelete={handleDeleteNode}
          />
        </div>

        <div className="flex-1 min-w-0">
          {/* Search + filters */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher (nom, hostname, IP)"
                className="w-full pl-9 pr-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={() => setFavOnly((v) => !v)}
              className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm ${
                favOnly ? "bg-amber-50 border-amber-300 text-amber-800" : "hover:bg-accent"
              }`}
            >
              <Star size={14} className={favOnly ? "fill-amber-400 text-amber-500" : ""} />
              Favoris
            </button>
            <div className="relative">
              <button
                onClick={() => setShowLabelPicker((v) => !v)}
                className="flex items-center gap-2 px-3 py-2 rounded-md border text-sm hover:bg-accent"
                disabled={Object.keys(labels).length === 0}
                title={Object.keys(labels).length === 0 ? "Aucune étiquette définie" : undefined}
              >
                <Tag size={14} />
                Étiquettes
                {labelFilters.length > 0 && (
                  <span className="px-1.5 rounded-full bg-primary text-primary-foreground text-xs">
                    {labelFilters.length}
                  </span>
                )}
              </button>
              {showLabelPicker && (
                <div className="absolute z-20 mt-1 w-72 max-h-80 overflow-auto bg-card border rounded-md shadow-lg p-3 space-y-3">
                  {Object.entries(labels).map(([key, values]) => (
                    <div key={key}>
                      <p className="text-xs font-medium text-muted-foreground mb-1">{key}</p>
                      <div className="flex flex-wrap gap-1">
                        {values.map((v) => {
                          const sel = `${key}=${v}`;
                          const on = labelFilters.includes(sel);
                          return (
                            <button
                              key={sel}
                              onClick={() => toggleLabelFilter(sel)}
                              className={`px-2 py-0.5 rounded text-xs border ${
                                on
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "hover:bg-accent"
                              }`}
                            >
                              {v === "" ? "(vide)" : v}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {labelFilters.map((l) => (
              <Chip key={l} tone="primary" onRemove={() => toggleLabelFilter(l)}>
                {l}
              </Chip>
            ))}
            {hasFilters && (
              <button
                onClick={() => {
                  setSelectedNode(null);
                  setLabelFilters([]);
                  setSearch("");
                  setFavOnly(false);
                }}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Réinitialiser
              </button>
            )}
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
                  <strong>{testResult.server_name}</strong> : {testResult.message}
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
                {hasFilters
                  ? "Aucun serveur ne correspond aux filtres."
                  : isAdmin
                    ? 'Aucun serveur configuré. Cliquez sur "Ajouter un serveur" pour commencer.'
                    : "Aucun serveur ne vous est accessible. Demandez un accès à un administrateur."}
              </p>
            </div>
          )}

          {servers.length > 0 && (
            <div className="bg-card border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="w-8 p-3" />
                    <th className="text-left p-3 font-medium">Statut</th>
                    <th className="text-left p-3 font-medium">Nom</th>
                    <th className="text-left p-3 font-medium">Adresse</th>
                    <th className="text-left p-3 font-medium">OS</th>
                    <th className="text-left p-3 font-medium">Étiquettes</th>
                    <th className="text-left p-3 font-medium">Compte par défaut</th>
                    <th className="text-right p-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((srv) => {
                    const canConnect = hasAction(srv, "connect");
                    const canExecute = hasAction(srv, "execute");
                    return (
                      <tr key={srv.id} className="border-b hover:bg-muted/30">
                        <td className="p-3">
                          <button
                            onClick={() => toggleFavorite(srv)}
                            title={srv.is_favorite ? "Retirer des favoris" : "Ajouter aux favoris"}
                            className="text-muted-foreground hover:text-amber-500"
                          >
                            <Star
                              size={16}
                              className={srv.is_favorite ? "fill-amber-400 text-amber-500" : ""}
                            />
                          </button>
                        </td>
                        <td className="p-3">
                          <span
                            className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor[srv.status]}`}
                            title={srv.status}
                          />
                        </td>
                        <td className="p-3">
                          <button
                            onClick={() => navigate(`/servers/${srv.id}`)}
                            className="font-medium hover:underline text-left"
                          >
                            {srv.name}
                          </button>
                          {srv.node_path && (
                            <p className="text-xs text-muted-foreground">{srv.node_path}</p>
                          )}
                        </td>
                        <td className="p-3">
                          <p className="font-mono text-xs">{srv.ip_address}</p>
                          <p className="text-xs text-muted-foreground">{srv.hostname}</p>
                        </td>
                        <td className="p-3">
                          <span className="px-2 py-0.5 rounded text-xs bg-secondary">{srv.os_type}</span>
                        </td>
                        <td className="p-3">
                          <LabelChips tags={srv.tags} />
                        </td>
                        <td className="p-3">
                          {srv.default_account ? (
                            <span className="flex items-center gap-1.5 text-xs">
                              <span className="font-mono">{srv.default_account.username}</span>
                              {srv.default_account.auth === "cert" && (
                                <span title="Certificat éphémère">
                                  <ShieldCheck size={12} className="text-blue-500" />
                                </span>
                              )}
                              {srv.accounts_count > 1 && (
                                <span className="text-muted-foreground">
                                  +{srv.accounts_count - 1}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">aucun</span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => navigate(`/terminal?server=${srv.id}`)}
                              disabled={!canConnect}
                              className={iconBtn}
                              title={
                                canConnect
                                  ? srv.os_type === "windows"
                                    ? "Ouvrir une session RDP"
                                    : "Ouvrir un terminal"
                                  : "Connexion non autorisée"
                              }
                            >
                              <TerminalIcon size={16} />
                            </button>
                            <button
                              onClick={() => handleTestConnection(srv)}
                              disabled={testingId === srv.id}
                              className={iconBtn}
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
                              className={iconBtn}
                              title="Infos système"
                            >
                              <Info size={16} />
                            </button>
                            {canExecute && (
                              <button
                                onClick={() => {
                                  setCmdServer(srv);
                                  setCmdInput("");
                                  setCmdResult(null);
                                  setCmdDenied(null);
                                }}
                                className={iconBtn}
                                title="Exécuter une commande"
                              >
                                <Play size={16} />
                              </button>
                            )}
                            {isAdmin && (
                              <>
                                <button
                                  onClick={() => setFormServer(srv)}
                                  className={iconBtn}
                                  title="Modifier"
                                >
                                  <Pencil size={16} />
                                </button>
                                <button
                                  onClick={() => handleDeleteServer(srv)}
                                  className={iconBtnDanger}
                                  title="Supprimer"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
              <span className="text-xs text-muted-foreground">
                ({cmdServer.os_type === "linux" ? "SSH / Bash" : "PowerShell"}
                {cmdServer.default_account && `, compte ${cmdServer.default_account.username}`})
              </span>
            </>
          }
          onClose={() => setCmdServer(null)}
          size="2xl"
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleExecute()}
              placeholder={
                cmdServer.os_type === "linux" ? "ls -la /var/log" : "Get-Service | Select-Object -First 5"
              }
              className="flex-1 px-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <button
              onClick={handleExecute}
              disabled={cmdLoading || !cmdInput.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {cmdLoading ? <Loader2 size={16} className="animate-spin" /> : "Exécuter"}
            </button>
          </div>
          {cmdDenied && <GovernanceNotice message={cmdDenied} />}
          {cmdResult && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`px-2 py-0.5 rounded ${
                    cmdResult.exit_code === 0 ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
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
        </Modal>
      )}

      {/* System info modal */}
      {infoServer && (
        <Modal title={`Infos ${infoServer.name}`} onClose={() => setInfoServer(null)} size="md">
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
              Impossible de récupérer les infos. Vérifiez la connexion et le compte par défaut du
              serveur.
            </p>
          )}
        </Modal>
      )}

      {/* Add / edit server */}
      {formServer !== undefined && (
        <ServerFormModal
          server={formServer}
          initialNode={selectedNode}
          nodes={nodes}
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
        <Modal title="Credentials" onClose={() => setShowCredModal(false)}>
          <p className="text-xs text-muted-foreground">
            Secrets chiffrés, référencés par les comptes des serveurs. Un credential utilisé par un
            compte ne peut pas être supprimé.
          </p>
          {credentials.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase">Existants</h4>
              {credentials.map((c) => (
                <div key={c.id} className="flex items-center justify-between p-2 rounded border text-sm">
                  <div className="flex items-center gap-2">
                    <Key size={14} className="text-muted-foreground" />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.username} · {c.type}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEditCred(c)} className="p-1 rounded hover:bg-accent text-muted-foreground" title="Modifier">
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

          <div className="border-t pt-4">
            <h4 className="text-xs font-medium text-muted-foreground uppercase mb-3">Nouveau credential</h4>
            {credError && <div className="p-2 rounded bg-red-50 text-red-700 text-sm mb-3">{credError}</div>}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nom *">
                  <input
                    value={credForm.name}
                    onChange={(e) => setCredForm({ ...credForm, name: e.target.value })}
                    placeholder="ssh-admin-prod"
                    className={inputCls}
                  />
                </Field>
                <Field label="Type *">
                  <select
                    value={credForm.type}
                    onChange={(e) => setCredForm({ ...credForm, type: e.target.value })}
                    className={inputCls}
                  >
                    <option value="ssh_password">SSH (mot de passe)</option>
                    <option value="ssh_key">SSH (clé privée)</option>
                    <option value="winrm">WinRM</option>
                    <option value="ephemeral_cert">Certificat éphémère (CA)</option>
                  </select>
                </Field>
              </div>
              <Field label="Utilisateur *">
                <input
                  value={credForm.username}
                  onChange={(e) => setCredForm({ ...credForm, username: e.target.value })}
                  placeholder="root"
                  className={inputCls}
                />
              </Field>
              {(credForm.type === "ssh_password" || credForm.type === "winrm") && (
                <Field label="Mot de passe">
                  <input
                    type="password"
                    value={credForm.password}
                    onChange={(e) => setCredForm({ ...credForm, password: e.target.value })}
                    autoComplete="new-password"
                    className={inputCls}
                  />
                </Field>
              )}
              {credForm.type === "ssh_key" && (
                <Field label="Clé privée SSH">
                  <textarea
                    value={credForm.ssh_key}
                    onChange={(e) => setCredForm({ ...credForm, ssh_key: e.target.value })}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={4}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              )}
              {credForm.type === "ephemeral_cert" && (
                <div className="space-y-3">
                  <div className="p-3 rounded-md bg-blue-50 border border-blue-200 text-sm text-blue-800">
                    <p className="font-medium mb-1">Certificat SSH éphémère</p>
                    <p className="text-xs">
                      Citadel signera un certificat SSH de courte durée à chaque connexion. Aucun mot
                      de passe ni clé stockée. Le serveur cible doit faire confiance à la CA.
                    </p>
                  </div>
                  <Field label="Durée du certificat">
                    <select
                      value={credForm.cert_validity_minutes || 480}
                      onChange={(e) =>
                        setCredForm({ ...credForm, cert_validity_minutes: parseInt(e.target.value) })
                      }
                      className={inputCls}
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
                  </Field>
                  <div>
                    <label className="block text-sm font-medium mb-1">Setup serveur cible</label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Récupérez les instructions via l'API : GET
                      /api/ca/setup-instructions?hostname=mon-serveur
                    </p>
                    <button
                      type="button"
                      onClick={() => window.open("/api/ca/setup-instructions?hostname=my-server", "_blank")}
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
                {credLoading ? <Loader2 size={16} className="animate-spin mx-auto" /> : "Ajouter le credential"}
              </button>
            </div>
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
              <button onClick={() => setEditCred(null)} className={btnSecondary}>
                Annuler
              </button>
              <SaveButton onClick={handleEditCredential} loading={editCredLoading} />
            </>
          }
        >
          <Field label="Nom">
            <input
              value={editCredForm.name}
              onChange={(e) => setEditCredForm({ ...editCredForm, name: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Utilisateur">
            <input
              value={editCredForm.username}
              onChange={(e) => setEditCredForm({ ...editCredForm, username: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field
            label={
              <>
                Nouveau mot de passe
                <span className="text-xs text-muted-foreground ml-1">(laisser vide pour ne pas changer)</span>
              </>
            }
          >
            <input
              type="password"
              value={editCredForm.password}
              onChange={(e) => setEditCredForm({ ...editCredForm, password: e.target.value })}
              placeholder="••••••••"
              autoComplete="new-password"
              className={inputCls}
            />
          </Field>
          {editCred.type === "ssh_key" && (
            <Field
              label={
                <>
                  Nouvelle clé SSH
                  <span className="text-xs text-muted-foreground ml-1">(laisser vide pour ne pas changer)</span>
                </>
              }
            >
              <textarea
                value={editCredForm.ssh_key}
                onChange={(e) => setEditCredForm({ ...editCredForm, ssh_key: e.target.value })}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={4}
                className={`${inputCls} font-mono`}
              />
            </Field>
          )}
        </Modal>
      )}
    </div>
  );
}
