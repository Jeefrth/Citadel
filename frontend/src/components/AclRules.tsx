// Connection ACL and command ACL tabs of the "Accès" page (admin).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  ShieldBan,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type CommandRuleAction,
  type CommandRuleData,
  type CommandRuleIn,
  type ConnectRuleAction,
  type ConnectionRuleData,
  type ConnectionRuleIn,
  type NodeData,
  type RuleDecision,
  type RuleScope,
  type ServerData,
  type TimeWindow,
  type UserData,
  type UserGroupData,
} from "@/services/types";
import {
  Chip,
  ConfirmModal,
  ErrorBox,
  Field,
  Modal,
  MultiSelect,
  Notice,
  SaveButton,
  Toggle,
  btnPrimary,
  btnSecondary,
  iconBtn,
  iconBtnDanger,
  inputCls,
  type NoticeData,
  type Option,
} from "@/components/ui";
import { RULE_ACTION_INFO, RuleActionChip } from "@/components/governanceUi";

export interface AclRefs {
  users: UserData[];
  groups: UserGroupData[];
  servers: ServerData[];
  nodes: NodeData[];
  labels: Record<string, string[]>;
}

// ── Small editors ────────────────────────────────────────────

/** Chips + input for a list of free strings (accounts, IPs, labels, regexes). */
function StringListEditor({
  value,
  onChange,
  placeholder,
  emptyText,
  mono,
  validate,
  suggestions,
  listId,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  emptyText: string;
  mono?: boolean;
  /** Returns an error message, or null when the value is acceptable. */
  validate?: (v: string) => string | null;
  suggestions?: string[];
  listId?: string;
}) {
  const [input, setInput] = useState("");
  const trimmed = input.trim();
  const err = trimmed && validate ? validate(trimmed) : null;
  const add = () => {
    if (!trimmed || err || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setInput("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2 min-h-[1.5rem]">
        {value.length === 0 && <span className="text-xs text-muted-foreground">{emptyText}</span>}
        {value.map((v) => (
          <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>
            <span className={mono ? "font-mono" : ""}>{v}</span>
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          list={listId}
          placeholder={placeholder}
          className={`${inputCls} ${mono ? "font-mono" : ""}`}
        />
        <button type="button" onClick={add} disabled={!trimmed || !!err} className={btnSecondary} title="Ajouter">
          <Plus size={16} />
        </button>
        {listId && suggestions && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      {err && <p className="text-xs text-red-700 mt-1">{err}</p>}
    </div>
  );
}

const DAY_LETTERS = ["L", "M", "M", "J", "V", "S", "D"];
const DAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

function TimeWindowEditor({ value, onChange }: { value: TimeWindow[]; onChange: (v: TimeWindow[]) => void }) {
  const update = (i: number, patch: Partial<TimeWindow>) =>
    onChange(value.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucune plage : la règle s'applique à toute heure.</p>
      )}
      {value.map((w, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 p-2 border rounded-md">
          <div className="flex gap-1">
            {DAY_LETTERS.map((d, day) => {
              const on = w.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  title={DAY_NAMES[day]}
                  onClick={() =>
                    update(i, {
                      days: on ? w.days.filter((x) => x !== day) : [...w.days, day].sort((a, b) => a - b),
                    })
                  }
                  className={`w-7 h-7 rounded text-xs font-medium border ${
                    on ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <input
            type="time"
            value={w.start}
            onChange={(e) => update(i, { start: e.target.value })}
            className={`${inputCls} w-28`}
          />
          <span className="text-sm text-muted-foreground">à</span>
          <input
            type="time"
            value={w.end}
            onChange={(e) => update(i, { end: e.target.value })}
            className={`${inputCls} w-28`}
          />
          {w.end < w.start && <span className="text-xs text-muted-foreground">(passe minuit)</span>}
          {w.days.length === 0 && <span className="text-xs text-red-700">choisir au moins un jour</span>}
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className={`${iconBtnDanger} ml-auto`}
            title="Retirer la plage"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, { days: [0, 1, 2, 3, 4], start: "08:00", end: "18:00" }])}
        className={btnSecondary}
      >
        <Plus size={15} /> Ajouter une plage
      </button>
    </div>
  );
}

function formatWindow(w: TimeWindow): string {
  const days =
    w.days.length === 7
      ? "tous les jours"
      : w.days.length === 5 && [0, 1, 2, 3, 4].every((d) => w.days.includes(d))
        ? "L à V"
        : w.days.map((d) => DAY_LETTERS[d]).join(" ");
  return `${days} ${w.start} à ${w.end}`;
}

function isIpOrCidr(v: string): string | null {
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/;
  const ipv6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;
  if (ipv4.test(v)) {
    const [ip, mask] = v.split("/");
    if (ip.split(".").some((o) => Number(o) > 255)) return "Adresse IPv4 invalide";
    if (mask !== undefined && Number(mask) > 32) return "Masque invalide";
    return null;
  }
  if (v.includes(":") && ipv6.test(v)) return null;
  return "Adresse IP ou plage CIDR attendue (ex. 10.0.0.0/8)";
}

function isRegex(v: string): string | null {
  try {
    new RegExp(v, "i");
    return null;
  } catch {
    return "Expression régulière invalide";
  }
}

// ── Rule targets summary (table cell) ────────────────────────

function TargetsSummary({
  rule,
  nodePaths,
  showServers = true,
}: {
  rule: ConnectionRuleData | CommandRuleData;
  nodePaths: Map<string, string>;
  showServers?: boolean;
}) {
  const who = rule.users.length + rule.groups.length;
  const where = rule.servers.length + rule.nodes.length + rule.labels.length;
  return (
    <div className="space-y-1.5 max-w-sm">
      <div className="flex flex-wrap gap-1 items-center">
        <span className="text-[11px] text-muted-foreground w-14">Qui</span>
        {who === 0 && <span className="text-xs text-muted-foreground">tout le monde</span>}
        {rule.users.map((u) => (
          <Chip key={u.id}>{u.name}</Chip>
        ))}
        {rule.groups.map((g) => (
          <Chip key={g.id} tone="primary">
            <Users size={11} /> {g.name}
          </Chip>
        ))}
      </div>
      {showServers && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[11px] text-muted-foreground w-14">Où</span>
          {where === 0 && <span className="text-xs text-muted-foreground">tous les serveurs</span>}
          {rule.servers.map((s) => (
            <Chip key={s.id}>{s.name}</Chip>
          ))}
          {rule.nodes.map((n) => (
            <Chip key={n.id} tone="green">
              {nodePaths.get(n.id) || n.name}/*
            </Chip>
          ))}
          {rule.labels.map((l) => (
            <Chip key={l} tone="blue">
              {l}
            </Chip>
          ))}
        </div>
      )}
      {showServers && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[11px] text-muted-foreground w-14">Comptes</span>
          {rule.accounts.length === 0 && <span className="text-xs text-muted-foreground">tous</span>}
          {rule.accounts.map((a) => (
            <Chip key={a}>
              <span className="font-mono">{a}</span>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared form pieces ───────────────────────────────────────

interface TargetsForm {
  name: string;
  description: string;
  priority: number;
  is_active: boolean;
  user_ids: string[];
  group_ids: string[];
  server_ids: string[];
  node_ids: string[];
  labels: string[];
  accounts: string[];
  approver_group_ids: string[];
}

function targetsFromRule(r: ConnectionRuleData | CommandRuleData | null): TargetsForm {
  return r
    ? {
        name: r.name,
        description: r.description || "",
        priority: r.priority,
        is_active: r.is_active,
        user_ids: r.users.map((x) => x.id),
        group_ids: r.groups.map((x) => x.id),
        server_ids: r.servers.map((x) => x.id),
        node_ids: r.nodes.map((x) => x.id),
        labels: [...r.labels],
        accounts: [...r.accounts],
        approver_group_ids: r.approver_groups.map((x) => x.id),
      }
    : {
        name: "",
        description: "",
        priority: 50,
        is_active: true,
        user_ids: [],
        group_ids: [],
        server_ids: [],
        node_ids: [],
        labels: [],
        accounts: [],
        approver_group_ids: [],
      };
}

function targetsBody(f: TargetsForm) {
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    priority: f.priority,
    is_active: f.is_active,
    user_ids: f.user_ids,
    group_ids: f.group_ids,
    server_ids: f.server_ids,
    node_ids: f.node_ids,
    labels: f.labels,
    accounts: f.accounts,
    approver_group_ids: f.approver_group_ids,
  };
}

function connBody(r: ConnectionRuleData): ConnectionRuleIn {
  return {
    ...targetsBody(targetsFromRule(r)),
    scope: r.scope,
    action: r.action,
    source_ips: r.source_ips,
    time_windows: r.time_windows,
  };
}

function cmdBody(r: CommandRuleData): CommandRuleIn {
  return { ...targetsBody(targetsFromRule(r)), action: r.action, patterns: r.patterns };
}

function useOptions(refs: AclRefs) {
  return useMemo(() => {
    const users: Option[] = refs.users.map((u) => ({ id: u.id, label: u.display_name, sub: u.email }));
    const groups: Option[] = refs.groups.map((g) => ({ id: g.id, label: g.name, sub: `${g.users.length} membre(s)` }));
    const servers: Option[] = refs.servers.map((s) => ({ id: s.id, label: s.name, sub: s.node_path || s.ip_address }));
    const nodes: Option[] = refs.nodes.map((n) => ({ id: n.id, label: n.path }));
    const labels = Object.entries(refs.labels).flatMap(([k, vals]) => [`${k}=`, ...vals.map((v) => `${k}=${v}`)]);
    return { users, groups, servers, nodes, labels };
  }, [refs]);
}

function GeneralFields({ form, set }: { form: TargetsForm; set: (p: Partial<TargetsForm>) => void }) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Nom *">
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} autoFocus />
        </Field>
        <Field label="Description">
          <input
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Priorité" hint="0 à 10000, la plus basse est évaluée en premier.">
          <input
            type="number"
            min={0}
            max={10000}
            value={form.priority}
            onChange={(e) => set({ priority: Number(e.target.value) })}
            className={inputCls}
          />
        </Field>
      </div>
      <Toggle checked={form.is_active} onChange={(is_active) => set({ is_active })} label="Règle active" />
    </>
  );
}

function WhoFields({
  form,
  set,
  opts,
}: {
  form: TargetsForm;
  set: (p: Partial<TargetsForm>) => void;
  opts: ReturnType<typeof useOptions>;
}) {
  return (
    <div className="border-t pt-4">
      <h4 className="text-xs font-medium text-muted-foreground uppercase mb-3">Utilisateurs concernés</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Utilisateurs">
          <MultiSelect options={opts.users} selected={form.user_ids} onChange={(user_ids) => set({ user_ids })} />
        </Field>
        <Field label="Groupes">
          <MultiSelect options={opts.groups} selected={form.group_ids} onChange={(group_ids) => set({ group_ids })} />
        </Field>
      </div>
      {form.user_ids.length + form.group_ids.length === 0 && (
        <p className="text-xs text-muted-foreground mt-2">Aucune sélection : la règle concerne tout le monde.</p>
      )}
    </div>
  );
}

function WhereFields({
  form,
  set,
  opts,
  listPrefix,
}: {
  form: TargetsForm;
  set: (p: Partial<TargetsForm>) => void;
  opts: ReturnType<typeof useOptions>;
  listPrefix: string;
}) {
  return (
    <div className="border-t pt-4 space-y-4">
      <h4 className="text-xs font-medium text-muted-foreground uppercase">Serveurs et comptes ciblés</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Serveurs">
          <MultiSelect
            options={opts.servers}
            selected={form.server_ids}
            onChange={(server_ids) => set({ server_ids })}
          />
        </Field>
        <Field label="Nœuds" hint="Un nœud inclut tous ses sous-nœuds.">
          <MultiSelect options={opts.nodes} selected={form.node_ids} onChange={(node_ids) => set({ node_ids })} />
        </Field>
        <Field label="Étiquettes" hint="« clé= » correspond à toutes les valeurs de la clé.">
          <StringListEditor
            value={form.labels}
            onChange={(labels) => set({ labels })}
            placeholder="clé=valeur"
            emptyText="Aucune étiquette"
            validate={(v) => (v.includes("=") && !v.startsWith("=") ? null : "Format attendu : clé=valeur")}
            suggestions={opts.labels}
            listId={`${listPrefix}-labels`}
          />
        </Field>
        <Field label="Comptes" hint="Noms d'utilisateur sur le serveur. Vide = tous les comptes.">
          <StringListEditor
            value={form.accounts}
            onChange={(accounts) => set({ accounts })}
            placeholder="root, administrator..."
            emptyText="Tous les comptes"
            mono
          />
        </Field>
      </div>
      {form.server_ids.length + form.node_ids.length + form.labels.length === 0 && (
        <p className="text-xs text-muted-foreground">Aucun serveur choisi : la règle couvre tous les serveurs.</p>
      )}
    </div>
  );
}

function ApproverFields({
  form,
  set,
  opts,
}: {
  form: TargetsForm;
  set: (p: Partial<TargetsForm>) => void;
  opts: ReturnType<typeof useOptions>;
}) {
  return (
    <div className="border-t pt-4">
      <Field
        label="Groupes de valideurs"
        hint="Vide = les administrateurs. Le demandeur ne peut jamais valider sa propre demande."
      >
        <MultiSelect
          options={opts.groups}
          selected={form.approver_group_ids}
          onChange={(approver_group_ids) => set({ approver_group_ids })}
          emptyText="Aucun groupe"
        />
      </Field>
    </div>
  );
}

function ActionPicker<T extends string>({
  actions,
  value,
  onChange,
  help,
}: {
  actions: T[];
  value: T;
  onChange: (v: T) => void;
  help: Record<T, string>;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {actions.map((a) => {
        const info = RULE_ACTION_INFO[a as keyof typeof RULE_ACTION_INFO];
        return (
          <label
            key={a}
            className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer text-sm ${
              value === a ? "border-primary bg-primary/5" : "hover:bg-accent"
            }`}
          >
            <input type="radio" checked={value === a} onChange={() => onChange(a)} className="mt-1" />
            <span>
              <span className="font-medium">{info?.label || a}</span>
              <span className="block text-xs text-muted-foreground">{help[a]}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ── Connection rule dialog ───────────────────────────────────

function ConnectionRuleModal({
  rule,
  refs,
  onClose,
  onSaved,
}: {
  rule: ConnectionRuleData | null;
  refs: AclRefs;
  onClose: () => void;
  onSaved: () => void;
}) {
  const opts = useOptions(refs);
  const [form, setForm] = useState<TargetsForm>(() => targetsFromRule(rule));
  const [scope, setScope] = useState<RuleScope>(rule?.scope || "connect");
  const [action, setAction] = useState<ConnectRuleAction>(rule?.action || "deny");
  const [sourceIps, setSourceIps] = useState<string[]>(rule?.source_ips || []);
  const [windows, setWindows] = useState<TimeWindow[]>(rule?.time_windows || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<TargetsForm>) => setForm((f) => ({ ...f, ...p }));

  // "review" only makes sense for server connections
  useEffect(() => {
    if (scope === "login" && action === "review") setAction("deny");
  }, [scope, action]);

  const valid =
    form.name.trim() !== "" &&
    form.priority >= 0 &&
    form.priority <= 10000 &&
    windows.every((w) => w.days.length > 0 && w.start && w.end);

  const save = async () => {
    setLoading(true);
    setError(null);
    const login = scope === "login";
    const body: ConnectionRuleIn = {
      ...targetsBody(form),
      // Server targeting is meaningless for a login rule
      server_ids: login ? [] : form.server_ids,
      node_ids: login ? [] : form.node_ids,
      labels: login ? [] : form.labels,
      accounts: login ? [] : form.accounts,
      approver_group_ids: action === "review" ? form.approver_group_ids : [],
      scope,
      action,
      source_ips: sourceIps,
      time_windows: windows,
    };
    try {
      if (rule) await api.put(`/api/acl/connection-rules/${rule.id}`, body);
      else await api.post("/api/acl/connection-rules", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={rule ? `Modifier la règle ${rule.name}` : "Nouvelle règle de connexion"}
      onClose={onClose}
      size="3xl"
      footer={
        <>
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {rule ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <GeneralFields form={form} set={set} />

      <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Portée">
          <div className="space-y-2">
            {(
              [
                ["connect", "Connexion aux serveurs", "Terminal, RDP et exécution de commandes."],
                ["login", "Accès à Citadel", "Toute utilisation de l'application elle-même."],
              ] as [RuleScope, string, string][]
            ).map(([id, label, help]) => (
              <label
                key={id}
                className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer text-sm ${
                  scope === id ? "border-primary bg-primary/5" : "hover:bg-accent"
                }`}
              >
                <input type="radio" checked={scope === id} onChange={() => setScope(id)} className="mt-1" />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{help}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Action">
          <ActionPicker<ConnectRuleAction>
            actions={scope === "login" ? ["allow", "deny"] : ["allow", "deny", "review"]}
            value={action}
            onChange={setAction}
            help={{
              allow: "Autorise et arrête l'évaluation.",
              deny: "Refuse la connexion.",
              review: "Demande une validation avant chaque connexion.",
            }}
          />
        </Field>
      </div>
      {scope === "login" && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
          Une règle d'accès à Citadel peut vous bloquer : l'enregistrement est refusé si elle vous empêche de vous
          connecter depuis votre adresse actuelle. Ajoutez d'abord une règle « Autoriser » pour vos adresses
          d'administration.
        </p>
      )}

      <WhoFields form={form} set={set} opts={opts} />
      {scope === "connect" && <WhereFields form={form} set={set} opts={opts} listPrefix="conn" />}

      <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Adresses source" hint="IP ou CIDR. Vide = toutes les adresses.">
          <StringListEditor
            value={sourceIps}
            onChange={setSourceIps}
            placeholder="192.168.10.0/24"
            emptyText="Toutes les adresses"
            mono
            validate={isIpOrCidr}
          />
        </Field>
        <Field label="Plages horaires" hint="Fuseau horaire configuré dans Citadel (TIMEZONE). Une fin avant le début passe minuit.">
          <TimeWindowEditor value={windows} onChange={setWindows} />
        </Field>
      </div>

      {action === "review" && <ApproverFields form={form} set={set} opts={opts} />}
    </Modal>
  );
}

// ── Command rule dialog ──────────────────────────────────────

function CommandRuleModal({
  rule,
  refs,
  onClose,
  onSaved,
}: {
  rule: CommandRuleData | null;
  refs: AclRefs;
  onClose: () => void;
  onSaved: () => void;
}) {
  const opts = useOptions(refs);
  const [form, setForm] = useState<TargetsForm>(() => targetsFromRule(rule));
  const [action, setAction] = useState<CommandRuleAction>(rule?.action || "deny");
  const [patterns, setPatterns] = useState<string[]>(rule?.patterns || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<TargetsForm>) => setForm((f) => ({ ...f, ...p }));

  const valid = form.name.trim() !== "" && patterns.length > 0 && form.priority >= 0 && form.priority <= 10000;

  const save = async () => {
    setLoading(true);
    setError(null);
    const body: CommandRuleIn = {
      ...targetsBody(form),
      approver_group_ids: action === "review" ? form.approver_group_ids : [],
      action,
      patterns,
    };
    try {
      if (rule) await api.put(`/api/acl/command-rules/${rule.id}`, body);
      else await api.post("/api/acl/command-rules", body);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={rule ? `Modifier la règle ${rule.name}` : "Nouvelle règle de commandes"}
      onClose={onClose}
      size="3xl"
      footer={
        <>
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {rule ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <GeneralFields form={form} set={set} />

      <div className="border-t pt-4 space-y-4">
        <Field label="Action">
          <ActionPicker<CommandRuleAction>
            actions={["allow", "deny", "alert", "review"]}
            value={action}
            onChange={setAction}
            help={{
              allow: "Autorise explicitement et arrête l'évaluation.",
              deny: "Bloque la commande.",
              alert: "Exécute la commande et prévient les administrateurs.",
              review: "Bloque jusqu'à validation (autorisation à usage unique).",
            }}
          />
        </Field>
        <Field
          label="Motifs *"
          hint="Expressions régulières, insensibles à la casse, recherchées dans la ligne de commande. Une seule correspondance suffit."
        >
          <StringListEditor
            value={patterns}
            onChange={setPatterns}
            placeholder="rm\s+-rf\s+/"
            emptyText="Aucun motif (au moins un requis)"
            mono
            validate={isRegex}
          />
        </Field>
      </div>

      <WhoFields form={form} set={set} opts={opts} />
      <WhereFields form={form} set={set} opts={opts} listPrefix="cmd" />
      {action === "review" && <ApproverFields form={form} set={set} opts={opts} />}
    </Modal>
  );
}

// ── Generic rules table ──────────────────────────────────────

function useRules<T extends { id: string; priority: number; name: string }>(path: string) {
  const [rules, setRules] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const rows = await api.get<T[]>(path);
      setRules(rows);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  return { rules, setRules, loading, error, load };
}

function sortRules<T extends { priority: number; name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

function RuleRowActions({
  active,
  onToggle,
  onEdit,
  onDelete,
}: {
  active: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Toggle checked={active} onChange={onToggle} label="" title={active ? "Désactiver" : "Activer"} />
      <button onClick={onEdit} className={iconBtn} title="Modifier">
        <Pencil size={15} />
      </button>
      <button onClick={onDelete} className={iconBtnDanger} title="Supprimer">
        <Trash2 size={15} />
      </button>
    </div>
  );
}

// ── Connection rules tab ─────────────────────────────────────

export function ConnectionRulesPanel({ refs }: { refs: AclRefs }) {
  const { rules, setRules, loading, error, load } = useRules<ConnectionRuleData>("/api/acl/connection-rules");
  const [edit, setEdit] = useState<ConnectionRuleData | null | undefined>(undefined);
  const [del, setDel] = useState<ConnectionRuleData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const nodePaths = useMemo(() => new Map(refs.nodes.map((n) => [n.id, n.path])), [refs.nodes]);
  const sorted = useMemo(() => {
    const s = sortRules(rules);
    // Login rules first (they are evaluated before anything else)
    return [...s.filter((r) => r.scope === "login"), ...s.filter((r) => r.scope !== "login")];
  }, [rules]);

  const toggle = async (r: ConnectionRuleData) => {
    try {
      const updated = await api.put<ConnectionRuleData>(`/api/acl/connection-rules/${r.id}`, {
        ...connBody(r),
        is_active: !r.is_active,
      });
      setRules((prev) => prev.map((x) => (x.id === r.id ? updated : x)));
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    }
  };

  const doDelete = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await api.delete(`/api/acl/connection-rules/${del.id}`);
      setRules((prev) => prev.filter((x) => x.id !== del.id));
      setNotice({ ok: true, text: `Règle ${del.name} supprimée.` });
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      setDel(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="p-3 rounded-md border bg-muted/30 text-xs text-muted-foreground space-y-1 flex-1 min-w-[18rem]">
          <p>
            Les règles sont évaluées par <strong>priorité croissante</strong> ; la première qui correspond décide.
            Si aucune ne correspond, la connexion est autorisée (les règles d'accès restent nécessaires pour voir
            un serveur).
          </p>
          <p>
            Portée <strong>Accès à Citadel</strong> : utilisation de l'application elle-même. Portée{" "}
            <strong>Connexion</strong> : terminal, RDP et exécution sur les serveurs, avec possibilité de
            validation préalable par un tiers.
          </p>
        </div>
        <button onClick={() => setEdit(null)} className={btnPrimary}>
          <Plus size={16} /> Nouvelle règle
        </button>
      </div>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />
      {loading ? (
        <p className="text-muted-foreground">Chargement...</p>
      ) : sorted.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center">
          <ShieldBan size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Aucune règle de connexion : tout est autorisé.</p>
        </div>
      ) : (
        <div className="bg-card border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium w-16">Prio.</th>
                <th className="text-left p-3 font-medium">Règle</th>
                <th className="text-left p-3 font-medium">Portée</th>
                <th className="text-left p-3 font-medium">Action</th>
                <th className="text-left p-3 font-medium">Cibles</th>
                <th className="text-left p-3 font-medium">Conditions</th>
                <th className="text-right p-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 align-top hover:bg-muted/30 ${r.is_active ? "" : "opacity-50"}`}
                >
                  <td className="p-3 font-mono text-xs">{r.priority}</td>
                  <td className="p-3">
                    <p className="font-medium">{r.name}</p>
                    {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                  </td>
                  <td className="p-3">
                    <Chip tone={r.scope === "login" ? "blue" : "default"}>
                      {r.scope === "login" ? "Accès Citadel" : "Connexion"}
                    </Chip>
                  </td>
                  <td className="p-3">
                    <RuleActionChip action={r.action} />
                    {r.action === "review" && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {r.approver_groups.length
                          ? r.approver_groups.map((g) => g.name).join(", ")
                          : "administrateurs"}
                      </p>
                    )}
                  </td>
                  <td className="p-3">
                    <TargetsSummary rule={r} nodePaths={nodePaths} showServers={r.scope === "connect"} />
                  </td>
                  <td className="p-3">
                    <div className="space-y-1 text-xs">
                      {r.source_ips.length === 0 && r.time_windows.length === 0 && (
                        <span className="text-muted-foreground">toujours</span>
                      )}
                      {r.source_ips.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.source_ips.map((ip) => (
                            <Chip key={ip}>
                              <span className="font-mono">{ip}</span>
                            </Chip>
                          ))}
                        </div>
                      )}
                      {r.time_windows.map((w, i) => (
                        <p key={i} className="text-muted-foreground">
                          {formatWindow(w)}
                        </p>
                      ))}
                    </div>
                  </td>
                  <td className="p-3">
                    <RuleRowActions
                      active={r.is_active}
                      onToggle={() => toggle(r)}
                      onEdit={() => setEdit(r)}
                      onDelete={() => setDel(r)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit !== undefined && (
        <ConnectionRuleModal
          rule={edit}
          refs={refs}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            load();
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title={`Supprimer la règle ${del.name}`}
          confirmLabel="Supprimer"
          danger
          loading={busy}
          onConfirm={doDelete}
          onClose={() => setDel(null)}
        >
          <p>La règle cessera immédiatement de s'appliquer.</p>
          {del.scope === "login" && del.action === "allow" && (
            <p className="text-amber-800">
              C'est une règle d'autorisation d'accès à Citadel : la suppression est refusée si elle vous bloquerait.
            </p>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}

// ── Command rules tab ────────────────────────────────────────

function CommandTester({ refs }: { refs: AclRefs }) {
  const [command, setCommand] = useState("");
  const [serverId, setServerId] = useState("");
  const [userId, setUserId] = useState("");
  const [account, setAccount] = useState("");
  const [result, setResult] = useState<RuleDecision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.post<RuleDecision>("/api/acl/command-rules/test", {
          command,
          server_id: serverId,
          user_id: userId || null,
          account: account.trim() || null,
        })
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const verdict: Record<string, string> = {
    allow: "La commande serait exécutée.",
    deny: "La commande serait bloquée.",
    alert: "La commande serait exécutée et les administrateurs prévenus.",
    review: "La commande serait bloquée jusqu'à validation.",
  };

  return (
    <div className="bg-card border rounded-lg p-4 space-y-3">
      <h3 className="font-semibold flex items-center gap-2">
        <FlaskConical size={16} /> Tester une commande
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="md:col-span-4">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && command.trim() && serverId && run()}
            placeholder="systemctl stop nginx"
            className={`${inputCls} font-mono`}
          />
        </div>
        <select value={serverId} onChange={(e) => setServerId(e.target.value)} className={inputCls}>
          <option value="">Serveur *</option>
          {refs.servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
          <option value="">Moi-même</option>
          {refs.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.display_name}
            </option>
          ))}
        </select>
        <input
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="Compte (facultatif)"
          className={`${inputCls} font-mono`}
        />
        <button onClick={run} disabled={loading || !command.trim() || !serverId} className={btnPrimary}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : <FlaskConical size={16} />} Tester
        </button>
      </div>
      <ErrorBox message={error} />
      {result && (
        <div className="p-3 rounded-md border bg-muted/30 text-sm space-y-1">
          <div className="flex items-center gap-2">
            <RuleActionChip action={result.action} />
            <span>{verdict[result.action] || result.action}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {result.rule
              ? result.rule === "Liste de blocage globale"
                ? "Correspondance avec la liste de blocage globale (Paramètres > Commandes)."
                : `Règle : ${result.rule}`
              : "Aucune règle ne correspond (autorisé par défaut)."}
            {result.reason && (
              <>
                {" "}
                Correspondance : <code className="bg-muted px-1 rounded">{result.reason}</code>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export function CommandRulesPanel({ refs }: { refs: AclRefs }) {
  const { rules, setRules, loading, error, load } = useRules<CommandRuleData>("/api/acl/command-rules");
  const [edit, setEdit] = useState<CommandRuleData | null | undefined>(undefined);
  const [del, setDel] = useState<CommandRuleData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const nodePaths = useMemo(() => new Map(refs.nodes.map((n) => [n.id, n.path])), [refs.nodes]);
  const sorted = useMemo(() => sortRules(rules), [rules]);

  const toggle = async (r: CommandRuleData) => {
    try {
      const updated = await api.put<CommandRuleData>(`/api/acl/command-rules/${r.id}`, {
        ...cmdBody(r),
        is_active: !r.is_active,
      });
      setRules((prev) => prev.map((x) => (x.id === r.id ? updated : x)));
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    }
  };

  const doDelete = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await api.delete(`/api/acl/command-rules/${del.id}`);
      setRules((prev) => prev.filter((x) => x.id !== del.id));
      setNotice({ ok: true, text: `Règle ${del.name} supprimée.` });
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      setDel(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="p-3 rounded-md border bg-muted/30 text-xs text-muted-foreground space-y-1 flex-1 min-w-[18rem]">
          <p>
            S'applique à l'<strong>API d'exécution</strong> et au <strong>terminal interactif</strong>. Dans le
            terminal, la ligne est reconstituée à la validation (Entrée) ; les applications plein écran (vi, top...)
            sont ignorées. C'est un garde-fou, pas une barrière étanche : les enregistrements de session restent la
            source d'audit.
          </p>
          <p>
            Évaluation par priorité croissante, première correspondance gagnante, aucune = autorisé. La liste de
            blocage globale (Paramètres &gt; Commandes) s'applique aussi.
          </p>
        </div>
        <button onClick={() => setEdit(null)} className={btnPrimary}>
          <Plus size={16} /> Nouvelle règle
        </button>
      </div>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />
      {loading ? (
        <p className="text-muted-foreground">Chargement...</p>
      ) : sorted.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center">
          <TerminalSquare size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Aucune règle de commandes.</p>
        </div>
      ) : (
        <div className="bg-card border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium w-16">Prio.</th>
                <th className="text-left p-3 font-medium">Règle</th>
                <th className="text-left p-3 font-medium">Action</th>
                <th className="text-left p-3 font-medium">Motifs</th>
                <th className="text-left p-3 font-medium">Cibles</th>
                <th className="text-right p-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 align-top hover:bg-muted/30 ${r.is_active ? "" : "opacity-50"}`}
                >
                  <td className="p-3 font-mono text-xs">{r.priority}</td>
                  <td className="p-3">
                    <p className="font-medium">{r.name}</p>
                    {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                  </td>
                  <td className="p-3">
                    <RuleActionChip action={r.action} />
                    {r.action === "review" && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {r.approver_groups.length
                          ? r.approver_groups.map((g) => g.name).join(", ")
                          : "administrateurs"}
                      </p>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="space-y-1 max-w-xs">
                      {r.patterns.map((p) => (
                        <code key={p} className="block text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                          {p}
                        </code>
                      ))}
                    </div>
                  </td>
                  <td className="p-3">
                    <TargetsSummary rule={r} nodePaths={nodePaths} />
                  </td>
                  <td className="p-3">
                    <RuleRowActions
                      active={r.is_active}
                      onToggle={() => toggle(r)}
                      onEdit={() => setEdit(r)}
                      onDelete={() => setDel(r)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CommandTester refs={refs} />

      {edit !== undefined && (
        <CommandRuleModal
          rule={edit}
          refs={refs}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            load();
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title={`Supprimer la règle ${del.name}`}
          confirmLabel="Supprimer"
          danger
          loading={busy}
          onConfirm={doDelete}
          onClose={() => setDel(null)}
        >
          <p>La règle cessera immédiatement de s'appliquer.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
