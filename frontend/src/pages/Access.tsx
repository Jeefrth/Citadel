import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  CalendarClock,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Power,
  Radar,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  VIRTUAL_ACCOUNTS,
  VIRTUAL_ACCOUNT_HELP,
  errorMessage,
  type AccessPolicyData,
  type NodeData,
  type ServerAccess,
  type ServerAction,
  type ServerData,
  type UserData,
  type UserGroupData,
} from "@/services/types";
import {
  Chip,
  ErrorBox,
  Field,
  Modal,
  MultiSelect,
  SaveButton,
  Tabs,
  btnSecondary,
  formatDate,
  iconBtn,
  iconBtnDanger,
  inputCls,
  type Option,
} from "@/components/ui";
import { DiscoveredAccountsPanel } from "@/components/DiscoveredAccounts";

type Tab = "policies" | "groups" | "effective" | "discovered";

// ── Helpers ──────────────────────────────────────────────────

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

function policyState(p: AccessPolicyData): { label: string; tone: "green" | "amber" | "default" } {
  if (!p.is_active) return { label: "Désactivée", tone: "default" };
  const now = Date.now();
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return { label: "Planifiée", tone: "amber" };
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return { label: "Expirée", tone: "default" };
  return { label: "Active", tone: "green" };
}

interface RefData {
  users: UserData[];
  groups: UserGroupData[];
  servers: ServerData[];
  nodes: NodeData[];
  labels: Record<string, string[]>;
}

// ── Policy dialog ────────────────────────────────────────────

interface PolicyForm {
  name: string;
  description: string;
  is_active: boolean;
  valid_from: string;
  valid_until: string;
  actions: ServerAction[];
  accounts: string[];
  labels: string[];
  user_ids: string[];
  group_ids: string[];
  server_ids: string[];
  node_ids: string[];
}

