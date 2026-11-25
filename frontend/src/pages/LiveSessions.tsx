// "Sessions en direct" (admin): active SSH / RDP sessions, read-only monitoring and kill.
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Activity, Eye, Power, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type KillSessionResult, type LiveSession } from "@/services/types";
import { Chip, ConfirmModal, EmptyState, ErrorBox, Field, Notice, PageHeader, type NoticeData } from "@/components/kit";
import { ProtocolBadge, StatusDot, TableSkeleton, Tip, formatDuration } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
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
              text: `Ordre émis, mais aucun processus ne l'a reçu : la session est sans doute déjà fermée.`,
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
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="ex. Intervention non autorisée"
        />
      </Field>
    </ConfirmModal>
  );
}

export default function LiveSessions() {
  const { can, loading: userLoading } = useCurrentUser();
  const isAdmin = can("audit");
  const canKill = can("sessions");
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
      <PageHeader
        title="Sessions en direct"
        description="Sessions SSH et RDP ouvertes en ce moment. Observez-les en lecture seule ou terminez-les. Actualisation toutes les 5 secondes."
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw /> Actualiser
          </Button>
        }
      />

      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      {!loading && sessions.length === 0 ? (
        <EmptyState icon={Activity} title="Aucune session en cours">
          Les sessions SSH et RDP ouvertes apparaissent ici dès leur connexion.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Session</TableHead>
                <TableHead>Utilisateur</TableHead>
                <TableHead>Cible</TableHead>
                <TableHead>IP client</TableHead>
                <TableHead>Début</TableHead>
                <TableHead>Durée</TableHead>
                <TableHead>Dernière activité</TableHead>
                <TableHead>Observateurs</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeleton cols={9} rows={3} />
              ) : (
                sessions.map((s) => {
                  const idle = Math.max(0, now - s.last_activity);
                  return (
                    <TableRow key={s.session_id}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-2.5">
                          <StatusDot tone="live" pulse label="En direct" />
                          <ProtocolBadge protocol={s.protocol} />
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">{s.user}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-sm">
                        {s.account && <span className="text-muted-foreground">{s.account}@</span>}
                        {s.server}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{s.client_ip || "-"}</TableCell>
                      <TableCell className="tabular whitespace-nowrap text-muted-foreground">{fmtTime(s.started_at)}</TableCell>
                      <TableCell className="tabular whitespace-nowrap font-medium text-live">
                        {formatDuration(now - s.started_at)}
                      </TableCell>
                      <TableCell className={cn("tabular whitespace-nowrap", idle > 300 ? "text-live" : "text-muted-foreground")}>
                        <Tip content={`Dernière activité : ${fmtTime(s.last_activity)}`}>
                          <span className="cursor-default">{idle < 10 ? "à l'instant" : `il y a ${formatDuration(idle)}`}</span>
                        </Tip>
                      </TableCell>
                      <TableCell>
                        {s.watchers.length === 0 ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {s.watchers.map((w) => (
                              <Chip key={w}>
                                <Eye className="size-3" /> {w}
                              </Chip>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button size="sm" onClick={() => setWatching(s)}>
                            <Eye /> Observer
                          </Button>
                          {canKill && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setKilling(s)}
                              className="border-danger/30 text-danger hover:bg-danger/10 hover:text-danger"
                            >
                              <Power /> Terminer
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {watching && (
        <LiveMonitorViewer
          session={watching}
          onClose={() => {
            setWatching(null);
            load();
          }}
          onKill={canKill ? () => setKilling(watching) : undefined}
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
