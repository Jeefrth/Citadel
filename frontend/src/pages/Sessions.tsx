// Recorded sessions: list (SSH and RDP), replay, integrity check, deletion.
// Deep links from the command journal: ?recording=<id>&t=<ms> or ?session=<session_id>&t=<ms>.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Clock,
  Film,
  Globe,
  Loader2,
  Play,
  Power,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
} from "lucide-react";
import { ApiError, api, fetchBlob } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  type RecordingVerifyResult,
  type SessionProtocol,
  type SessionRecordingData,
  type SessionRecordingDetail,
} from "@/services/types";
import { Chip, ConfirmModal, Notice, iconBtnDanger, type NoticeData } from "@/components/kit";
import { ProtocolBadge, StorageChip, formatBytes, formatDuration } from "@/components/auditUi";
import { RdpReplayPlayer, SshReplayPlayer } from "@/components/RecordingPlayers";

const LIST_LIMIT = 200;
const LOOKUP_LIMIT = 500;

type Replay =
  | { kind: "ssh"; detail: SessionRecordingDetail; t: number | null }
  | { kind: "rdp"; rec: SessionRecordingData; blob: Blob; t: number | null };

type Confirm = { kind: "one"; rec: SessionRecordingData } | { kind: "selected" } | { kind: "all" };

/** Clear message for a replay failure (409 = SHA-256 mismatch). */
function replayError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409)
    return `Intégrité compromise : l'empreinte SHA-256 de l'enregistrement ne correspond plus. Lecture bloquée. (${e.message})`;
  if (e instanceof ApiError && e.status === 404)
    return `Contenu indisponible : session encore en cours ou jamais stockée. (${e.message})`;
  return `Lecture impossible : ${errorMessage(e)}`;
}