function PolicyModal({
  policy,
  refs,
  onClose,
  onSaved,
}: {
  policy: AccessPolicyData | null;
  refs: RefData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PolicyForm>(() =>
    policy
      ? {
          name: policy.name,
          description: policy.description || "",
          is_active: policy.is_active,
          valid_from: toLocalInput(policy.valid_from),
          valid_until: toLocalInput(policy.valid_until),
          actions: [...policy.actions],
          accounts: [...policy.accounts],
          labels: [...policy.labels],
          user_ids: policy.users.map((r) => r.id),
          group_ids: policy.groups.map((r) => r.id),
          server_ids: policy.servers.map((r) => r.id),
          node_ids: policy.nodes.map((r) => r.id),
        }
      : {
          name: "",
          description: "",
          is_active: true,
          valid_from: "",
          valid_until: "",
          actions: ["connect"],
          accounts: ["@ALL"],
          labels: [],
          user_ids: [],
          group_ids: [],
          server_ids: [],
          node_ids: [],
        }
  );
  const [accountInput, setAccountInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<PolicyForm>) => setForm((f) => ({ ...f, ...p }));

  const userOpts: Option[] = refs.users.map((u) => ({ id: u.id, label: u.display_name, sub: u.email }));
  const groupOpts: Option[] = refs.groups.map((g) => ({
    id: g.id,
    label: g.name,
    sub: `${g.users.length} membre(s)`,
  }));
  const serverOpts: Option[] = refs.servers.map((s) => ({
    id: s.id,
    label: s.name,
    sub: s.node_path || s.ip_address,
  }));
  const nodeOpts: Option[] = refs.nodes.map((n) => ({ id: n.id, label: n.path }));
  const labelSelectors = useMemo(
    () =>
      Object.entries(refs.labels).flatMap(([k, vals]) => [`${k}=`, ...vals.map((v) => `${k}=${v}`)]),
    [refs.labels]
  );

  const addAccount = (a: string) => {
    const v = a.trim();
    if (!v || form.accounts.includes(v)) return;
    set({ accounts: [...form.accounts, v] });
  };
  const addLabel = (l: string) => {
    const v = l.trim();
    if (!v || !v.includes("=") || v.startsWith("=") || form.labels.includes(v)) return;
    set({ labels: [...form.labels, v] });
  };
  const toggleAction = (a: ServerAction) =>
    set({ actions: form.actions.includes(a) ? form.actions.filter((x) => x !== a) : [...form.actions, a] });

  const unknownVirtual = form.accounts.filter(
    (a) => a.startsWith("@") && !(VIRTUAL_ACCOUNTS as string[]).includes(a)
  );
  const valid = form.name.trim() !== "" && unknownVirtual.length === 0;

  const save = async () => {
    setLoading(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      description: form.description || null,
      is_active: form.is_active,
      valid_from: fromLocalInput(form.valid_from),
      valid_until: fromLocalInput(form.valid_until),
      actions: form.actions,
      accounts: form.accounts,
      labels: form.labels,
      user_ids: form.user_ids,
      group_ids: form.group_ids,
      server_ids: form.server_ids,
      node_ids: form.node_ids,
    };
    try {
      if (policy) await api.patch(`/api/access-policies/${policy.id}`, body);
      else await api.post("/api/access-policies", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const noBeneficiary = form.user_ids.length === 0 && form.group_ids.length === 0;
  const noTarget = form.server_ids.length === 0 && form.node_ids.length === 0 && form.labels.length === 0;

  return (
    <Modal
      title={policy ? `Modifier la règle ${policy.name}` : "Nouvelle règle d'accès"}
      onClose={onClose}
      size="3xl"
      footer={
        <>
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {policy ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-2 gap-4">
        <Field label="Nom *">
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Ops prod Linux"
            className={inputCls}
            autoFocus
          />
        </Field>
        <Field label="Description">
          <input
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Valide à partir du" hint="Laisser vide pour une validité immédiate.">
          <input
            type="datetime-local"
            value={form.valid_from}
            onChange={(e) => set({ valid_from: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Valide jusqu'au" hint="Laisser vide pour une validité illimitée.">
          <input
            type="datetime-local"
            value={form.valid_until}
            onChange={(e) => set({ valid_until: e.target.value })}
            className={inputCls}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.is_active}
          onChange={(e) => set({ is_active: e.target.checked })}
          className="w-4 h-4 rounded"
        />
        Règle active
      </label>

      {/* Who */}
      <div className="border-t pt-4">
        <h4 className="text-xs font-medium text-muted-foreground uppercase mb-3">Bénéficiaires</h4>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Utilisateurs">
            <MultiSelect
              options={userOpts}
              selected={form.user_ids}
              onChange={(user_ids) => set({ user_ids })}
              emptyText="Aucun utilisateur"
            />
          </Field>
          <Field label="Groupes d'utilisateurs">
            <MultiSelect
              options={groupOpts}
              selected={form.group_ids}
              onChange={(group_ids) => set({ group_ids })}
              emptyText="Aucun groupe"
            />
          </Field>
        </div>
        {noBeneficiary && (
          <p className="text-xs text-amber-700 mt-2">
            Aucun bénéficiaire : la règle ne donnera accès à personne.
          </p>
        )}
      </div>

      {/* What */}
      <div className="border-t pt-4">
        <h4 className="text-xs font-medium text-muted-foreground uppercase mb-3">Serveurs ciblés</h4>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Serveurs">
            <MultiSelect
              options={serverOpts}
              selected={form.server_ids}
              onChange={(server_ids) => set({ server_ids })}
              emptyText="Aucun serveur"
            />
          </Field>
          <Field label="Nœuds" hint="Un nœud inclut tous ses sous-nœuds.">
            <MultiSelect
              options={nodeOpts}
              selected={form.node_ids}
              onChange={(node_ids) => set({ node_ids })}
              emptyText="Aucun nœud"
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field
            label="Étiquettes"
            hint="Un serveur portant n'importe laquelle de ces étiquettes est inclus. « clé= » correspond à toutes les valeurs de la clé."
          >
            <div className="flex flex-wrap gap-1 mb-2 min-h-[1.5rem]">
              {form.labels.length === 0 && (
                <span className="text-xs text-muted-foreground">Aucune étiquette</span>
              )}
              {form.labels.map((l) => (
                <Chip key={l} tone="blue" onRemove={() => set({ labels: form.labels.filter((x) => x !== l) })}>
                  {l}
                </Chip>
              ))}
            </div>
            <div className="flex gap-2">
              <select
                value=""
                onChange={(e) => addLabel(e.target.value)}
                className={inputCls}
                disabled={labelSelectors.length === 0}
              >
                <option value="">
                  {labelSelectors.length === 0 ? "Aucune étiquette existante" : "Choisir une étiquette existante"}
                </option>
                {labelSelectors
                  .filter((l) => !form.labels.includes(l))
                  .map((l) => (
                    <option key={l} value={l}>
                      {l.endsWith("=") ? `${l} (toutes valeurs)` : l}
                    </option>
                  ))}
              </select>
              <input
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addLabel(labelInput);
                    setLabelInput("");
                  }
                }}
                placeholder="ou saisir clé=valeur"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => {
                  addLabel(labelInput);
                  setLabelInput("");
                }}
                className={btnSecondary}
                disabled={!labelInput.includes("=")}
              >
                <Plus size={16} />
              </button>
            </div>
          </Field>
        </div>
        {noTarget && (
          <p className="text-xs text-amber-700 mt-2">
            Aucune cible : la règle ne couvre aucun serveur.
          </p>
        )}
      </div>

      {/* How */}
      <div className="border-t pt-4 grid grid-cols-2 gap-4">
        <Field label="Comptes autorisés">
          <div className="flex flex-wrap gap-1 mb-2 min-h-[1.5rem]">
            {form.accounts.length === 0 && (
              <span className="text-xs text-muted-foreground">Aucun compte</span>
            )}
            {form.accounts.map((a) => (
              <Chip
                key={a}
                tone={a.startsWith("@") ? "primary" : "default"}
                title={(VIRTUAL_ACCOUNT_HELP as Record<string, string>)[a]}
                onRemove={() => set({ accounts: form.accounts.filter((x) => x !== a) })}
              >
                {a}
              </Chip>
            ))}
          </div>
          <div className="flex gap-2 mb-2">
            <input
              value={accountInput}
              onChange={(e) => setAccountInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAccount(accountInput);
                  setAccountInput("");
                }
              }}
              placeholder="Nom de compte (ex. root)"
              className={inputCls}
            />
            <button
              type="button"
              onClick={() => {
                addAccount(accountInput);
                setAccountInput("");
              }}
              className={btnSecondary}
              disabled={!accountInput.trim()}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="space-y-1">
            {VIRTUAL_ACCOUNTS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => addAccount(v)}
                disabled={form.accounts.includes(v)}
                className="w-full flex items-center gap-2 px-2 py-1 rounded border text-left text-xs hover:bg-accent disabled:opacity-40"
              >
                <Plus size={12} />
                <span className="font-mono font-medium w-14">{v}</span>
                <span className="text-muted-foreground">{VIRTUAL_ACCOUNT_HELP[v]}</span>
              </button>
            ))}
          </div>
          {unknownVirtual.length > 0 && (
            <p className="text-xs text-red-700 mt-1">
              Compte virtuel inconnu : {unknownVirtual.join(", ")}
            </p>
          )}
        </Field>
        <Field label="Actions autorisées">
          <div className="space-y-2">
            {ALL_ACTIONS.map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.actions.includes(a)}
                  onChange={() => toggleAction(a)}
                  className="w-4 h-4 rounded"
                />
                {ACTION_LABELS[a]}
                <span className="text-xs text-muted-foreground">
                  {
                    {
                      connect: "terminal SSH / session RDP",
                      execute: "commandes et mises à jour",
                      copy: "presse-papiers distant vers local (RDP)",
                      paste: "presse-papiers local vers distant (RDP)",
                    }[a]
                  }
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Le rôle de l'utilisateur reste un plafond : un lecteur (viewer) n'obtient jamais
            l'exécution.
          </p>
        </Field>
      </div>
    </Modal>
  );
}

