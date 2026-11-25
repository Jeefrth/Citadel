// Recorded sessions: list (SSH and RDP), replay, integrity check, bulk download (ZIP), deletion.
// Deep links from the command journal: ?recording=<id>&t=<ms> or ?session=<session_id>&t=<ms>.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Film, Loader2, Play, Power, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { ApiError, api, fetchBlob, postBlob, saveBlob } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  type RecordingVerifyResult,
  type SessionProtocol,
  type SessionRecordingData,
  type SessionRecordingDetail,
} from "@/services/types";
import { Chip, ConfirmModal, EmptyState, Notice, PageHeader, iconBtnDanger, type NoticeData } from "@/components/kit";
import {
  ProtocolBadge,
  StatusDot,
  StorageChip,
  TableSkeleton,
  Tip,
  formatBytes,
  formatDuration,
} from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { RdpReplayPlayer, SshReplayPlayer } from "@/components/RecordingPlayers";

const LIST_LIMIT = 200;
const LOOKUP_LIMIT = 500;
/** Server-side cap of POST /api/sessions/bulk-download. */
const DOWNLOAD_MAX = 200;

type Replay =
  | { kind: "ssh"; detail: SessionRecordingDetail; t: number | null }
  | { kind: "rdp"; rec: SessionRecordingData; blob: Blob; t: number | null };

type Confirm = { kind: "one"; rec: SessionRecordingData } | { kind: "selected" } | { kind: "all" };

/** Clear message for a replay failure (409 = SHA-256 mismatch). */
function replayError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409)
    return `Intégrité compromise : l'empreinte SHA-256 de l'enregistrement ne correspond plus, la lecture est bloquée. (${e.message})`;
  if (e instanceof ApiError && e.status === 404)
    return `Contenu indisponible : session encore en cours ou jamais stockée. (${e.message})`;
  return `Lecture impossible : ${errorMessage(e)}`;
}

