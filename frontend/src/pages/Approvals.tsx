import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
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
  ErrorBox,
  Field,
  Modal,
  MultiSelect,
  Notice,
  SaveButton,
  Tabs,
  btnPrimary,
  btnSecondary,
  formatDate,
  inputCls,
  type NoticeData,
} from "@/components/kit";
import { ApprovalStatusChip, KIND_LABELS, STATUS_INFO, formatHours, relativeTime } from "@/components/governanceUi";
import { refreshGovernanceBadges } from "@/components/NotificationBell";

type NameMaps = { servers: Map<string, string>; nodes: Map<string, string> };

// ── Request card ─────────────────────────────────────────────

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function ApprovalCard({
  a,
  names,
  currentUserId,
  highlighted,
  onDecide,
  onCancel,
}: {
  a: ApprovalData;
  names: NameMaps;
  currentUserId: string | undefined;
  highlighted?: boolean;
  onDecide: (a: ApprovalData, approve: boolean) => void;
  onCancel: (a: ApprovalData) => void;
}) {
  const p = a.payload || {};
  const mine = currentUserId !== undefined && a.requester.id === currentUserId;
  const cancellable = mine && (a.status === "pending" || a.status === "approved");

  return (
    <div
      id={`approval-${a.id}`}
      className={`bg-card border rounded-lg p-4 space-y-3 transition-shadow ${
        highlighted ? "ring-2 ring-primary shadow-md" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Demande #{a.number}</span>
        <Chip tone="primary">{KIND_LABELS[a.kind] || a.kind}</Chip>
        <ApprovalStatusChip status={a.status} />
        <span className="text-xs text-muted-foreground ml-auto" title={formatDate(a.created_at)}>
          {a.requester.name}, {relativeTime(a.created_at)}
        </span>
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
                  <Chip key={x} tone={x.startsWith("@") ? "primary" : "default"}>
                    {x}
                  </Chip>
                ))}
              </div>
            </Detail>
            <Detail label="Durée">{formatHours(p.duration_hours)}</Detail>
          </>
        )}
        {a.rule_name && <Detail label="Règle">{a.rule_name}</Detail>}
        {a.status === "pending" && (
          <Detail label="Expire">
            <span title={formatDate(a.expires_at)}>{relativeTime(a.expires_at)}</span>
          </Detail>
        )}
        {a.grant_until && (a.status === "approved" || a.status === "used") && (
          <Detail label="Valide jusqu'au">{formatDate(a.grant_until)}</Detail>
        )}
        {a.used_at && <Detail label="Utilisée le">{formatDate(a.used_at)}</Detail>}
      </dl>

      {a.command && (
        <pre className="p-2 rounded-md bg-muted text-xs font-mono whitespace-pre-wrap break-all">{a.command}</pre>
      )}
      {a.reason && (
        <p className="text-sm">
          <span className="text-muted-foreground">Motif : </span>
          {a.reason}
        </p>
      )}
      {a.decided_by && (
        <p className="text-xs text-muted-foreground">
          {STATUS_INFO[a.status]?.label || a.status} par {a.decided_by.name}
          {a.decided_at && <> le {formatDate(a.decided_at)}</>}
          {a.decision_comment && <> : « {a.decision_comment} »</>}
        </p>
      )}
      {a.status === "pending" && a.approvers_available === 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-1.5">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          Aucun valideur disponible en dehors du demandeur : personne ne peut approuver cette demande.
          Un administrateur doit revoir les groupes de valideurs de la règle.
        </p>
      )}

      {(a.can_decide || cancellable) && (
        <div className="flex flex-wrap gap-2 justify-end pt-1">
          {cancellable && (
            <button onClick={() => onCancel(a)} className={btnSecondary}>
              <Ban size={15} /> Annuler
            </button>
          )}
          {a.can_decide && (
            <>
              <button
                onClick={() => onDecide(a, false)}
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-red-200 text-red-700 text-sm hover:bg-red-50"
              >
                <X size={15} /> Refuser
              </button>
              <button
                onClick={() => onDecide(a, true)}
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-green-600 text-white text-sm font-medium hover:bg-green-700"
              >
                <Check size={15} /> Approuver
              </button>
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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={loading}
            className={`flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50 ${
              approve ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : approve ? <Check size={16} /> : <X size={16} />}
            {approve ? "Approuver" : "Refuser"}
          </button>
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
        <pre className="p-2 rounded-md bg-muted text-xs font-mono whitespace-pre-wrap break-all">{a.command}</pre>
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
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={1000}
          className={inputCls}
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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={submit} loading={loading} disabled={!valid}>
            <Send size={15} /> Envoyer la demande
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-xs text-muted-foreground">
        Une fois approuvée par un valideur (jamais vous-même), une règle d'accès temporaire est créée pour la
        durée demandée. Vous pouvez l'annuler à tout moment depuis « Mes demandes ».
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
        <p className="text-xs text-amber-700">Choisissez au moins un serveur ou un nœud.</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Actions">
          <div className="space-y-2">
            {ALL_ACTIONS.map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={actions.includes(a)}
                  onChange={() => toggleAction(a)}
                  className="w-4 h-4 rounded"
                />
                {ACTION_LABELS[a]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Comptes" hint="@ALL = tous les comptes du serveur.">
          <div className="flex flex-wrap gap-1 mb-2 min-h-[1.5rem]">
            {accounts.map((a) => (
              <Chip
                key={a}
                tone={a.startsWith("@") ? "primary" : "default"}
                title={(VIRTUAL_ACCOUNT_HELP as Record<string, string>)[a]}
                onRemove={() => setAccounts(accounts.filter((x) => x !== a))}
              >
                {a}
              </Chip>
            ))}
          </div>
          <div className="flex gap-2">
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
              list="access-request-virtual"
              placeholder="Nom de compte (ex. root)"
              className={inputCls}
            />
            <button
              type="button"
              onClick={() => {
                addAccount(accountInput);
                setAccountInput("");
              }}
              disabled={!accountInput.trim()}
              className={btnSecondary}
            >
              <Plus size={16} />
            </button>
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
          {DURATION_PRESETS.map((d) => (
            <button
              key={d.h}
              type="button"
              onClick={() => {
                setDuration(d.h);
                setCustom(false);
              }}
              className={`px-3 py-1.5 rounded-md border text-sm ${
                !custom && duration === d.h ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
              }`}
            >
              {d.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustom(true)}
            className={`px-3 py-1.5 rounded-md border text-sm ${
              custom ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
            }`}
          >
            Autre
          </button>
          {custom && (
            <span className="flex items-center gap-2 text-sm">
              <input
                type="number"
                min={1}
                max={720}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className={`${inputCls} w-24`}
              />
              heures (720 max)
            </span>
          )}
        </div>
        {!durationOk && <p className="text-xs text-red-700 mt-1">Durée entre 1 et 720 heures.</p>}
      </Field>

      <Field label="Motif *" hint="Expliquez pourquoi vous avez besoin de cet accès (3 caractères minimum).">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Ticket ITS-12345 : analyse des journaux applicatifs"
          className={inputCls}
        />
      </Field>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────

const STATUS_FILTERS: (ApprovalStatus | "")[] = ["", "pending", "approved", "rejected", "cancelled", "expired", "used"];

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
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  const applyUpdate = (updated: ApprovalData) => {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
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
      setNotice({ ok: true, text: `Demande #${updated.number} annulée.` });
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

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold">Validations</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Demandes d'accès temporaire, connexions et commandes soumises à validation (règle des 4 yeux : on ne
            valide jamais sa propre demande).
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className={btnSecondary} title="Actualiser">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => setRequestOpen(true)} className={btnPrimary}>
            <KeyRound size={16} /> Demander un accès
          </button>
        </div>
      </div>

      <Tabs<ApprovalScope> tabs={tabs} active={tab} onChange={changeTab} />

      <div className="space-y-4">
        <Notice notice={notice} onClose={() => setNotice(null)} />
        <ErrorBox message={error} />

        {tab !== "todo" && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Statut</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ApprovalStatus | "")}
              className={`${inputCls} max-w-[12rem]`}
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s ? STATUS_INFO[s].label : "Tous"}
                </option>
              ))}
            </select>
          </div>
        )}

        {loading && rows.length === 0 && (
          <div className="flex justify-center py-12">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div className="bg-card border rounded-lg p-12 text-center">
            <ClipboardCheck size={48} className="mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {tab === "todo"
                ? "Aucune demande en attente de votre validation."
                : tab === "mine"
                  ? "Vous n'avez fait aucune demande."
                  : "Aucune demande."}
            </p>
          </div>
        )}

        {rows.map((a) => (
          <ApprovalCard key={a.id} a={a} highlighted={a.id === focusId} {...cardProps} />
        ))}
      </div>

      {focusId && (focus || focusError) && (
        <Modal title={focus ? `Demande #${focus.number}` : "Demande"} onClose={closeFocus} size="3xl">
          <ErrorBox message={focusError} />
          {focus && (
            <ApprovalCard
              a={focus}
              {...cardProps}
              onDecide={(a, approve) => setDecision({ a, approve })}
            />
          )}
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
            setNotice({
              ok: true,
              text: `Demande #${updated.number} ${updated.status === "approved" ? "approuvée" : "refusée"}.`,
            });
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
            setNotice({
              ok: true,
              text:
                a.approvers_available === 0
                  ? `Demande #${a.number} envoyée, mais aucun valideur n'est disponible : contactez un administrateur.`
                  : `Demande #${a.number} envoyée aux valideurs.`,
            });
            if (tab === "mine") load();
            else changeTab("mine");
            refreshGovernanceBadges();
          }}
        />
      )}
    </div>
  );
}
