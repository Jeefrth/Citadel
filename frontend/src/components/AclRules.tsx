// Connection ACL and command ACL tabs of the "Accès" page (admin).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangle,
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
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  MultiSelect,
  Notice,
  SaveButton,
  Toggle,
  iconBtn,
  iconBtnDanger,
  type NoticeData,
  type Option,
} from "@/components/kit";
import { RuleActionChip } from "@/components/governanceUi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
      <div className="mb-2 flex min-h-6 flex-wrap gap-1">
        {value.length === 0 && <span className="text-xs text-muted-foreground">{emptyText}</span>}
        {value.map((v) => (
          <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>
            <span className={mono ? "font-mono" : ""}>{v}</span>
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
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
          aria-invalid={!!err}
          className={cn(mono && "font-mono", err && "border-danger/50 focus-visible:ring-danger/40")}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={add}
          disabled={!trimmed || !!err}
          title="Ajouter"
        >
          <Plus />
        </Button>
        {listId && suggestions && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
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
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
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
                  aria-pressed={on}
                  className={cn(
                    "size-7 rounded-md border text-xs font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <Input
            type="time"
            value={w.start}
            onChange={(e) => update(i, { start: e.target.value })}
            className="tabular w-28 dark:[color-scheme:dark]"
          />
          <span className="text-sm text-muted-foreground">à</span>
          <Input
            type="time"
            value={w.end}
            onChange={(e) => update(i, { end: e.target.value })}
            className="tabular w-28 dark:[color-scheme:dark]"
          />
          {w.end < w.start && <span className="text-xs text-muted-foreground">(passe minuit)</span>}
          {w.days.length === 0 && <span className="text-xs text-danger">choisir au moins un jour</span>}
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className={`${iconBtnDanger} ml-auto`}
            title="Retirer la plage"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...value, { days: [0, 1, 2, 3, 4], start: "08:00", end: "18:00" }])}
      >
        <Plus /> Ajouter une plage
      </Button>
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
    <div className="max-w-sm space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">Qui</span>
        {who === 0 && <span className="text-xs text-muted-foreground">tout le monde</span>}
        {rule.users.map((u) => (
          <Chip key={u.id}>{u.name}</Chip>
        ))}
        {rule.groups.map((g) => (
          <Chip key={g.id} tone="primary">
            <Users className="size-3" /> {g.name}
          </Chip>
        ))}
      </div>
      {showServers && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">Où</span>
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
              <span className="font-mono">{l}</span>
            </Chip>
          ))}
        </div>
      )}
      {showServers && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">Comptes</span>
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Nom *">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="Description">
          <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Priorité" hint="0 à 10000, la plus basse est évaluée en premier.">
          <Input
            type="number"
            min={0}
            max={10000}
            value={form.priority}
            onChange={(e) => set({ priority: Number(e.target.value) })}
            className="font-mono tabular"
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
      <h4 className="mb-3 text-sm font-medium">Utilisateurs concernés</h4>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Utilisateurs">
          <MultiSelect options={opts.users} selected={form.user_ids} onChange={(user_ids) => set({ user_ids })} />
        </Field>
        <Field label="Groupes">
          <MultiSelect options={opts.groups} selected={form.group_ids} onChange={(group_ids) => set({ group_ids })} />
        </Field>
      </div>
      {form.user_ids.length + form.group_ids.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Aucune sélection : la règle concerne tout le monde.</p>
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
    <div className="space-y-4 border-t pt-4">
      <h4 className="text-sm font-medium">Serveurs et comptes ciblés</h4>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
            mono
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

/** Radio card: one choice among a few, with a one-line explanation. */
function ChoiceCard({
  selected,
  onSelect,
  name,
  children,
  help,
}: {
  selected: boolean;
  onSelect: () => void;
  name: string;
  children: ReactNode;
  help: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 text-sm transition-colors",
        selected ? "border-foreground/40 bg-muted" : "hover:bg-accent/60",
      )}
    >
      <input type="radio" name={name} checked={selected} onChange={onSelect} className="peer sr-only" />
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input peer-focus-visible:ring-1 peer-focus-visible:ring-ring",
          selected && "border-foreground",
        )}
      >
        {selected && (
          <motion.span
            layoutId={`choice-${name}`}
            className="size-2 rounded-full bg-foreground"
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
          />
        )}
      </span>
      <span className="min-w-0 space-y-1">
        <span className="block">{children}</span>
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  );
}