export default function Sessions() {
  const { isAdmin, can } = useCurrentUser();
  const canVerify = can("audit");
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionRecordingData[]>([]);
  const [protocol, setProtocol] = useState<"" | SessionProtocol>("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loadingReplay, setLoadingReplay] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, RecordingVerifyResult | "loading">>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
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

  const downloadSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0 || ids.length > DOWNLOAD_MAX) return;
    setDownloading(true);
    try {
      const blob = await postBlob("/api/sessions/bulk-download", { ids });
      saveBlob(blob, `citadel-enregistrements-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice({
        ok: true,
        text: (
          <>
            Archive téléchargée. Le fichier <span className="font-mono">manifest.csv</span> indique le résultat du
            contrôle d'empreinte de chaque enregistrement.
          </>
        ),
      });
    } catch (e) {
      setNotice({ ok: false, text: `Téléchargement impossible : ${errorMessage(e)}` });
    } finally {
      setDownloading(false);
    }
  };

  const allSelected = selected.size === sessions.length && sessions.length > 0;
  const tooMany = selected.size > DOWNLOAD_MAX;
  const cols = 9;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sessions enregistrées"
        description="Relisez les sessions SSH et RDP terminées et contrôlez l'empreinte de chaque enregistrement."
        actions={
          <>
            <Select value={protocol || "all"} onValueChange={(v) => setProtocol(v === "all" ? "" : (v as SessionProtocol))}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les protocoles</SelectItem>
                <SelectItem value="ssh">SSH</SelectItem>
                <SelectItem value="rdp">RDP</SelectItem>
              </SelectContent>
            </Select>
            {selected.size > 0 && (
              <Tip
                content={
                  tooMany
                    ? `${DOWNLOAD_MAX} enregistrements au plus par archive.`
                    : "Archive ZIP : SSH au format asciinema (.cast), RDP au format Guacamole (.guac), avec un manifeste."
                }
              >
                <span>
                  <Button variant="outline" size="sm" onClick={downloadSelected} disabled={downloading || tooMany}>
                    {downloading ? <Loader2 className="animate-spin" /> : <Download />}
                    Télécharger (<span className="tabular">{selected.size}</span>)
                  </Button>
                </span>
              </Tip>
            )}
            {isAdmin && selected.size > 0 && (
              <Button variant="destructive" size="sm" onClick={() => setConfirm({ kind: "selected" })} disabled={deleting}>
                <Trash2 />
                Supprimer la sélection (<span className="tabular">{selected.size}</span>)
              </Button>
            )}
            {isAdmin && sessions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirm({ kind: "all" })}
                disabled={deleting}
                className="text-muted-foreground hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 />
                Tout supprimer
              </Button>
            )}
          </>
        }
      />

      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!loading && sessions.length === 0 ? (
        <EmptyState icon={Film} title="Aucune session enregistrée">
          Ouvrez un terminal ou un bureau à distance vers un serveur : la session apparaîtra ici une fois terminée.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label={allSelected ? "Tout désélectionner" : "Tout sélectionner"}
                  />
                </TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Utilisateur</TableHead>
                <TableHead>IP client</TableHead>
                <TableHead>Début</TableHead>
                <TableHead>Durée</TableHead>
                <TableHead>Taille</TableHead>
                <TableHead>Empreinte</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeleton cols={cols} />
              ) : (
                sessions.map((s) => {
                  const v = verify[s.id];
                  const isSel = selected.has(s.id);
                  return (
                    <TableRow key={s.id} data-state={isSel ? "selected" : undefined}>
                      <TableCell className="pl-4">
                        <Checkbox checked={isSel} onCheckedChange={() => toggleSelect(s.id)} aria-label="Sélectionner" />
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex items-center gap-2">
                          <ProtocolBadge protocol={s.protocol} />
                          <span className="truncate font-mono text-sm">
                            {s.account && <span className="text-muted-foreground">{s.account}@</span>}
                            {s.server_name}
                          </span>
                          {!s.server_id && s.protocol !== "k8s" && (
                            <Chip tone="default" title="Le serveur a été supprimé depuis">
                              supprimé
                            </Chip>
                          )}
                          {!s.ended_at && (
                            <Chip tone="amber">
                              <StatusDot tone="live" /> en cours
                            </Chip>
                          )}
                        </div>
                        {s.terminated_by && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-danger">
                            <Power className="size-3.5" />
                            Terminée par {s.terminated_by}
                            {s.termination_reason && <> : {s.termination_reason}</>}
                          </p>
                        )}
                        {v && v !== "loading" && (
                          <p className={cn("mt-1 flex items-center gap-1 text-xs", v.ok ? "text-success" : "font-medium text-danger")}>
                            {v.ok ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                            {v.message}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{s.user_name}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{s.client_ip || "-"}</TableCell>
                      <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                        {new Date(s.started_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
                      </TableCell>
                      <TableCell className="tabular whitespace-nowrap">
                        {s.ended_at ? formatDuration(s.duration_seconds) : <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="tabular">{formatBytes(s.size_bytes)}</span>
                          <StorageChip type={s.storage_type} />
                        </div>
                        {s.protocol !== "rdp" && (
                          <p className="tabular text-xs text-muted-foreground">{s.event_count} événements</p>
                        )}
                      </TableCell>
                      <TableCell>
                        {s.sha256 ? (
                          <Tip content={<span className="break-all font-mono">SHA-256 {s.sha256}</span>}>
                            <span className="cursor-default font-mono text-xs text-muted-foreground">
                              {s.sha256.slice(0, 12)}...
                            </span>
                          </Tip>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {canVerify && (
                            <Tip content="Vérifier l'intégrité : relire l'objet stocké et contrôler son empreinte SHA-256">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-muted-foreground"
                                onClick={() => runVerify(s)}
                                disabled={v === "loading"}
                                aria-label="Vérifier l'intégrité"
                              >
                                {v === "loading" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                              </Button>
                            </Tip>
                          )}
                          <Tip content={s.ended_at ? undefined : "Disponible à la fin de la session"}>
                            <span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openReplay(s)}
                                disabled={loadingReplay === s.id || !s.ended_at}
                              >
                                {loadingReplay === s.id ? <Loader2 className="animate-spin" /> : <Play />}
                                Rejouer
                              </Button>
                            </span>
                          </Tip>
                          {isAdmin && (
                            <Tip content="Supprimer l'enregistrement">
                              <button
                                onClick={() => setConfirm({ kind: "one", rec: s })}
                                className={iconBtnDanger}
                                aria-label="Supprimer"
                              >
                                <Trash2 className="size-4" />
                              </button>
                            </Tip>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {!loading && (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              <span className="tabular">{sessions.length}</span> enregistrement{sessions.length !== 1 ? "s" : ""}
              {sessions.length >= LIST_LIMIT && " (les plus récents)"}
            </div>
          )}
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