export default function Sessions() {
  const { isAdmin } = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionRecordingData[]>([]);
  const [protocol, setProtocol] = useState<"" | SessionProtocol>("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loadingReplay, setLoadingReplay] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, RecordingVerifyResult | "loading">>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deepLinkDone = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: String(LIST_LIMIT) });
      if (protocol) qs.set("protocol", protocol);
      setSessions(await api.get<SessionRecordingData[]>(`/api/sessions/?${qs}`));
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [protocol]);

  useEffect(() => {
    load();
  }, [load]);

  const openReplay = useCallback(async (rec: SessionRecordingData, t: number | null = null) => {
    setLoadingReplay(rec.id);
    setNotice(null);
    try {
      if (rec.protocol === "rdp") {
        const blob = await fetchBlob(`/api/sessions/${rec.id}/rdp`);
        setReplay({ kind: "rdp", rec, blob, t });
      } else {
        const detail = await api.get<SessionRecordingDetail>(`/api/sessions/${rec.id}`);
        setReplay({ kind: "ssh", detail, t });
      }
    } catch (e) {
      setNotice({ ok: false, text: replayError(e) });
    } finally {
      setLoadingReplay(null);
    }
  }, []);

  // Deep link from the command journal, resolved once the first list is loaded
  useEffect(() => {
    if (loading || deepLinkDone.current) return;
    const recId = searchParams.get("recording");
    const sessionId = searchParams.get("session");
    if (!recId && !sessionId) return;
    deepLinkDone.current = true;
    const tRaw = searchParams.get("t");
    const t = tRaw !== null && !isNaN(Number(tRaw)) ? Number(tRaw) : null;
    const match = (list: SessionRecordingData[]) =>
      list.find((s) => (recId ? s.id === recId : s.session_id === sessionId));
    (async () => {
      let rec = match(sessions);
      if (!rec) {
        // Not in the current page: ask the API directly
        try {
          const query = sessionId
            ? `session_id=${encodeURIComponent(sessionId)}`
            : `limit=${LOOKUP_LIMIT}`;
          rec = match(await api.get<SessionRecordingData[]>(`/api/sessions/?${query}`));
        } catch {
          /* handled below */
        }
      }
      if (rec) openReplay(rec, t);
      else
        setNotice({
          ok: false,
          text: "Aucun enregistrement trouvé pour cette session (enregistrement désactivé, supprimé ou trop ancien).",
        });
    })();
  }, [loading, sessions, searchParams, openReplay]);

  const closeReplay = () => {
    setReplay(null);
    if (searchParams.has("recording") || searchParams.has("session")) setSearchParams({}, { replace: true });
  };

  const runVerify = async (rec: SessionRecordingData) => {
    setVerify((v) => ({ ...v, [rec.id]: "loading" }));
    try {
      const r = await api.get<RecordingVerifyResult>(`/api/sessions/${rec.id}/verify`);
      setVerify((v) => ({ ...v, [rec.id]: r }));
    } catch (e) {
      setVerify((v) => ({ ...v, [rec.id]: { ok: false, message: errorMessage(e) } }));
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleSelectAll = () =>
    setSelected(selected.size === sessions.length ? new Set() : new Set(sessions.map((s) => s.id)));

  const doDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      if (confirm.kind === "one") {
        await api.delete(`/api/sessions/${confirm.rec.id}`);
        setNotice({ ok: true, text: "Enregistrement supprimé." });
      } else if (confirm.kind === "selected") {
        const r = await api.post<{ deleted: number }>("/api/sessions/bulk-delete", { ids: Array.from(selected) });
        setNotice({ ok: true, text: `${r.deleted} enregistrement(s) supprimé(s).` });
      } else {
        const r = await api.post<{ deleted: number }>("/api/sessions/delete-all", {});
        setNotice({ ok: true, text: `${r.deleted} enregistrement(s) supprimé(s). Les sessions en cours sont conservées.` });
      }
      setSelected(new Set());
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setDeleting(false);
      setConfirm(null);
      load();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Sessions enregistrées</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as "" | SessionProtocol)}
            className="px-2 py-1.5 rounded-md border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Tous protocoles</option>
            <option value="ssh">SSH</option>
            <option value="rdp">RDP</option>
          </select>
          {isAdmin && selected.size > 0 && (
            <button
              onClick={() => setConfirm({ kind: "selected" })}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-red-700 text-xs font-medium hover:bg-red-100 disabled:opacity-50"
            >
              <Trash2 size={14} />
              Supprimer la sélection ({selected.size})
            </button>
          )}
          {isAdmin && sessions.length > 0 && (
            <button
              onClick={() => setConfirm({ kind: "all" })}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium hover:bg-red-50 hover:text-red-700 hover:border-red-200 disabled:opacity-50 text-muted-foreground"
            >
              <Trash2 size={14} />
              Tout supprimer
            </button>
          )}
          <span className="text-sm text-muted-foreground ml-2">
            {sessions.length} enregistrement{sessions.length !== 1 ? "s" : ""}
            {sessions.length >= LIST_LIMIT && " (les plus récents)"}
          </span>
        </div>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />

      {loading && (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="bg-card border rounded-lg p-12 text-center">
          <Film size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            Aucune session enregistrée. Ouvrez un terminal ou un bureau à distance vers un serveur pour commencer.
          </p>
        </div>
      )}

      {!loading && sessions.length > 0 && (
        <div className="space-y-2">
          {isAdmin && (
            <label className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
              <input
                type="checkbox"
                checked={selected.size === sessions.length && sessions.length > 0}
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              {selected.size === sessions.length ? "Tout désélectionner" : "Tout sélectionner"}
            </label>
          )}
          {sessions.map((s) => {
            const v = verify[s.id];
            return (
              <div
                key={s.id}
                className={`bg-card border rounded-lg p-4 flex items-center gap-4 transition-colors ${
                  selected.has(s.id) ? "border-primary/50 bg-primary/5" : "hover:border-primary/30"
                }`}
              >
                {isAdmin && (
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggleSelect(s.id)}
                    className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary shrink-0"
                  />
                )}
                <ProtocolBadge protocol={s.protocol} />

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium text-sm flex items-center gap-1">
                      <Server size={14} className="text-muted-foreground" />
                      {s.account && <span className="font-mono text-xs">{s.account}@</span>}
                      {s.server_name}
                      {!s.server_id && (
                        <Chip tone="default" title="Le serveur a été supprimé depuis">
                          supprimé
                        </Chip>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <User size={12} />
                      {s.user_name}
                    </span>
                    {s.client_ip && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                        <Globe size={12} />
                        {s.client_ip}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{new Date(s.started_at).toLocaleString("fr-FR")}</span>
                    {s.ended_at ? (
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {formatDuration(s.duration_seconds)}
                      </span>
                    ) : (
                      <Chip tone="green">en cours</Chip>
                    )}
                    {s.protocol === "ssh" && <span>{s.event_count} événements</span>}
                    <span>{formatBytes(s.size_bytes)}</span>
                    <StorageChip type={s.storage_type} />
                    {s.sha256 && (
                      <span className="font-mono" title={`SHA-256 ${s.sha256}`}>
                        {s.sha256.slice(0, 12)}…
                      </span>
                    )}
                  </div>
                  {s.terminated_by && (
                    <p className="text-xs text-red-700 flex items-center gap-1">
                      <Power size={12} />
                      Terminée par {s.terminated_by}
                      {s.termination_reason && <> : {s.termination_reason}</>}
                    </p>
                  )}
                  {v && v !== "loading" && (
                    <p
                      className={`text-xs flex items-center gap-1 ${v.ok ? "text-green-700" : "text-red-700 font-medium"}`}
                    >
                      {v.ok ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
                      {v.message}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {isAdmin && (
                    <button
                      onClick={() => runVerify(s)}
                      disabled={v === "loading"}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium hover:bg-accent disabled:opacity-50"
                      title="Relire l'objet stocké et contrôler son empreinte SHA-256"
                    >
                      {v === "loading" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                      Vérifier l'intégrité
                    </button>
                  )}
                  <button
                    onClick={() => openReplay(s)}
                    disabled={loadingReplay === s.id || !s.ended_at}
                    title={s.ended_at ? undefined : "Disponible à la fin de la session"}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                  >
                    {loadingReplay === s.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    Rejouer
                  </button>
                  {isAdmin && (
                    <button onClick={() => setConfirm({ kind: "one", rec: s })} className={iconBtnDanger} title="Supprimer">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {replay?.kind === "ssh" && <SshReplayPlayer session={replay.detail} initialMs={replay.t} onClose={closeReplay} />}
      {replay?.kind === "rdp" && (
        <RdpReplayPlayer rec={replay.rec} blob={replay.blob} initialMs={replay.t} onClose={closeReplay} />
      )}

      {confirm && (
        <ConfirmModal
          title={
            confirm.kind === "one"
              ? "Supprimer l'enregistrement"
              : confirm.kind === "selected"
                ? `Supprimer ${selected.size} enregistrement(s)`
                : "Supprimer tous les enregistrements"
          }
          confirmLabel="Supprimer"
          danger
          loading={deleting}
          onConfirm={doDelete}
          onClose={() => setConfirm(null)}
        >
          {confirm.kind === "one" && (
            <p>
              Session de <strong>{confirm.rec.user_name}</strong> sur <strong>{confirm.rec.server_name}</strong> du{" "}
              {new Date(confirm.rec.started_at).toLocaleString("fr-FR")}.
            </p>
          )}
          {confirm.kind === "all" && (
            <p>Tous les enregistrements terminés seront supprimés, y compris ceux qui ne sont pas affichés.</p>
          )}
          <p>La suppression est définitive (objet stocké compris) et journalisée dans l'audit.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
