// "Sessions en direct" (admin): active SSH / RDP sessions, read-only monitoring and kill.
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Activity, Eye, Loader2, Power, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type KillSessionResult, type LiveSession } from "@/services/types";
import { Chip, ConfirmModal, ErrorBox, Field, Notice, btnSecondary, inputCls, type NoticeData } from "@/components/ui";
import { ProtocolBadge, formatDuration } from "@/components/auditUi";
import LiveMonitorViewer from "@/components/LiveMonitorViewer";

const REFRESH_MS = 5000;

function KillDialog({
  session,
  onClose,
  onDone,
}: {
  session: LiveSession;
  onClose: () => void;
  onDone: (n: NoticeData) => void;
}) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  const kill = async () => {
    setLoading(true);
    try {
      const r = await api.post<KillSessionResult>(
        `/api/live-sessions/${encodeURIComponent(session.session_id)}/kill`,
        { reason: reason.trim() || null }
      );
      onDone(
        r.delivered
          ? { ok: true, text: `Session de ${session.user} sur ${session.server} terminée.` }
          : {
              ok: false,
              text: `L'ordre a été émis mais aucun processus ne l'a reçu : la session est peut-être déjà fermée.`,
            }
      );
    } catch (e) {
      onDone({ ok: false, text: errorMessage(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ConfirmModal
      title="Terminer la session"
      confirmLabel="Terminer la session"
      danger
      loading={loading}
      onConfirm={kill}
      onClose={onClose}
    >
      <p>
        La session <strong>{session.protocol.toUpperCase()}</strong> de <strong>{session.user}</strong> sur{" "}
        <strong>
          {session.account ? `${session.account}@` : ""}
          {session.server}
        </strong>{" "}
        sera coupée immédiatement. L'utilisateur est notifié et l'action est journalisée.
      </p>
      <Field label="Motif (optionnel)" hint="Affiché à l'utilisateur et conservé dans l'audit.">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          className={inputCls}
          placeholder="ex. Intervention non autorisée"
        />
      </Field>
    </ConfirmModal>
  );
}

export default function LiveSessions() {
  const { isAdmin, loading: userLoading } = useCurrentUser();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [watching, setWatching] = useState<LiveSession | null>(null);
  const [killing, setKilling] = useState<LiveSession | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api.get<LiveSession[]>("/api/live-sessions"));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    load();
    const poll = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [isAdmin, load]);

  if (!userLoading && !isAdmin) return <Navigate to="/" replace />;

  const fmtTime = (unix: number) =>
    new Date(unix * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Sessions en direct</h2>
          <p className="text-sm text-muted-foreground">
            Sessions SSH et RDP ouvertes en ce moment. Actualisation toutes les 5 secondes.
          </p>
        </div>
        <button onClick={load} className={btnSecondary}>
          <RefreshCw size={14} /> Actualiser
        </button>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center">
          <Activity size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Aucune session active.</p>
        </div>
      ) : (
        <div className="bg-card border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                <th className="p-3 font-medium">Protocole</th>
                <th className="p-3 font-medium">Utilisateur</th>
                <th className="p-3 font-medium">Serveur</th>
                <th className="p-3 font-medium">Compte</th>
                <th className="p-3 font-medium">IP</th>
                <th className="p-3 font-medium">Début</th>
                <th className="p-3 font-medium">Durée</th>
                <th className="p-3 font-medium">Dernière activité</th>
                <th className="p-3 font-medium">Observateurs</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const idle = Math.max(0, now - s.last_activity);
                return (
                  <tr key={s.session_id} className="border-b last:border-0">
                    <td className="p-3">
                      <ProtocolBadge protocol={s.protocol} />
                    </td>
                    <td className="p-3 font-medium">{s.user}</td>
                    <td className="p-3">{s.server}</td>
                    <td className="p-3 font-mono text-xs">{s.account || "-"}</td>
                    <td className="p-3 font-mono text-xs">{s.client_ip || "-"}</td>
                    <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{fmtTime(s.started_at)}</td>
                    <td className="p-3 whitespace-nowrap">{formatDuration(now - s.started_at)}</td>
                    <td
                      className={`p-3 text-xs whitespace-nowrap ${idle > 300 ? "text-amber-700" : "text-muted-foreground"}`}
                      title={fmtTime(s.last_activity)}
                    >
                      {idle < 10 ? "à l'instant" : `il y a ${formatDuration(idle)}`}
                    </td>
                    <td className="p-3">
                      {s.watchers.length === 0 ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {s.watchers.map((w) => (
                            <Chip key={w} tone="amber">
                              <Eye size={11} /> {w}
                            </Chip>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setWatching(s)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90"
                        >
                          <Eye size={14} /> Observer
                        </button>
                        <button
                          onClick={() => setKilling(s)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-red-700 text-xs font-medium hover:bg-red-100"
                        >
                          <Power size={14} /> Terminer
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {watching && (
        <LiveMonitorViewer
          session={watching}
          onClose={() => {
            setWatching(null);
            load();
          }}
          onKill={() => setKilling(watching)}
        />
      )}
      {killing && (
        <KillDialog
          session={killing}
          onClose={() => setKilling(null)}
          onDone={(n) => {
            setNotice(n);
            setKilling(null);
            load();
          }}
        />
      )}
    </div>
  );
}
