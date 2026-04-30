import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "@/services/api";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Film,
  Play,
  Pause,
  RotateCcw,
  X,
  Trash2,
  Server,
  User,
  Clock,
  Loader2,
  FastForward,
} from "lucide-react";

interface SessionData {
  id: string;
  session_id: string;
  server_id: string;
  user_id: string;
  server_name: string;
  user_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  event_count: number;
  size_bytes: number;
}

interface SessionEvent {
  t: number; // ms since start
  type: "o" | "i";
  data: string; // base64
}

interface SessionDetail extends SessionData {
  events: SessionEvent[];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}min ${s}s` : `${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function SessionPlayer({
  session,
  onClose,
}: {
  session: SessionDetail;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const eventIndexRef = useRef(0);

  // Only output events for replay
  const outputEvents = session.events.filter((e) => e.type === "o");

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 14,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#1a1b26",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    fitAddon.fit();
    xtermRef.current = xterm;

    xterm.writeln(
      `\x1b[1;34mSession replay: ${session.server_name}\x1b[0m`
    );
    xterm.writeln(
      `\x1b[90mUser: ${session.user_name} | Duration: ${formatDuration(session.duration_seconds)} | Events: ${outputEvents.length}\x1b[0m\r\n`
    );

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      xterm.dispose();
    };
  }, [session, outputEvents.length]);

  const playNextEvent = useCallback(() => {
    const idx = eventIndexRef.current;
    if (idx >= outputEvents.length) {
      setPlaying(false);
      setProgress(100);
      return;
    }

    const event = outputEvents[idx];
    const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
    xtermRef.current?.write(bytes);

    eventIndexRef.current = idx + 1;
    setProgress(Math.round(((idx + 1) / outputEvents.length) * 100));

    // Schedule next event
    if (idx + 1 < outputEvents.length) {
      const delay = Math.max(
        1,
        (outputEvents[idx + 1].t - event.t) / speed
      );
      timerRef.current = setTimeout(playNextEvent, delay);
    } else {
      setPlaying(false);
      setProgress(100);
    }
  }, [outputEvents, speed]);

  const handlePlay = () => {
    if (progress >= 100) {
      handleReset();
    }
    setPlaying(true);
    playNextEvent();
  };

  const handlePause = () => {
    setPlaying(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  const handleReset = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setPlaying(false);
    setProgress(0);
    eventIndexRef.current = 0;
    xtermRef.current?.reset();
    xtermRef.current?.writeln(
      `\x1b[1;34mSession replay: ${session.server_name}\x1b[0m`
    );
    xtermRef.current?.writeln(
      `\x1b[90mUser: ${session.user_name} | Duration: ${formatDuration(session.duration_seconds)}\x1b[0m\r\n`
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg shadow-lg w-full max-w-4xl mx-4 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b">
          <div className="flex items-center gap-3">
            <Film size={18} className="text-primary" />
            <div>
              <p className="font-semibold text-sm">{session.server_name}</p>
              <p className="text-xs text-muted-foreground">
                {session.user_name} —{" "}
                {new Date(session.started_at).toLocaleString("fr-FR")}
              </p>
            </div>
          </div>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Terminal */}
        <div className="flex-1 p-2 min-h-[400px]">
          <div
            ref={containerRef}
            className="w-full h-full rounded"
            style={{ backgroundColor: "#1a1b26" }}
          />
        </div>

        {/* Controls */}
        <div className="p-3 border-t flex items-center gap-4">
          <div className="flex items-center gap-1">
            {playing ? (
              <button
                onClick={handlePause}
                className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Pause size={16} />
              </button>
            ) : (
              <button
                onClick={handlePlay}
                className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Play size={16} />
              </button>
            )}
            <button
              onClick={handleReset}
              className="p-2 rounded-md hover:bg-accent text-muted-foreground"
            >
              <RotateCcw size={16} />
            </button>
          </div>

          {/* Progress bar */}
          <div className="flex-1">
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <span className="text-xs text-muted-foreground min-w-[40px] text-right">
            {progress}%
          </span>

          {/* Speed control */}
          <div className="flex items-center gap-1">
            <FastForward size={14} className="text-muted-foreground" />
            {[1, 2, 5, 10].map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2 py-0.5 rounded text-xs ${
                  speed === s
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent text-muted-foreground"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [replaySession, setReplaySession] = useState<SessionDetail | null>(
    null
  );
  const [loadingReplay, setLoadingReplay] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api
      .get<SessionData[]>("/api/sessions/")
      .then(setSessions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleReplay = async (id: string) => {
    setLoadingReplay(id);
    try {
      const detail = await api.get<SessionDetail>(`/api/sessions/${id}`);
      setReplaySession(detail);
    } catch {
      // silently fail
    } finally {
      setLoadingReplay(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Supprimer cet enregistrement ?")) return;
    try {
      await api.delete(`/api/sessions/${id}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      // silently fail
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === sessions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessions.map((s) => s.id)));
    }
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Supprimer ${selected.size} enregistrement(s) ?`)) return;
    setDeleting(true);
    try {
      await api.post("/api/sessions/bulk-delete", {
        ids: Array.from(selected),
      });
      setSessions((prev) => prev.filter((s) => !selected.has(s.id)));
      setSelected(new Set());
    } catch {
      // fallback
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteAll = async () => {
    if (sessions.length === 0) return;
    if (!confirm(`Supprimer TOUS les enregistrements (${sessions.length}) ?`)) return;
    setDeleting(true);
    try {
      await api.post("/api/sessions/delete-all", {});
      setSessions([]);
      setSelected(new Set());
    } catch {
      // fallback
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Sessions enregistrées</h2>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-200 bg-red-50 text-red-700 text-xs font-medium hover:bg-red-100 disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              Supprimer la sélection ({selected.size})
            </button>
          )}
          {sessions.length > 0 && (
            <button
              onClick={handleDeleteAll}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium hover:bg-red-50 hover:text-red-700 hover:border-red-200 disabled:opacity-50 text-muted-foreground"
            >
              <Trash2 size={14} />
              Tout supprimer
            </button>
          )}
          <span className="text-sm text-muted-foreground ml-2">
            {sessions.length} enregistrement{sessions.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="bg-card border rounded-lg p-12 text-center">
          <Film size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            Aucune session enregistrée. Ouvrez un terminal vers un serveur pour
            commencer.
          </p>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            <input
              type="checkbox"
              checked={selected.size === sessions.length && sessions.length > 0}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            {selected.size === sessions.length ? "Tout désélectionner" : "Tout sélectionner"}
          </label>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`bg-card border rounded-lg p-4 flex items-center gap-4 transition-colors ${
                selected.has(s.id) ? "border-primary/50 bg-primary/5" : "hover:border-primary/30"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggleSelect(s.id)}
                className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary shrink-0"
              />
              <Film size={20} className="text-primary shrink-0" />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-sm flex items-center gap-1">
                    <Server size={14} className="text-muted-foreground" />
                    {s.server_name}
                  </span>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <User size={12} />
                    {s.user_name}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {new Date(s.started_at).toLocaleString("fr-FR")}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {formatDuration(s.duration_seconds)}
                  </span>
                  <span>{s.event_count} events</span>
                  <span>{formatBytes(s.size_bytes)}</span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleReplay(s.id)}
                  disabled={loadingReplay === s.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {loadingReplay === s.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  Rejouer
                </button>
                <button
                  onClick={() => handleDelete(s.id)}
                  className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600"
                  title="Supprimer"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Replay modal */}
      {replaySession && (
        <SessionPlayer
          session={replaySession}
          onClose={() => setReplaySession(null)}
        />
      )}
    </div>
  );
}
