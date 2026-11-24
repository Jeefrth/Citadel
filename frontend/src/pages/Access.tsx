import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  CalendarClock,
  Download,
  Eye,
  FileUp,
  Loader2,
  Pencil,
  Plus,
  Power,
  Radar,
  ServerOff,
  ShieldBan,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  UserSearch,
  Users,
} from "lucide-react";
import { api, fetchBlob, saveBlob } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  VIRTUAL_ACCOUNTS,
  VIRTUAL_ACCOUNT_HELP,
  errorMessage,
  type AccessPolicyData,
  type NodeData,
  type PolicyImportReport,
  type ServerAccess,
  type ServerAction,
  type ServerData,
  type UserData,
  type UserGroupData,
} from "@/services/types";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  MultiSelect,
  PageHeader,
  SaveButton,
  Tabs,
  formatDate,
  iconBtn,
  iconBtnDanger,
  type Option,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DiscoveredAccountsPanel } from "@/components/DiscoveredAccounts";
import { CommandRulesPanel, ConnectionRulesPanel } from "@/components/AclRules";

type Tab = "policies" | "groups" | "effective" | "discovered" | "acl-connection" | "acl-command";

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

/** Account chip: technical value in mono, virtual accounts (@ALL...) highlighted. */
function AccountChip({ account, onRemove }: { account: string; onRemove?: () => void }) {
  return (
    <Chip
      tone={account.startsWith("@") ? "primary" : "default"}
      title={(VIRTUAL_ACCOUNT_HELP as Record<string, string>)[account]}
      onRemove={onRemove}
    >
      <span className="font-mono">{account === "*" ? "tous" : account}</span>
    </Chip>
  );
}

/** Small section title inside a dialog (sentence case, no uppercase). */
function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="mb-3 text-sm font-medium">{children}</h4>;
}

/** Amber inline hint for a form state that is valid but probably not intended. */
function WarnHint({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs text-live">{children}</p>;
}

/** Table skeleton: a few rows of the given column count. */
export function TableSkeleton({ cols = 5, rows = 4 }: { cols?: number; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex gap-4 border-b px-3 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b px-3 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className={cn("h-4 flex-1", i === 0 && "max-w-48")} />
          ))}
        </div>
      ))}
    </div>
  );
}

function policyState(p: AccessPolicyData): { label: string; tone: "green" | "amber" | "default" } {
  if (!p.is_active) return { label: "Désactivée", tone: "default" };
  const now = Date.now();
  if (p.valid_from && new Date(p.valid_from).getTime() > now) return { label: "Planifiée", tone: "amber" };
  if (p.valid_until && new Date(p.valid_until).getTime() < now) return { label: "Expirée", tone: "default" };
  return { label: "Active", tone: "green" };
}

/** Rules ending within this many days get an "ends soon" badge. */
const EXPIRY_WARNING_DAYS = 7;

