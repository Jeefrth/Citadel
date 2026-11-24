import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  Check,
  ClipboardCheck,
  Inbox,
  KeyRound,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  VIRTUAL_ACCOUNTS,
  VIRTUAL_ACCOUNT_HELP,
  errorMessage,
  type AccessRequestIn,
  type ApprovalData,
  type ApprovalScope,
  type ApprovalStatus,
  type Ref,
  type ServerAction,
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
  PageHeader,
  SaveButton,
  Tabs,
  formatDate,
  type NoticeData,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ApprovalStatusChip, KIND_LABELS, STATUS_INFO, formatHours, relativeTime } from "@/components/governanceUi";
import { refreshGovernanceBadges } from "@/components/NotificationBell";

type NameMaps = { servers: Map<string, string>; nodes: Map<string, string> };

// ── Request card ─────────────────────────────────────────────

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function AccountChip({ account }: { account: string }) {
  return (
    <Chip
      tone={account.startsWith("@") ? "primary" : "default"}
      title={(VIRTUAL_ACCOUNT_HELP as Record<string, string>)[account]}
    >
      <span className="font-mono">{account}</span>
    </Chip>
  );
}

/** Four-eyes warning: nobody but the requester could approve. */
function NoApproverWarning() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-live/30 bg-live/10 px-3 py-2 text-xs">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-live" />
      <p className="text-foreground">
        <span className="font-medium text-live">Aucun valideur disponible.</span> Seul le demandeur pourrait
        approuver cette demande, ce que la règle des 4 yeux interdit. Un administrateur doit revoir les groupes de
        valideurs de la règle.
      </p>
    </div>
  );
}