// ── Group dialog ─────────────────────────────────────────────

function GroupModal({
  group,
  users,
  onClose,
  onSaved,
}: {
  group: UserGroupData | null;
  users: UserData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name || "");
  const [description, setDescription] = useState(group?.description || "");
  const [members, setMembers] = useState<string[]>(group?.users.map((u) => u.id) || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setLoading(true);
    setError(null);
    const body = { name: name.trim(), description: description || null, user_ids: members };
    try {
      if (group) await api.patch(`/api/user-groups/${group.id}`, body);
      else await api.post("/api/user-groups", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={group ? `Modifier le groupe ${group.name}` : "Nouveau groupe"}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!name.trim()}>
            {group ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom *">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoFocus />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
      </Field>
      <Field label={`Membres (${members.length})`}>
        <MultiSelect
          options={users.map((u) => ({ id: u.id, label: u.display_name, sub: u.email }))}
          selected={members}
          onChange={setMembers}
          maxHeight="max-h-60"
          emptyText="Aucun utilisateur"
        />
      </Field>
    </Modal>
  );
}

// ── Effective access table (shared with "Mon compte") ────────

export function AccessTable({ rows }: { rows: ServerAccess[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground p-4">Aucun serveur accessible.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b bg-muted/50">
          <th className="text-left p-3 font-medium">Serveur</th>
          <th className="text-left p-3 font-medium">Actions</th>
          <th className="text-left p-3 font-medium">Comptes</th>
          <th className="text-left p-3 font-medium">Accordé par</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.server_id} className="border-b last:border-0">
            <td className="p-3 font-medium">{r.server_name}</td>
            <td className="p-3">
              <div className="flex flex-wrap gap-1">
                {r.actions.map((a) => (
                  <Chip key={a} tone={a === "execute" || a === "*" ? "amber" : "green"}>
                    {ACTION_LABELS[a] || a}
                  </Chip>
                ))}
              </div>
            </td>
            <td className="p-3">
              <div className="flex flex-wrap gap-1">
                {r.accounts.map((a) => (
                  <Chip key={a} tone={a.startsWith("@") ? "primary" : "default"}>
                    {a === "*" ? "tous" : a}
                  </Chip>
                ))}
              </div>
            </td>
            <td className="p-3 text-xs text-muted-foreground">
              {r.policies.map((p) => (p === "admin" ? "rôle administrateur" : p)).join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default function Access() {
  const { isAdmin, loading: userLoading } = useCurrentUser();
  const [tab, setTab] = useState<Tab>("policies");
  const [policies, setPolicies] = useState<AccessPolicyData[]>([]);
  const [refs, setRefs] = useState<RefData>({ users: [], groups: [], servers: [], nodes: [], labels: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editPolicy, setEditPolicy] = useState<AccessPolicyData | null | undefined>(undefined);
  const [editGroup, setEditGroup] = useState<UserGroupData | null | undefined>(undefined);

  // Effective access
  const [effUser, setEffUser] = useState("");
  const [effRows, setEffRows] = useState<ServerAccess[] | null>(null);
  const [effLoading, setEffLoading] = useState(false);
  const [effError, setEffError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, g, u, s, n, l] = await Promise.all([
        api.get<AccessPolicyData[]>("/api/access-policies"),
        api.get<UserGroupData[]>("/api/user-groups"),
        api.get<UserData[]>("/api/users/"),
        api.get<ServerData[]>("/api/servers/"),
        api.get<NodeData[]>("/api/nodes"),
        api.get<Record<string, string[]>>("/api/servers/labels/"),
      ]);
      setPolicies(p);
      setRefs({ users: u, groups: g, servers: s, nodes: n, labels: l });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  useEffect(() => {
    if (!effUser) {
      setEffRows(null);
      return;
    }
    setEffLoading(true);
    setEffError(null);
    api
      .get<ServerAccess[]>(`/api/users/${effUser}/access`)
      .then(setEffRows)
      .catch((e) => setEffError(errorMessage(e)))
      .finally(() => setEffLoading(false));
  }, [effUser]);

  if (userLoading) return <p className="text-muted-foreground">Chargement...</p>;
  if (!isAdmin) return <Navigate to="/" replace />;

  const togglePolicy = async (p: AccessPolicyData) => {
    try {
      const updated = await api.patch<AccessPolicyData>(`/api/access-policies/${p.id}`, {
        is_active: !p.is_active,
      });
      setPolicies((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const deletePolicy = async (p: AccessPolicyData) => {
    if (!confirm(`Supprimer la règle ${p.name} ?`)) return;
    try {
      await api.delete(`/api/access-policies/${p.id}`);
      setPolicies((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const deleteGroup = async (g: UserGroupData) => {
    if (!confirm(`Supprimer le groupe ${g.name} ? Les règles qui le citent ne s'appliqueront plus à ses membres.`))
      return;
    try {
      await api.delete(`/api/user-groups/${g.id}`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const selectedEffUser = refs.users.find((u) => u.id === effUser);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Accès</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Qui peut se connecter à quels serveurs, avec quels comptes et quelles actions.
          </p>
        </div>
        {tab === "policies" && (
          <button
            onClick={() => setEditPolicy(null)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={16} /> Nouvelle règle
          </button>
        )}
        {tab === "groups" && (
          <button
            onClick={() => setEditGroup(null)}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
          >
            <Plus size={16} /> Nouveau groupe
          </button>
        )}
      </div>

      <Tabs<Tab>
        tabs={[
          { id: "policies", label: "Règles d'accès", icon: ShieldCheck },
          { id: "groups", label: "Groupes d'utilisateurs", icon: Users },
          { id: "effective", label: "Accès effectifs", icon: Eye },
          { id: "discovered", label: "Comptes découverts", icon: Radar },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error && (
        <div className="mb-4">
          <ErrorBox message={error} />
        </div>
      )}
      {loading && <p className="text-muted-foreground">Chargement...</p>}

      {/* Policies */}
      {!loading && tab === "policies" && (
        <>
          <div className="mb-4 p-3 rounded-md border bg-muted/30 text-xs text-muted-foreground space-y-1">
            <p>
              Une règle accorde à des <strong>utilisateurs ou groupes</strong> l'accès à des{" "}
              <strong>serveurs</strong> (désignés directement, par nœud avec ses sous-nœuds, ou par
              étiquette), avec certains <strong>comptes</strong> et certaines{" "}
              <strong>actions</strong>. Les règles s'additionnent.
            </p>
            <p>
              Comptes virtuels :{" "}
              {VIRTUAL_ACCOUNTS.map((v, i) => (
                <span key={v}>
                  <span className="font-mono">{v}</span> = {VIRTUAL_ACCOUNT_HELP[v].toLowerCase()}
                  {i < VIRTUAL_ACCOUNTS.length - 1 ? " ; " : "."}
                </span>
              ))}
            </p>
          </div>
          {policies.length === 0 ? (
            <div className="bg-card border rounded-lg p-12 text-center">
              <ShieldCheck size={48} className="mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                Aucune règle d'accès. Seuls les administrateurs voient les serveurs.
              </p>
            </div>
          ) : (
            <div className="bg-card border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Règle</th>
                    <th className="text-left p-3 font-medium">Statut</th>
                    <th className="text-left p-3 font-medium">Bénéficiaires</th>
                    <th className="text-left p-3 font-medium">Cibles</th>
                    <th className="text-left p-3 font-medium">Comptes</th>
                    <th className="text-left p-3 font-medium">Actions</th>
                    <th className="text-right p-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => {
                    const st = policyState(p);
                    return (
                      <tr key={p.id} className="border-b last:border-0 align-top hover:bg-muted/30">
                        <td className="p-3">
                          <p className="font-medium">{p.name}</p>
                          {p.description && (
                            <p className="text-xs text-muted-foreground">{p.description}</p>
                          )}
                          {(p.valid_from || p.valid_until) && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                              <CalendarClock size={11} />
                              {p.valid_from ? formatDate(p.valid_from) : "..."} au{" "}
                              {p.valid_until ? formatDate(p.valid_until) : "..."}
                            </p>
                          )}
                        </td>
                        <td className="p-3">
                          <Chip tone={st.tone}>{st.label}</Chip>
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {p.users.map((u) => (
                              <Chip key={u.id}>{u.name}</Chip>
                            ))}
                            {p.groups.map((g) => (
                              <Chip key={g.id} tone="primary">
                                <Users size={11} /> {g.name}
                              </Chip>
                            ))}
                            {p.users.length + p.groups.length === 0 && (
                              <span className="text-xs text-muted-foreground">aucun</span>
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {p.servers.map((s) => (
                              <Chip key={s.id}>{s.name}</Chip>
                            ))}
                            {p.nodes.map((n) => (
                              <Chip key={n.id} tone="green">
                                {refs.nodes.find((x) => x.id === n.id)?.path || n.name}/*
                              </Chip>
                            ))}
                            {p.labels.map((l) => (
                              <Chip key={l} tone="blue">
                                {l}
                              </Chip>
                            ))}
                            {p.servers.length + p.nodes.length + p.labels.length === 0 && (
                              <span className="text-xs text-muted-foreground">aucune</span>
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1">
                            {p.accounts.map((a) => (
                              <Chip key={a} tone={a.startsWith("@") ? "primary" : "default"}>
                                {a}
                              </Chip>
                            ))}
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1">
                            {p.actions.map((a) => (
                              <Chip key={a} tone={a === "execute" ? "amber" : "default"}>
                                {ACTION_LABELS[a] || a}
                              </Chip>
                            ))}
                          </div>
                        </td>
                        <td className="p-3 text-right whitespace-nowrap">
                          <button
                            onClick={() => togglePolicy(p)}
                            className={iconBtn}
                            title={p.is_active ? "Désactiver" : "Activer"}
                          >
                            <Power size={15} className={p.is_active ? "text-green-600" : ""} />
                          </button>
                          <button onClick={() => setEditPolicy(p)} className={iconBtn} title="Modifier">
                            <Pencil size={15} />
                          </button>
                          <button onClick={() => deletePolicy(p)} className={iconBtnDanger} title="Supprimer">
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Groups */}
      {!loading && tab === "groups" && (
        <>
          {refs.groups.length === 0 ? (
            <div className="bg-card border rounded-lg p-12 text-center">
              <Users size={48} className="mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                Aucun groupe. Les groupes simplifient l'attribution des règles d'accès.
              </p>
            </div>
          ) : (
            <div className="bg-card border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Groupe</th>
                    <th className="text-left p-3 font-medium">Membres</th>
                    <th className="text-left p-3 font-medium">Créé le</th>
                    <th className="text-right p-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {refs.groups.map((g) => (
                    <tr key={g.id} className="border-b last:border-0 align-top hover:bg-muted/30">
                      <td className="p-3">
                        <p className="font-medium">{g.name}</p>
                        {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1 max-w-xl">
                          {g.users.length === 0 && (
                            <span className="text-xs text-muted-foreground">aucun membre</span>
                          )}
                          {g.users.map((u) => (
                            <Chip key={u.id} title={u.email}>
                              {u.display_name}
                            </Chip>
                          ))}
                        </div>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">{formatDate(g.created_at, false)}</td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <button onClick={() => setEditGroup(g)} className={iconBtn} title="Modifier">
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => deleteGroup(g)} className={iconBtnDanger} title="Supprimer">
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Effective access */}
      {!loading && tab === "effective" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <select value={effUser} onChange={(e) => setEffUser(e.target.value)} className={`${inputCls} max-w-sm`}>
              <option value="">Choisir un utilisateur</option>
              {refs.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.email}, {u.role})
                </option>
              ))}
            </select>
            {effLoading && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
          </div>
          <ErrorBox message={effError} />
          {selectedEffUser && effRows && (
            <div className="bg-card border rounded-lg overflow-hidden">
              <div className="p-3 border-b text-sm">
                <strong>{selectedEffUser.display_name}</strong> accède à {effRows.length} serveur(s)
                {selectedEffUser.role === "admin" && " (administrateur : accès complet)"}.
              </div>
              <AccessTable rows={effRows} />
            </div>
          )}
        </div>
      )}

      {/* Discovered accounts (all servers) */}
      {!loading && tab === "discovered" && <DiscoveredAccountsPanel servers={refs.servers} />}

      {editPolicy !== undefined && (
        <PolicyModal
          policy={editPolicy}
          refs={refs}
          onClose={() => setEditPolicy(undefined)}
          onSaved={() => {
            setEditPolicy(undefined);
            load();
          }}
        />
      )}
      {editGroup !== undefined && (
        <GroupModal
          group={editGroup}
          users={refs.users}
          onClose={() => setEditGroup(undefined)}
          onSaved={() => {
            setEditGroup(undefined);
            load();
          }}
        />
      )}
    </div>
  );
}