function ActionPicker<T extends string>({
  actions,
  value,
  onChange,
  help,
  name,
}: {
  actions: T[];
  value: T;
  onChange: (v: T) => void;
  help: Record<T, string>;
  name: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {actions.map((a) => (
        <ChoiceCard key={a} name={name} selected={value === a} onSelect={() => onChange(a)} help={help[a]}>
          <RuleActionChip action={a} />
        </ChoiceCard>
      ))}
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
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {rule ? "Enregistrer la règle" : "Créer la règle"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <GeneralFields form={form} set={set} />

      <div className="grid grid-cols-1 gap-4 border-t pt-4 md:grid-cols-2">
        <Field label="Portée">
          <div className="space-y-2">
            {(
              [
                ["connect", "Connexion aux serveurs", "Terminal, RDP et exécution de commandes."],
                ["login", "Accès à Citadel", "Toute utilisation de l'application elle-même."],
              ] as [RuleScope, string, string][]
            ).map(([id, label, help]) => (
              <ChoiceCard key={id} name="conn-scope" selected={scope === id} onSelect={() => setScope(id)} help={help}>
                <span className="font-medium">{label}</span>
              </ChoiceCard>
            ))}
          </div>
        </Field>
        <Field label="Action">
          <ActionPicker<ConnectRuleAction>
            actions={scope === "login" ? ["allow", "deny"] : ["allow", "deny", "review"]}
            value={action}
            onChange={setAction}
            name="conn-action"
            help={{
              allow: "Autorise et arrête l'évaluation.",
              deny: "Refuse la connexion.",
              review: "Demande une validation avant chaque connexion.",
            }}
          />
        </Field>
      </div>
      {scope === "login" && (
        <div className="flex items-start gap-2 rounded-md border border-live/30 bg-live/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-live" />
          <p>
            Une règle d'accès à Citadel peut vous bloquer : l'enregistrement est refusé si elle vous empêche de vous
            connecter depuis votre adresse actuelle. Ajoutez d'abord une règle « Autoriser » pour vos adresses
            d'administration.
          </p>
        </div>
      )}

      <WhoFields form={form} set={set} opts={opts} />
      {scope === "connect" && <WhereFields form={form} set={set} opts={opts} listPrefix="conn" />}

      <div className="grid grid-cols-1 gap-4 border-t pt-4 md:grid-cols-2">
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
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {rule ? "Enregistrer la règle" : "Créer la règle"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <GeneralFields form={form} set={set} />

      <div className="space-y-4 border-t pt-4">
        <Field label="Action">
          <ActionPicker<CommandRuleAction>
            actions={["allow", "deny", "alert", "review"]}
            value={action}
            onChange={setAction}
            name="cmd-action"
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
  name,
  active,
  onToggle,
  onEdit,
  onDelete,
}: {
  name: string;
  active: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Toggle checked={active} onChange={onToggle} label="" title={active ? `Désactiver ${name}` : `Activer ${name}`} />
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={onEdit} className={iconBtn} aria-label={`Modifier ${name}`}>
            <Pencil className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Modifier</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={onDelete} className={iconBtnDanger} aria-label={`Supprimer ${name}`}>
            <Trash2 className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Supprimer</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Explanation block above a rules table, with the "new rule" button. */
function PanelIntro({ children, onNew }: { children: ReactNode; onNew: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-[18rem] flex-1 space-y-1 rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
      <Button onClick={onNew}>
        <Plus /> Nouvelle règle
      </Button>
    </div>
  );
}

function RulesSkeleton({ cols }: { cols: number }) {
  return (
    <Card className="overflow-hidden">
      {[0, 1, 2, 3].map((r) => (
        <div key={r} className="flex items-center gap-4 border-b px-3 py-3.5 last:border-0">
          <Skeleton className="h-4 w-8" />
          {Array.from({ length: cols - 1 }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </Card>
  );
}

/** Priority cell: mono, tabular, right-aligned so numbers line up. */
function PriorityCell({ value }: { value: number }) {
  return <TableCell className="tabular px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">{value}</TableCell>;
}

function ApproversNote({ groups }: { groups: { name: string }[] }) {
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      par {groups.length ? groups.map((g) => g.name).join(", ") : "les administrateurs"}
    </p>
  );
}

const rowMotion = {
  layout: true,
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.18 },
} as const;

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
      toast.success(`Règle ${del.name} supprimée`);
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      setDel(null);
    }
  };

  return (
    <div className="space-y-4">
      <PanelIntro onNew={() => setEdit(null)}>
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
      </PanelIntro>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />
      {loading ? (
        <RulesSkeleton cols={6} />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={ShieldBan}
          title="Aucune règle de connexion"
          action={
            <Button variant="outline" onClick={() => setEdit(null)}>
              <Plus /> Nouvelle règle
            </Button>
          }
        >
          Tout est autorisé pour l'instant. Ajoutez une règle pour filtrer par adresse, horaire ou exiger une
          validation.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14 px-3 text-right">Prio.</TableHead>
                <TableHead className="px-3">Règle</TableHead>
                <TableHead className="px-3">Portée</TableHead>
                <TableHead className="px-3">Action</TableHead>
                <TableHead className="px-3">Cibles</TableHead>
                <TableHead className="px-3">Conditions</TableHead>
                <TableHead className="px-3">
                  <span className="sr-only">Gestion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {sorted.map((r) => (
                  <motion.tr
                    key={r.id}
                    {...rowMotion}
                    className={cn(
                      "border-b align-top transition-colors hover:bg-muted/50",
                      !r.is_active && "opacity-50",
                    )}
                  >
                    <PriorityCell value={r.priority} />
                    <TableCell className="px-3 py-2.5">
                      <p className="font-medium">{r.name}</p>
                      {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <Chip tone={r.scope === "login" ? "blue" : "default"}>
                        {r.scope === "login" ? "Accès Citadel" : "Connexion"}
                      </Chip>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <RuleActionChip action={r.action} />
                      {r.action === "review" && <ApproversNote groups={r.approver_groups} />}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <TargetsSummary rule={r} nodePaths={nodePaths} showServers={r.scope === "connect"} />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
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
                          <p key={i} className="tabular text-muted-foreground">
                            {formatWindow(w)}
                          </p>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-1.5">
                      <RuleRowActions
                        name={r.name}
                        active={r.is_active}
                        onToggle={() => toggle(r)}
                        onEdit={() => setEdit(r)}
                        onDelete={() => setDel(r)}
                      />
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        </Card>
      )}

      {edit !== undefined && (
        <ConnectionRuleModal
          rule={edit}
          refs={refs}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            toast.success(edit ? "Règle enregistrée" : "Règle créée");
            setEdit(undefined);
            load();
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title={`Supprimer la règle ${del.name}`}
          confirmLabel="Supprimer la règle"
          danger
          loading={busy}
          onConfirm={doDelete}
          onClose={() => setDel(null)}
        >
          <p>La règle cessera immédiatement de s'appliquer.</p>
          {del.scope === "login" && del.action === "allow" && (
            <p className="text-live">
              C'est une règle d'autorisation d'accès à Citadel : la suppression est refusée si elle vous bloquerait.
            </p>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}

// ── Command rules tab ────────────────────────────────────────

const ME = "__me__";

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
    <Card className="space-y-3 p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <FlaskConical className="size-4 text-muted-foreground" /> Tester une commande
        </h3>
        <p className="text-xs text-muted-foreground">
          Simule la décision des règles pour une commande, un serveur et un utilisateur, sans rien exécuter.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="md:col-span-4">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && command.trim() && serverId && run()}
            placeholder="systemctl stop nginx"
            className="font-mono"
          />
        </div>
        <Select value={serverId} onValueChange={setServerId}>
          <SelectTrigger>
            <SelectValue placeholder="Serveur *" />
          </SelectTrigger>
          <SelectContent>
            {refs.servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={userId || ME} onValueChange={(v) => setUserId(v === ME ? "" : v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ME}>Moi-même</SelectItem>
            {refs.users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="Compte (facultatif)"
          className="font-mono"
        />
        <Button onClick={run} disabled={loading || !command.trim() || !serverId}>
          {loading ? <Loader2 className="animate-spin" /> : <FlaskConical />} Tester
        </Button>
      </div>
      <ErrorBox message={error} />
      <AnimatePresence initial={false} mode="wait">
        {result && (
          <motion.div
            key={`${result.action}-${result.rule}-${result.reason}`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
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
                    Correspondance :{" "}
                    <code className="rounded bg-background px-1 font-mono text-foreground">{result.reason}</code>
                  </>
                )}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
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
      toast.success(`Règle ${del.name} supprimée`);
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      setDel(null);
    }
  };

  return (
    <div className="space-y-4">
      <PanelIntro onNew={() => setEdit(null)}>
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
      </PanelIntro>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />
      {loading ? (
        <RulesSkeleton cols={5} />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={TerminalSquare}
          title="Aucune règle de commandes"
          action={
            <Button variant="outline" onClick={() => setEdit(null)}>
              <Plus /> Nouvelle règle
            </Button>
          }
        >
          Seule la liste de blocage globale s'applique. Ajoutez une règle pour bloquer, signaler ou soumettre à
          validation certaines commandes.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14 px-3 text-right">Prio.</TableHead>
                <TableHead className="px-3">Règle</TableHead>
                <TableHead className="px-3">Action</TableHead>
                <TableHead className="px-3">Motifs</TableHead>
                <TableHead className="px-3">Cibles</TableHead>
                <TableHead className="px-3">
                  <span className="sr-only">Gestion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {sorted.map((r) => (
                  <motion.tr
                    key={r.id}
                    {...rowMotion}
                    className={cn(
                      "border-b align-top transition-colors hover:bg-muted/50",
                      !r.is_active && "opacity-50",
                    )}
                  >
                    <PriorityCell value={r.priority} />
                    <TableCell className="px-3 py-2.5">
                      <p className="font-medium">{r.name}</p>
                      {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <RuleActionChip action={r.action} />
                      {r.action === "review" && <ApproversNote groups={r.approver_groups} />}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <div className="max-w-xs space-y-1">
                        {r.patterns.map((p) => (
                          <code
                            key={p}
                            className="block break-all rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-xs"
                          >
                            {p}
                          </code>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <TargetsSummary rule={r} nodePaths={nodePaths} />
                    </TableCell>
                    <TableCell className="px-3 py-1.5">
                      <RuleRowActions
                        name={r.name}
                        active={r.is_active}
                        onToggle={() => toggle(r)}
                        onEdit={() => setEdit(r)}
                        onDelete={() => setDel(r)}
                      />
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        </Card>
      )}

      <CommandTester refs={refs} />

      {edit !== undefined && (
        <CommandRuleModal
          rule={edit}
          refs={refs}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            toast.success(edit ? "Règle enregistrée" : "Règle créée");
            setEdit(undefined);
            load();
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title={`Supprimer la règle ${del.name}`}
          confirmLabel="Supprimer la règle"
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