function ApprovalCard({
  a,
  names,
  currentUserId,
  highlighted,
  bare,
  onDecide,
  onCancel,
}: {
  a: ApprovalData;
  names: NameMaps;
  currentUserId: string | undefined;
  highlighted?: boolean;
  /** Rendered inside a dialog: no border of its own. */
  bare?: boolean;
  onDecide: (a: ApprovalData, approve: boolean) => void;
  onCancel: (a: ApprovalData) => void;
}) {
  const p = a.payload || {};
  const mine = currentUserId !== undefined && a.requester.id === currentUserId;
  const cancellable = mine && (a.status === "pending" || a.status === "approved");
  const pending = a.status === "pending";

  return (
    <div
      id={`approval-${a.id}`}
      className={cn(
        "space-y-3",
        !bare && "rounded-lg border bg-card p-4 transition-shadow",
        !bare && pending && "border-l-2 border-l-live",
        highlighted && "ring-2 ring-ring",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular font-semibold">Demande #{a.number}</span>
        <Chip>{KIND_LABELS[a.kind] || a.kind}</Chip>
        <ApprovalStatusChip status={a.status} />
        <span className="ml-auto text-xs text-muted-foreground" title={formatDate(a.created_at)}>
          <span className="text-foreground">{a.requester.name}</span>, {relativeTime(a.created_at)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {a.server && <Detail label="Serveur">{a.server.name}</Detail>}
        {a.account_username && (
          <Detail label="Compte">
            <span className="font-mono">{a.account_username}</span>
          </Detail>
        )}
        {a.kind === "access" && (
          <>
            <Detail label="Cibles">
              <div className="flex flex-wrap gap-1">
                {(p.server_ids || []).map((id) => (
                  <Chip key={id}>{names.servers.get(id) || id.slice(0, 8)}</Chip>
                ))}
                {(p.node_ids || []).map((id) => (
                  <Chip key={id} tone="green">
                    {names.nodes.get(id) || id.slice(0, 8)}/*
                  </Chip>
                ))}
              </div>
            </Detail>
            <Detail label="Actions">
              <div className="flex flex-wrap gap-1">
                {(p.actions || []).map((x) => (
                  <Chip key={x} tone={x === "execute" ? "amber" : "default"}>
                    {ACTION_LABELS[x] || x}
                  </Chip>
                ))}
              </div>
            </Detail>
            <Detail label="Comptes">
              <div className="flex flex-wrap gap-1">
                {(p.accounts || []).map((x) => (
                  <AccountChip key={x} account={x} />
                ))}
              </div>
            </Detail>
            <Detail label="Durée">
              <span className="tabular">{formatHours(p.duration_hours)}</span>
            </Detail>
          </>
        )}
        {a.rule_name && <Detail label="Règle">{a.rule_name}</Detail>}
        {pending && (
          <Detail label="Expire">
            <span className="tabular" title={formatDate(a.expires_at)}>
              {relativeTime(a.expires_at)}
            </span>
          </Detail>
        )}
        {a.grant_until && (a.status === "approved" || a.status === "used") && (
          <Detail label="Valide jusqu'au">
            <span className="tabular">{formatDate(a.grant_until)}</span>
          </Detail>
        )}
        {a.used_at && (
          <Detail label="Utilisée le">
            <span className="tabular">{formatDate(a.used_at)}</span>
          </Detail>
        )}
      </dl>

      {a.command && (
        <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs">
          {a.command}
        </pre>
      )}
      {a.reason && (
        <p className="text-sm">
          <span className="text-muted-foreground">Motif : </span>
          {a.reason}
        </p>
      )}
      {a.decided_by && (
        <p className="text-xs text-muted-foreground">
          {STATUS_INFO[a.status]?.label || a.status} par <span className="text-foreground">{a.decided_by.name}</span>
          {a.decided_at && <> le {formatDate(a.decided_at)}</>}
          {a.decision_comment && <> : « {a.decision_comment} »</>}
        </p>
      )}
      {pending && a.approvers_available === 0 && <NoApproverWarning />}

      {(a.can_decide || cancellable) && (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {cancellable && (
            <Button variant="ghost" size="sm" onClick={() => onCancel(a)} className="text-muted-foreground">
              <Ban /> Annuler la demande
            </Button>
          )}
          {a.can_decide && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDecide(a, false)}
                className="text-danger hover:bg-danger/10 hover:text-danger"
              >
                <X /> Refuser
              </Button>
              <Button size="sm" onClick={() => onDecide(a, true)}>
                <Check /> Approuver
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Decision dialog ──────────────────────────────────────────

function DecisionModal({
  a,
  approve,
  onClose,
  onDone,
}: {
  a: ApprovalData;
  approve: boolean;
  onClose: () => void;
  onDone: (updated: ApprovalData) => void;
}) {
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      const updated = await api.post<ApprovalData>(`/api/approvals/${a.id}/${approve ? "approve" : "reject"}`, {
        comment: comment.trim() || null,
      });
      onDone(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={`${approve ? "Approuver" : "Refuser"} la demande #${a.number}`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button variant={approve ? "default" : "destructive"} onClick={submit} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : approve ? <Check /> : <X />}
            {approve ? "Approuver" : "Refuser"}
          </Button>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-sm">
        {KIND_LABELS[a.kind]} demandé par <strong>{a.requester.name}</strong>
        {a.server && (
          <>
            {" "}
            sur <strong>{a.server.name}</strong>
          </>
        )}
        {a.account_username && (
          <>
            {" "}
            (compte <span className="font-mono">{a.account_username}</span>)
          </>
        )}
        .
      </p>
      {a.command && (
        <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs">
          {a.command}
        </pre>
      )}
      {approve && a.kind === "access" && (
        <p className="text-xs text-muted-foreground">
          Une règle d'accès temporaire « Demande #{a.number} » sera créée pour{" "}
          {formatHours(a.payload?.duration_hours)}.
        </p>
      )}
      {approve && a.kind === "command" && (
        <p className="text-xs text-muted-foreground">
          L'autorisation vaut pour une seule exécution de cette commande exacte.
        </p>
      )}
      <Field label="Commentaire (facultatif)">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={approve ? "Ex. vérifié avec l'équipe applicative" : "Expliquez le refus au demandeur"}
          autoFocus
        />
      </Field>
    </Modal>
  );
}

// ── Access request dialog ────────────────────────────────────

const DURATION_PRESETS: { h: number; label: string }[] = [
  { h: 1, label: "1 h" },
  { h: 4, label: "4 h" },
  { h: 8, label: "8 h" },
  { h: 24, label: "24 h" },
  { h: 72, label: "3 j" },
  { h: 168, label: "7 j" },
];

function AccessRequestModal({
  servers,
  nodes,
  onClose,
  onCreated,
}: {
  servers: Ref[];
  nodes: Ref[];
  onClose: () => void;
  onCreated: (a: ApprovalData) => void;
}) {
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [actions, setActions] = useState<ServerAction[]>(["connect"]);
  const [accounts, setAccounts] = useState<string[]>(["@ALL"]);
  const [accountInput, setAccountInput] = useState("");
  const [duration, setDuration] = useState(8);
  const [custom, setCustom] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addAccount = (v: string) => {
    const x = v.trim();
    if (x && !accounts.includes(x)) setAccounts([...accounts, x]);
  };
  const toggleAction = (a: ServerAction) =>
    setActions(actions.includes(a) ? actions.filter((x) => x !== a) : [...actions, a]);

  const durationOk = Number.isInteger(duration) && duration >= 1 && duration <= 720;
  const valid =
    (serverIds.length > 0 || nodeIds.length > 0) &&
    actions.length > 0 &&
    accounts.length > 0 &&
    durationOk &&
    reason.trim().length >= 3;

  const submit = async () => {
    setLoading(true);
    setError(null);
    const body: AccessRequestIn = {
      server_ids: serverIds,
      node_ids: nodeIds,
      actions,
      accounts,
      duration_hours: duration,
      reason: reason.trim(),
    };
    try {
      onCreated(await api.post<ApprovalData>("/api/access-requests", body));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Demander un accès temporaire"
      onClose={onClose}
      size="3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={submit} loading={loading} disabled={!valid}>
            {!loading && <Send />} Envoyer la demande
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-xs text-muted-foreground">
        Une fois approuvée par un valideur (jamais vous-même), une règle d'accès temporaire est créée pour la
        durée demandée. Vous pouvez l'annuler à tout moment depuis « Mes demandes ».
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Serveurs">
          <MultiSelect
            options={servers.map((s) => ({ id: s.id, label: s.name }))}
            selected={serverIds}
            onChange={setServerIds}
            emptyText="Aucun serveur"
          />
        </Field>
        <Field label="Nœuds" hint="Un nœud inclut tous ses sous-nœuds.">
          <MultiSelect
            options={nodes.map((n) => ({ id: n.id, label: n.name }))}
            selected={nodeIds}
            onChange={setNodeIds}
            emptyText="Aucun nœud"
          />
        </Field>
      </div>
      {serverIds.length === 0 && nodeIds.length === 0 && (
        <p className="text-xs text-live">Choisissez au moins un serveur ou un nœud.</p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Actions">
          <div className="space-y-2">
            {ALL_ACTIONS.map((a) => (
              <label key={a} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={actions.includes(a)} onCheckedChange={() => toggleAction(a)} />
                {ACTION_LABELS[a]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Comptes" hint="@ALL = tous les comptes du serveur.">
          <div className="mb-2 flex min-h-6 flex-wrap gap-1">
            {accounts.map((a) => (
              <Chip
                key={a}
                tone={a.startsWith("@") ? "primary" : "default"}
                title={(VIRTUAL_ACCOUNT_HELP as Record<string, string>)[a]}
                onRemove={() => setAccounts(accounts.filter((x) => x !== a))}
              >
                <span className="font-mono">{a}</span>
              </Chip>
            ))}
          </div>
          <div className="flex gap-2">
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
              list="access-request-virtual"
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
            <datalist id="access-request-virtual">
              {VIRTUAL_ACCOUNTS.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </div>
        </Field>
      </div>

      <Field label="Durée">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Durée">
            {DURATION_PRESETS.map((d) => {
              const on = !custom && duration === d.h;
              return (
                <button
                  key={d.h}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setDuration(d.h);
                    setCustom(false);
                  }}
                  className={cn(
                    "tabular h-7 rounded-[5px] px-3 text-sm transition-colors",
                    on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {d.label}
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={custom}
              onClick={() => setCustom(true)}
              className={cn(
                "h-7 rounded-[5px] px-3 text-sm transition-colors",
                custom ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              Autre
            </button>
          </div>
          {custom && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Input
                type="number"
                min={1}
                max={720}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="tabular w-24 text-foreground"
              />
              heures (720 max)
            </span>
          )}
        </div>
        {!durationOk && <p className="mt-1 text-xs text-danger">Durée entre 1 et 720 heures.</p>}
      </Field>

      <Field label="Motif *" hint="Expliquez pourquoi vous avez besoin de cet accès (3 caractères minimum).">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Ticket ITS-12345 : analyse des journaux applicatifs"
        />
      </Field>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────

const ALL_STATUSES = "all";
const STATUS_FILTERS: ApprovalStatus[] = ["pending", "approved", "rejected", "cancelled", "expired", "used"];

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="ml-auto h-4 w-32" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="space-y-1.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Approvals() {
  const { user, isAdmin } = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const initialTab = params.get("tab");
  const [tab, setTab] = useState<ApprovalScope>(
    initialTab === "mine" || initialTab === "all" ? initialTab : "todo"
  );
  const [status, setStatus] = useState<ApprovalStatus | "">("");
  const [rows, setRows] = useState<ApprovalData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [decision, setDecision] = useState<{ a: ApprovalData; approve: boolean } | null>(null);
  const [cancelling, setCancelling] = useState<ApprovalData | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [refServers, setRefServers] = useState<Ref[]>([]);
  const [refNodes, setRefNodes] = useState<Ref[]>([]);
  const [focus, setFocus] = useState<ApprovalData | null>(null);
  const [focusError, setFocusError] = useState<string | null>(null);
  const focusId = params.get("id");
  const scrolledFor = useRef<string | null>(null);

  const names: NameMaps = useMemo(
    () => ({
      servers: new Map(refServers.map((r) => [r.id, r.name])),
      nodes: new Map(refNodes.map((r) => [r.id, r.name])),
    }),
    [refServers, refNodes]
  );

  // "Toutes" is admin only
  useEffect(() => {
    if (tab === "all" && user && !isAdmin) setTab("todo");
  }, [tab, user, isAdmin]);

  // Deep link from the command palette: /approvals?request=1 opens the access request dialog
  useEffect(() => {
    if (params.get("request") !== "1") return;
    setRequestOpen(true);
    const next = new URLSearchParams(params);
    next.delete("request");
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    Promise.all([
      api.get<Ref[]>("/api/access-requests/servers"),
      api.get<Ref[]>("/api/access-requests/nodes"),
    ])
      .then(([s, n]) => {
        setRefServers(s);
        setRefNodes(n);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ scope: tab });
      if (status && tab !== "todo") q.set("status", status);
      setRows(await api.get<ApprovalData[]>(`/api/approvals?${q}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [tab, status]);

  useEffect(() => {
    if (tab === "all" && !isAdmin) return;
    load();
  }, [load, tab, isAdmin]);

  // Deep link: /approvals?id=<uuid> opens the request
  useEffect(() => {
    if (!focusId) {
      setFocus(null);
      return;
    }
    setFocusError(null);
    api
      .get<ApprovalData>(`/api/approvals/${focusId}`)
      .then(setFocus)
      .catch((e) => setFocusError(errorMessage(e)));
  }, [focusId]);

  // Scroll to the focused request when it is in the current list
  useEffect(() => {
    if (!focusId || scrolledFor.current === focusId) return;
    if (rows.some((r) => r.id === focusId)) {
      scrolledFor.current = focusId;
      document.getElementById(`approval-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [rows, focusId]);

  const closeFocus = () => {
    const next = new URLSearchParams(params);
    next.delete("id");
    setParams(next, { replace: true });
  };

  const changeTab = (t: ApprovalScope) => {
    setTab(t);
    setLoaded(false);
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  const applyUpdate = (updated: ApprovalData) => {
    // A decided request leaves the "À valider" list right away (animated), the reload confirms it.
    setRows((prev) =>
      tab === "todo" && updated.status !== "pending"
        ? prev.filter((r) => r.id !== updated.id)
        : prev.map((r) => (r.id === updated.id ? updated : r))
    );
    if (focus?.id === updated.id) setFocus(updated);
    refreshGovernanceBadges();
    load();
  };

  const doCancel = async () => {
    if (!cancelling) return;
    setCancelLoading(true);
    try {
      const updated = await api.post<ApprovalData>(`/api/approvals/${cancelling.id}/cancel`, {});
      applyUpdate(updated);
      toast.success(`Demande #${updated.number} annulée`);
      setCancelling(null);
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
      setCancelling(null);
    } finally {
      setCancelLoading(false);
    }
  };

  const tabs: { id: ApprovalScope; label: string; icon: typeof Inbox }[] = [
    { id: "todo", label: "À valider", icon: Inbox },
    { id: "mine", label: "Mes demandes", icon: ListChecks },
    ...(isAdmin ? [{ id: "all" as const, label: "Toutes", icon: ClipboardCheck }] : []),
  ];

  const cardProps = {
    names,
    currentUserId: user?.id,
    onDecide: (a: ApprovalData, approve: boolean) => setDecision({ a, approve }),
    onCancel: setCancelling,
  };

  const showSkeleton = loading && !loaded && rows.length === 0;

  return (
    <div>
      <PageHeader
        title="Validations"
        description="Demandes d'accès temporaire, connexions et commandes soumises à validation. Règle des 4 yeux : on ne valide jamais sa propre demande."
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={load} aria-label="Actualiser">
                  <RefreshCw className={cn(loading && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Actualiser</TooltipContent>
            </Tooltip>
            <Button onClick={() => setRequestOpen(true)}>
              <KeyRound /> Demander un accès
            </Button>
          </>
        }
      />

      <Tabs<ApprovalScope> tabs={tabs} active={tab} onChange={changeTab} />

      <div className="space-y-4">
        <Notice notice={notice} onClose={() => setNotice(null)} />
        <ErrorBox message={error} />

        {tab !== "todo" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Statut</span>
            <Select
              value={status || ALL_STATUSES}
              onValueChange={(v) => setStatus(v === ALL_STATUSES ? "" : (v as ApprovalStatus))}
            >
              <SelectTrigger className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STATUSES}>Tous</SelectItem>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_INFO[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {showSkeleton && <ListSkeleton />}

        {!loading && rows.length === 0 && (
          <EmptyState
            icon={tab === "todo" ? Inbox : ClipboardCheck}
            title={tab === "todo" ? "Rien à valider" : "Aucune demande"}
            action={
              tab === "mine" ? (
                <Button variant="outline" onClick={() => setRequestOpen(true)}>
                  <KeyRound /> Demander un accès
                </Button>
              ) : undefined
            }
          >
            {tab === "todo"
              ? "Aucune demande n'attend votre validation. Les nouvelles demandes apparaissent ici et dans les notifications."
              : tab === "mine"
                ? "Vous n'avez fait aucune demande. Demandez un accès temporaire quand une règle ne vous couvre pas."
                : "Aucune demande ne correspond à ce filtre."}
          </EmptyState>
        )}

        <div className="flex flex-col">
          <AnimatePresence initial={false}>
            {rows.map((a) => (
              <motion.div
                key={a.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="pb-3">
                  <ApprovalCard a={a} highlighted={a.id === focusId} {...cardProps} />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {focusId && (focus || focusError) && (
        <Modal title={focus ? `Demande #${focus.number}` : "Demande"} onClose={closeFocus} size="3xl">
          <ErrorBox message={focusError} />
          {focus && <ApprovalCard a={focus} bare {...cardProps} />}
        </Modal>
      )}

      {decision && (
        <DecisionModal
          a={decision.a}
          approve={decision.approve}
          onClose={() => setDecision(null)}
          onDone={(updated) => {
            setDecision(null);
            applyUpdate(updated);
            if (updated.status === "approved") toast.success(`Demande #${updated.number} approuvée`);
            else toast(`Demande #${updated.number} refusée`);
          }}
        />
      )}

      {cancelling && (
        <ConfirmModal
          title={`Annuler la demande #${cancelling.number}`}
          confirmLabel="Annuler la demande"
          danger
          loading={cancelLoading}
          onConfirm={doCancel}
          onClose={() => setCancelling(null)}
        >
          <p>
            {cancelling.status === "approved"
              ? "La demande est déjà approuvée : l'annuler retire immédiatement l'accès accordé."
              : "La demande ne sera plus proposée aux valideurs."}
          </p>
        </ConfirmModal>
      )}

      {requestOpen && (
        <AccessRequestModal
          servers={refServers}
          nodes={refNodes}
          onClose={() => setRequestOpen(false)}
          onCreated={(a) => {
            setRequestOpen(false);
            if (a.approvers_available === 0) {
              toast.warning(`Demande #${a.number} envoyée, sans valideur disponible`, {
                description: "Personne d'autre que vous ne peut l'approuver : contactez un administrateur.",
                duration: 10000,
              });
            } else {
              toast.success(`Demande #${a.number} envoyée aux valideurs`);
            }
            if (tab === "mine") load();
            else changeTab("mine");
            refreshGovernanceBadges();
          }}
        />
      )}
    </div>
  );
}