/** "Expire dans 3 j" for an active rule ending within EXPIRY_WARNING_DAYS, else null. */
function expiresSoon(p: AccessPolicyData): string | null {
  if (!p.is_active || !p.valid_until) return null;
  const left = new Date(p.valid_until).getTime() - Date.now();
  if (left <= 0 || left > EXPIRY_WARNING_DAYS * 86_400_000) return null;
  const hours = Math.ceil(left / 3_600_000);
  return hours < 24 ? `Expire dans ${hours} h` : `Expire dans ${Math.ceil(hours / 24)} j`;
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
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {policy ? "Enregistrer la règle" : "Créer la règle"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nom *">
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Ops prod Linux"
            autoFocus
          />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Valide à partir du" hint="Laisser vide pour une validité immédiate.">
          <Input
            type="datetime-local"
            value={form.valid_from}
            onChange={(e) => set({ valid_from: e.target.value })}
            className="tabular dark:[color-scheme:dark]"
          />
        </Field>
        <Field label="Valide jusqu'au" hint="Laisser vide pour une validité illimitée.">
          <Input
            type="datetime-local"
            value={form.valid_until}
            onChange={(e) => set({ valid_until: e.target.value })}
            className="tabular dark:[color-scheme:dark]"
          />
        </Field>
      </div>

      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={form.is_active} onCheckedChange={(v) => set({ is_active: v === true })} />
        Règle active
      </label>

      {/* Who */}
      <div className="border-t pt-4">
        <SectionTitle>Bénéficiaires</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
          <WarnHint>Aucun bénéficiaire : la règle ne donnera accès à personne.</WarnHint>
        )}
      </div>

      {/* What */}
      <div className="border-t pt-4">
        <SectionTitle>Serveurs ciblés</SectionTitle>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                  <span className="font-mono">{l}</span>
                </Chip>
              ))}
            </div>
            <div className="flex gap-2">
              <Select value="" onValueChange={addLabel} disabled={labelSelectors.length === 0}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      labelSelectors.length === 0 ? "Aucune étiquette existante" : "Choisir une étiquette existante"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {labelSelectors
                    .filter((l) => !form.labels.includes(l))
                    .map((l) => (
                      <SelectItem key={l} value={l}>
                        <span className="font-mono">{l}</span>
                        {l.endsWith("=") && <span className="text-muted-foreground"> (toutes valeurs)</span>}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input
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
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  addLabel(labelInput);
                  setLabelInput("");
                }}
                disabled={!labelInput.includes("=")}
                title="Ajouter l'étiquette"
              >
                <Plus />
              </Button>
            </div>
          </Field>
        </div>
        {noTarget && (
          <WarnHint>Aucune cible : la règle ne couvre aucun serveur.</WarnHint>
        )}
      </div>

      {/* How */}
      <div className="grid grid-cols-1 gap-4 border-t pt-4 md:grid-cols-2">
        <Field label="Comptes autorisés">
          <div className="flex flex-wrap gap-1 mb-2 min-h-[1.5rem]">
            {form.accounts.length === 0 && (
              <span className="text-xs text-muted-foreground">Aucun compte</span>
            )}
            {form.accounts.map((a) => (
              <AccountChip
                key={a}
                account={a}
                onRemove={() => set({ accounts: form.accounts.filter((x) => x !== a) })}
              />
            ))}
          </div>
          <div className="flex gap-2 mb-2">
            <Input
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
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={() => {
                addAccount(accountInput);
                setAccountInput("");
              }}
              disabled={!accountInput.trim()}
              title="Ajouter le compte"
            >
              <Plus />
            </Button>
          </div>
          <div className="space-y-1">
            {VIRTUAL_ACCOUNTS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => addAccount(v)}
                disabled={form.accounts.includes(v)}
                className="flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-xs transition-colors hover:bg-accent disabled:opacity-40"
              >
                <Plus className="size-3 text-muted-foreground" />
                <span className="font-mono font-medium w-14">{v}</span>
                <span className="text-muted-foreground">{VIRTUAL_ACCOUNT_HELP[v]}</span>
              </button>
            ))}
          </div>
          {unknownVirtual.length > 0 && (
            <p className="mt-1 text-xs text-danger">
              Compte virtuel inconnu : <span className="font-mono">{unknownVirtual.join(", ")}</span>
            </p>
          )}
        </Field>
        <Field label="Actions autorisées">
          <div className="space-y-2">
            {ALL_ACTIONS.map((a) => (
              <label key={a} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={form.actions.includes(a)} onCheckedChange={() => toggleAction(a)} />
                {ACTION_LABELS[a]}
                <span className="text-xs text-muted-foreground">
                  {
                    {
                      connect: "terminal SSH / session RDP",
                      execute: "commandes et mises à jour",
                      copy: "presse-papiers distant vers local (RDP)",
                      paste: "presse-papiers local vers distant (RDP)",
                      upload: "envoyer, créer, renommer, supprimer (SFTP, Linux)",
                      download: "parcourir et télécharger (SFTP, Linux)",
                    }[a]
                  }
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
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
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!name.trim()}>
            {group ? "Enregistrer le groupe" : "Créer le groupe"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom *">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
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
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
        <ServerOff className="size-4" strokeWidth={1.75} />
        Aucun serveur accessible pour le moment.
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="px-3">Serveur</TableHead>
          <TableHead className="px-3">Actions</TableHead>
          <TableHead className="px-3">Comptes</TableHead>
          <TableHead className="px-3">Accordé par</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.server_id}>
            <TableCell className="px-3 font-medium">{r.server_name}</TableCell>
            <TableCell className="px-3">
              <div className="flex flex-wrap gap-1">
                {r.actions.map((a) => (
                  <Chip key={a} tone={a === "execute" || a === "*" ? "amber" : "green"}>
                    {ACTION_LABELS[a] || a}
                  </Chip>
                ))}
              </div>
            </TableCell>
            <TableCell className="px-3">
              <div className="flex flex-wrap gap-1">
                {r.accounts.map((a) => (
                  <AccountChip key={a} account={a} />
                ))}
              </div>
            </TableCell>
            <TableCell className="px-3 text-xs text-muted-foreground">
              {r.policies.map((p) => (p === "admin" ? "rôle administrateur" : p)).join(", ")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Icon button with a tooltip (row actions). */
function RowAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} className={danger ? iconBtnDanger : iconBtn} aria-label={label}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const rowExit = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.18 },
};

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
  const [confirmPolicy, setConfirmPolicy] = useState<AccessPolicyData | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<UserGroupData | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);

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

  if (userLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <TableSkeleton />
      </div>
    );
  }
  if (!isAdmin) return <Navigate to="/" replace />;

  const togglePolicy = async (p: AccessPolicyData) => {
    try {
      const updated = await api.patch<AccessPolicyData>(`/api/access-policies/${p.id}`, {
        is_active: !p.is_active,
      });
      setPolicies((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
      toast.success(updated.is_active ? `Règle ${p.name} activée` : `Règle ${p.name} désactivée`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const deletePolicy = async () => {
    const p = confirmPolicy;
    if (!p) return;
    setDeleting(true);
    try {
      await api.delete(`/api/access-policies/${p.id}`);
      setPolicies((prev) => prev.filter((x) => x.id !== p.id));
      toast.success(`Règle ${p.name} supprimée`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
      setConfirmPolicy(null);
    }
  };

  const deleteGroup = async () => {
    const g = confirmGroup;
    if (!g) return;
    setDeleting(true);
    try {
      await api.delete(`/api/user-groups/${g.id}`);
      toast.success(`Groupe ${g.name} supprimé`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
      setConfirmGroup(null);
    }
  };

  const selectedEffUser = refs.users.find((u) => u.id === effUser);

  const exportPolicies = async () => {
    setExporting(true);
    try {
      const blob = await fetchBlob("/api/access-policies/export");
      saveBlob(blob, `citadel-regles-acces-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
      setError(`Export impossible : ${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Accès"
        description="Qui peut se connecter à quels serveurs, avec quels comptes et quelles actions."
        actions={
          <>
            {tab === "policies" && (
              <>
                <Button variant="outline" onClick={exportPolicies} disabled={exporting || policies.length === 0}>
                  {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                  Exporter
                </Button>
                <Button variant="outline" onClick={() => setShowImport(true)}>
                  <Upload /> Importer
                </Button>
                <Button onClick={() => setEditPolicy(null)}>
                  <Plus /> Nouvelle règle
                </Button>
              </>
            )}
            {tab === "groups" && (
              <Button onClick={() => setEditGroup(null)}>
                <Plus /> Nouveau groupe
              </Button>
            )}
          </>
        }
      />

      <Tabs<Tab>
        tabs={[
          { id: "policies", label: "Règles d'accès", icon: ShieldCheck },
          { id: "groups", label: "Groupes d'utilisateurs", icon: Users },
          { id: "effective", label: "Accès effectifs", icon: Eye },
          { id: "discovered", label: "Comptes découverts", icon: Radar },
          { id: "acl-connection", label: "ACL de connexion", icon: ShieldBan },
          { id: "acl-command", label: "ACL de commandes", icon: TerminalSquare },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error && (
        <div className="mb-4">
          <ErrorBox message={error} />
        </div>
      )}
      {loading && <TableSkeleton cols={6} />}

      {/* Policies */}
      {!loading && tab === "policies" && (
        <div className="space-y-4">
          <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
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
                  <span className="font-mono text-foreground">{v}</span> = {VIRTUAL_ACCOUNT_HELP[v].toLowerCase()}
                  {i < VIRTUAL_ACCOUNTS.length - 1 ? " ; " : "."}
                </span>
              ))}
            </p>
          </div>
          {policies.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="Aucune règle d'accès"
              action={
                <Button onClick={() => setEditPolicy(null)}>
                  <Plus /> Nouvelle règle
                </Button>
              }
            >
              Seuls les administrateurs voient les serveurs. Créez une règle pour ouvrir l'accès à d'autres
              utilisateurs.
            </EmptyState>
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-3">Règle</TableHead>
                    <TableHead className="px-3">Statut</TableHead>
                    <TableHead className="px-3">Bénéficiaires</TableHead>
                    <TableHead className="px-3">Cibles</TableHead>
                    <TableHead className="px-3">Comptes</TableHead>
                    <TableHead className="px-3">Actions</TableHead>
                    <TableHead className="px-3">
                      <span className="sr-only">Gestion</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {policies.map((p) => {
                      const st = policyState(p);
                      const soon = expiresSoon(p);
                      return (
                        <motion.tr
                          key={p.id}
                          layout
                          {...rowExit}
                          className={cn(
                            "border-b align-top transition-colors hover:bg-muted/50",
                            !p.is_active && "text-muted-foreground",
                          )}
                        >
                          <TableCell className="px-3 py-2.5">
                            <p className="font-medium text-foreground">{p.name}</p>
                            {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                            {(p.valid_from || p.valid_until) && (
                              <p className="tabular mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                <CalendarClock className="size-3" />
                                {p.valid_from ? formatDate(p.valid_from) : "..."} au{" "}
                                {p.valid_until ? formatDate(p.valid_until) : "..."}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="px-3 py-2.5">
                            <div className="flex flex-col items-start gap-1">
                              <Chip tone={st.tone}>{st.label}</Chip>
                              {soon && (
                                <Chip tone="orange" title={`Fin le ${formatDate(p.valid_until)}`}>
                                  {soon}
                                </Chip>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-2.5">
                            <div className="flex max-w-xs flex-wrap gap-1">
                              {p.users.map((u) => (
                                <Chip key={u.id}>{u.name}</Chip>
                              ))}
                              {p.groups.map((g) => (
                                <Chip key={g.id} tone="primary">
                                  <Users className="size-3" /> {g.name}
                                </Chip>
                              ))}
                              {p.users.length + p.groups.length === 0 && (
                                <span className="text-xs text-live">aucun</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-2.5">
                            <div className="flex max-w-xs flex-wrap gap-1">
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
                                  <span className="font-mono">{l}</span>
                                </Chip>
                              ))}
                              {p.servers.length + p.nodes.length + p.labels.length === 0 && (
                                <span className="text-xs text-live">aucune</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {p.accounts.map((a) => (
                                <AccountChip key={a} account={a} />
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {p.actions.map((a) => (
                                <Chip key={a} tone={a === "execute" ? "amber" : "default"}>
                                  {ACTION_LABELS[a] || a}
                                </Chip>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap px-3 py-1.5 text-right">
                            <RowAction label={p.is_active ? "Désactiver" : "Activer"} onClick={() => togglePolicy(p)}>
                              <Power className={cn("size-4", p.is_active && "text-success")} />
                            </RowAction>
                            <RowAction label="Modifier" onClick={() => setEditPolicy(p)}>
                              <Pencil className="size-4" />
                            </RowAction>
                            <RowAction label="Supprimer" danger onClick={() => setConfirmPolicy(p)}>
                              <Trash2 className="size-4" />
                            </RowAction>
                          </TableCell>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      )}

      {/* Groups */}
      {!loading && tab === "groups" && (
        <>
          {refs.groups.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Aucun groupe"
              action={
                <Button onClick={() => setEditGroup(null)}>
                  <Plus /> Nouveau groupe
                </Button>
              }
            >
              Les groupes simplifient l'attribution des règles d'accès. Créez-en un pour commencer.
            </EmptyState>
          ) : (
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-3">Groupe</TableHead>
                    <TableHead className="px-3">Membres</TableHead>
                    <TableHead className="px-3">Créé le</TableHead>
                    <TableHead className="px-3">
                      <span className="sr-only">Gestion</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {refs.groups.map((g) => (
                    <TableRow key={g.id} className="align-top">
                      <TableCell className="px-3 py-2.5">
                        <p className="font-medium">{g.name}</p>
                        {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                      </TableCell>
                      <TableCell className="px-3 py-2.5">
                        <div className="flex max-w-xl flex-wrap gap-1">
                          {g.users.length === 0 && <span className="text-xs text-muted-foreground">aucun membre</span>}
                          {g.users.map((u) => (
                            <Chip key={u.id} title={u.email}>
                              {u.display_name}
                            </Chip>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="tabular px-3 py-2.5 text-xs text-muted-foreground">
                        {formatDate(g.created_at, false)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-3 py-1.5 text-right">
                        <RowAction label="Modifier" onClick={() => setEditGroup(g)}>
                          <Pencil className="size-4" />
                        </RowAction>
                        <RowAction label="Supprimer" danger onClick={() => setConfirmGroup(g)}>
                          <Trash2 className="size-4" />
                        </RowAction>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      {/* Effective access */}
      {!loading && tab === "effective" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Select value={effUser} onValueChange={setEffUser}>
              <SelectTrigger className="max-w-sm">
                <SelectValue placeholder="Choisir un utilisateur" />
              </SelectTrigger>
              <SelectContent>
                {refs.users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.display_name} <span className="text-muted-foreground">({u.email}, {u.role})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {effLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>
          <ErrorBox message={effError} />
          {!effUser && (
            <EmptyState icon={UserSearch} title="Choisissez un utilisateur">
              La liste montre les serveurs qu'il peut atteindre, avec les comptes, les actions et les règles qui les
              accordent.
            </EmptyState>
          )}
          {selectedEffUser && effRows && (
            <Card className="overflow-hidden">
              <div className="border-b px-3 py-2.5 text-sm">
                <span className="font-medium">{selectedEffUser.display_name}</span> accède à{" "}
                <span className="tabular">{effRows.length}</span> serveur(s)
                {selectedEffUser.role === "admin" && " (administrateur : accès complet)"}.
              </div>
              <AccessTable rows={effRows} />
            </Card>
          )}
        </div>
      )}

      {/* Discovered accounts (all servers) */}
      {!loading && tab === "discovered" && <DiscoveredAccountsPanel servers={refs.servers} />}

      {/* Connection / command ACLs */}
      {!loading && tab === "acl-connection" && <ConnectionRulesPanel refs={refs} />}
      {!loading && tab === "acl-command" && <CommandRulesPanel refs={refs} />}

      {editPolicy !== undefined && (
        <PolicyModal
          policy={editPolicy}
          refs={refs}
          onClose={() => setEditPolicy(undefined)}
          onSaved={() => {
            toast.success(editPolicy ? "Règle enregistrée" : "Règle créée");
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
            toast.success(editGroup ? "Groupe enregistré" : "Groupe créé");
            setEditGroup(undefined);
            load();
          }}
        />
      )}
      {showImport && (
        <ImportPoliciesModal
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            load();
          }}
        />
      )}

      {confirmPolicy && (
        <ConfirmModal
          title={`Supprimer la règle ${confirmPolicy.name}`}
          confirmLabel="Supprimer la règle"
          danger
          loading={deleting}
          onConfirm={deletePolicy}
          onClose={() => setConfirmPolicy(null)}
        >
          <p>Les accès qu'elle accorde sont retirés immédiatement.</p>
        </ConfirmModal>
      )}
      {confirmGroup && (
        <ConfirmModal
          title={`Supprimer le groupe ${confirmGroup.name}`}
          confirmLabel="Supprimer le groupe"
          danger
          loading={deleting}
          onConfirm={deleteGroup}
          onClose={() => setConfirmGroup(null)}
        >
          <p>Les règles qui le citent ne s'appliqueront plus à ses membres.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

// ── Import ───────────────────────────────────────────────────

function ImportList({ title, names, tone }: { title: string; names: string[]; tone: "green" | "blue" | "default" }) {
  if (names.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">
        {title} <span className="tabular text-muted-foreground">({names.length})</span>
      </p>
      <div className="flex flex-wrap gap-1">
        {names.map((n) => (
          <Chip key={n} tone={tone}>
            {n}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** Import access rules from a JSON export: always a simulation first, then the real import. */
function ImportPoliciesModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [report, setReport] = useState<PolicyImportReport | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (dryRun: boolean) => {
      if (!payload) return null;
      return api.post<PolicyImportReport>("/api/access-policies/import", {
        payload,
        overwrite,
        dry_run: dryRun,
      });
    },
    [payload, overwrite],
  );

  // Simulate whenever the file or the "replace" option changes
  useEffect(() => {
    if (!payload) return;
    let alive = true;
    setSimulating(true);
    setError(null);
    run(true)
      .then((r) => alive && setReport(r))
      .catch((e) => {
        if (!alive) return;
        setReport(null);
        setError(errorMessage(e));
      })
      .finally(() => alive && setSimulating(false));
    return () => {
      alive = false;
    };
  }, [payload, run]);

  const pickFile = async (file: File | undefined) => {
    setReport(null);
    setPayload(null);
    setError(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const data: unknown = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        setError("Ce fichier n'est pas un export de règles d'accès Citadel.");
        return;
      }
      setPayload(data as Record<string, unknown>);
    } catch {
      setError("Fichier illisible : choisissez le fichier JSON produit par « Exporter ».");
    }
  };

  const doImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const r = await run(false);
      if (r) {
        const parts = [
          `${r.created.length} créée${r.created.length > 1 ? "s" : ""}`,
          `${r.updated.length} remplacée${r.updated.length > 1 ? "s" : ""}`,
        ];
        if (r.skipped.length) parts.push(`${r.skipped.length} ignorée${r.skipped.length > 1 ? "s" : ""}`);
        if (r.errors.length) parts.push(`${r.errors.length} en erreur`);
        toast.success(`Règles importées : ${parts.join(", ")}`);
      }
      onImported();
    } catch (e) {
      setError(errorMessage(e));
      setImporting(false);
    }
  };

  const toApply = report ? report.created.length + report.updated.length : 0;

  return (
    <Modal
      title="Importer des règles d'accès"
      description="Fichier JSON produit par « Exporter », depuis ce Citadel ou un autre."
      size="2xl"
      onClose={importing ? () => {} : onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Annuler
          </Button>
          <SaveButton onClick={doImport} loading={importing} disabled={!report || simulating || toApply === 0}>
            Importer
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Fichier" hint="Les références sont des noms : utilisateurs par e-mail, groupes et serveurs par nom, nœuds par chemin.">
        <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-3 py-3 text-sm hover:bg-muted/50">
          <FileUp className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 truncate", fileName ? "font-mono text-xs" : "text-muted-foreground")}>
            {fileName || "Choisir un fichier JSON"}
          </span>
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </Field>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <Checkbox checked={overwrite} onCheckedChange={(v) => setOverwrite(v === true)} className="mt-0.5" />
        <span>
          Remplacer les règles existantes
          <span className="block text-xs text-muted-foreground">
            Sinon, une règle qui porte déjà le même nom est ignorée.
          </span>
        </span>
      </label>

      {simulating && (
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-5 w-full" />
        </div>
      )}
      {report && !simulating && (
        <div className="space-y-3 rounded-md border bg-muted/40 p-3">
          <p className="text-sm">
            Simulation : <span className="tabular font-medium">{report.created.length}</span> à créer,{" "}
            <span className="tabular font-medium">{report.updated.length}</span> à remplacer,{" "}
            <span className="tabular font-medium">{report.skipped.length}</span> ignorée
            {report.skipped.length > 1 ? "s" : ""},{" "}
            <span className={cn("tabular font-medium", report.errors.length > 0 && "text-danger")}>
              {report.errors.length}
            </span>{" "}
            en erreur. Rien n'est encore enregistré.
          </p>
          <ImportList title="À créer" names={report.created} tone="green" />
          <ImportList title="À remplacer" names={report.updated} tone="blue" />
          <ImportList title="Ignorées (existent déjà)" names={report.skipped} tone="default" />
          {report.errors.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-danger">
                En erreur, non importées <span className="tabular">({report.errors.length})</span>
              </p>
              <ul className="space-y-1 text-sm">
                {report.errors.map((e, i) => (
                  <li key={`${e.name}-${i}`}>
                    <span className="font-medium">{e.name}</span>
                    <span className="text-muted-foreground"> : {e.problems.join(" ; ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {toApply === 0 && <p className="text-xs text-muted-foreground">Aucune règle à importer.</p>}
        </div>
      )}
    </Modal>
  );
}
