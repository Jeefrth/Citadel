// Recording replay players: SSH (xterm fed with timestamped output events)
// and RDP (Guacamole protocol dump replayed with Guacamole.SessionRecording).
// Both support play / pause, seeking and an initial offset (command journal link).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Guacamole from "guacamole-common-js";
import { FastForward, Film, Loader2, Pause, Play, RotateCcw, X } from "lucide-react";
import type { SessionRecordingData, SessionRecordingDetail } from "@/services/types";
import { ProtocolBadge, READONLY_XTERM_OPTIONS, b64ToBytes, formatClock } from "@/components/auditUi";

const SPEEDS = [1, 2, 5, 10];

function PlayerShell({
  rec,
  onClose,
  children,
  controls,
  banner,
}: {
  rec: SessionRecordingData;
  onClose: () => void;
  children: ReactNode;
  controls: ReactNode;
  banner?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg shadow-lg w-full max-w-5xl mx-4 flex flex-col h-[90vh]">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="flex items-center gap-3 min-w-0">
            <Film size={18} className="text-primary shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold text-sm flex items-center gap-2">
                <ProtocolBadge protocol={rec.protocol} />
                <span className="truncate">
                  {rec.account ? `${rec.account}@` : ""}
                  {rec.server_name}
                </span>
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {rec.user_name} · {new Date(rec.started_at).toLocaleString("fr-FR")}
                {rec.client_ip && <> · {rec.client_ip}</>}
              </p>
            </div>
          </div>
          <button onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        {banner}
        <div className="flex-1 p-2 min-h-0">{children}</div>
        <div className="p-3 border-t flex items-center gap-4">{controls}</div>
      </div>
    </div>
  );
}

function Transport({
  playing,
  onPlay,
  onPause,
  onRestart,
  position,
  duration,
  onSeek,
  disabled,
  extra,
}: {
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onRestart: () => void;
  position: number;
  duration: number;
  onSeek: (ms: number) => void;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const playBtn = "p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
  return (
    <>
      <div className="flex items-center gap-1">
        {playing ? (
          <button onClick={onPause} className={playBtn} title="Pause">
            <Pause size={16} />
          </button>
        ) : (
          <button onClick={onPlay} disabled={disabled} className={playBtn} title="Lecture">
            <Play size={16} />
          </button>
        )}
        <button
          onClick={onRestart}
          disabled={disabled}
          className="p-2 rounded-md hover:bg-accent text-muted-foreground disabled:opacity-50"
          title="Revenir au début"
        >
          <RotateCcw size={16} />
        </button>
      </div>
      <span className="text-xs font-mono text-muted-foreground tabular-nums">{formatClock(position)}</span>
      <input
        type="range"
        min={0}
        max={Math.max(1, duration)}
        step={100}
        value={Math.min(position, duration)}
        disabled={disabled}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="flex-1 accent-[hsl(var(--primary))]"
        aria-label="Position"
      />
      <span className="text-xs font-mono text-muted-foreground tabular-nums">{formatClock(duration)}</span>
      {extra}
    </>
  );
}

function SpeedPicker({ speed, onChange }: { speed: number; onChange: (s: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <FastForward size={14} className="text-muted-foreground" />
      {SPEEDS.map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`px-2 py-0.5 rounded text-xs ${
            speed === s ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
          }`}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}

function OffsetBanner({ ms }: { ms: number | null | undefined }) {
  if (ms == null) return null;
  return (
    <div className="px-3 py-1.5 text-xs bg-blue-50 text-blue-800 border-b">
      Lecture positionnée à {formatClock(ms)}, au moment de la commande du journal.
    </div>
  );
}

// ── SSH ──────────────────────────────────────────────────

export function SshReplayPlayer({
  session,
  initialMs,
  onClose,
}: {
  session: SessionRecordingDetail;
  initialMs?: number | null;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idxRef = useRef(0);
  const posRef = useRef(0);
  const speedRef = useRef(1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);

  const events = useMemo(() => session.events.filter((e) => e.type === "o"), [session]);
  const duration = useMemo(
    () => Math.max(events.length ? events[events.length - 1].t : 0, session.duration_seconds * 1000),
    [events, session.duration_seconds]
  );

  const writeHeader = useCallback(
    (x: XTerm) => {
      x.writeln(`\x1b[1;34mRelecture : ${session.server_name}\x1b[0m`);
      x.writeln(
        `\x1b[90mUtilisateur : ${session.user_name} | Durée : ${formatClock(duration)} | Événements : ${events.length}\x1b[0m\r\n`
      );
    },
    [session, duration, events.length]
  );

  const stop = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  /** Redraw the terminal as it was at `ms` (all output up to that point). */
  const seekTo = useCallback(
    (ms: number) => {
      const x = xtermRef.current;
      if (!x) return;
      const target = Math.max(0, Math.min(ms, duration));
      x.reset();
      writeHeader(x);
      let i = 0;
      while (i < events.length && events[i].t <= target) {
        x.write(b64ToBytes(events[i].data));
        i++;
      }
      idxRef.current = i;
      posRef.current = target;
      setPosition(target);
    },
    [events, duration, writeHeader]
  );

  const step = useCallback(() => {
    const i = idxRef.current;
    if (i >= events.length) {
      posRef.current = duration;
      setPosition(duration);
      setPlaying(false);
      timerRef.current = null;
      return;
    }
    const ev = events[i];
    const delay = Math.max(0, (ev.t - posRef.current) / speedRef.current);
    timerRef.current = setTimeout(() => {
      xtermRef.current?.write(b64ToBytes(ev.data));
      idxRef.current = i + 1;
      posRef.current = ev.t;
      setPosition(ev.t);
      step();
    }, delay);
  }, [events, duration]);

  useEffect(() => {
    if (!containerRef.current) return;
    const x = new XTerm(READONLY_XTERM_OPTIONS);
    const fit = new FitAddon();
    x.loadAddon(fit);
    x.open(containerRef.current);
    fit.fit();
    xtermRef.current = x;
    writeHeader(x);
    if (initialMs) seekTo(initialMs);
    return () => {
      stop();
      x.dispose();
      xtermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const play = () => {
    if (idxRef.current >= events.length) seekTo(0);
    setPlaying(true);
    stop();
    step();
  };
  const pause = () => {
    stop();
    setPlaying(false);
  };
  const seek = (ms: number) => {
    const wasPlaying = timerRef.current !== null;
    stop();
    seekTo(ms);
    if (wasPlaying) step();
  };
  const changeSpeed = (s: number) => {
    speedRef.current = s;
    setSpeed(s);
    if (timerRef.current) {
      // reschedule the pending event with the new speed
      stop();
      step();
    }
  };

  return (
    <PlayerShell
      rec={session}
      onClose={onClose}
      banner={<OffsetBanner ms={initialMs} />}
      controls={
        <Transport
          playing={playing}
          onPlay={play}
          onPause={pause}
          onRestart={() => {
            pause();
            seekTo(0);
          }}
          position={position}
          duration={duration}
          onSeek={seek}
          extra={<SpeedPicker speed={speed} onChange={changeSpeed} />}
        />
      }
    >
      <div ref={containerRef} className="w-full h-full rounded" style={{ backgroundColor: "#1a1b26" }} />
    </PlayerShell>
  );
}

// ── RDP ──────────────────────────────────────────────────

export function RdpReplayPlayer({
  rec,
  blob,
  initialMs,
  onClose,
}: {
  rec: SessionRecordingData;
  blob: Blob;
  initialMs?: number | null;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef<Guacamole.SessionRecording | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // guacamole-common-js 1.5.0 bug: a Blob source is parsed through an uninitialised
    // variable and throws. Feed the Blob through a StaticHTTPTunnel on an object URL
    // instead (same parser, works), then connect() once the handlers are set.
    const blobUrl = URL.createObjectURL(blob);
    const tunnel = new Guacamole.StaticHTTPTunnel(blobUrl);
    const recording = new Guacamole.SessionRecording(tunnel);
    recordingRef.current = recording;
    let disposed = false;

    recording.onprogress = (d: number) => !disposed && setDuration(d);
    recording.onload = () => {
      if (disposed) return;
      setLoaded(true);
      setDuration(recording.getDuration());
      if (initialMs) recording.seek(initialMs);
    };
    recording.onerror = (m: string) => !disposed && setError(m || "Enregistrement illisible");
    recording.onplay = () => !disposed && setPlaying(true);
    recording.onpause = () => !disposed && setPlaying(false);
    recording.onseek = (p: number) => !disposed && setPosition(p);

    const display = recording.getDisplay();
    const element = display.getElement();
    container.innerHTML = "";
    container.appendChild(element);
    const scale = () => {
      const r = container.getBoundingClientRect();
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (!dw || !dh || !r.width || !r.height) return;
      const s = Math.min(r.width / dw, r.height / dh);
      display.scale(s);
      element.style.position = "absolute";
      element.style.left = `${Math.max(0, (r.width - dw * s) / 2)}px`;
      element.style.top = `${Math.max(0, (r.height - dh * s) / 2)}px`;
    };
    display.onresize = () => scale();
    const ro = new ResizeObserver(() => scale());
    ro.observe(container);
    recording.connect();

    // onseek is not guaranteed for every frame during playback: poll the position too
    const poll = setInterval(() => {
      if (recording.isPlaying()) setPosition(recording.getPosition());
    }, 250);

    return () => {
      disposed = true;
      clearInterval(poll);
      ro.disconnect();
      recording.pause();
      try {
        recording.abort(); // aborts the tunnel's fetch: throws an AbortError we don't care about
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(blobUrl);
      recordingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blob]);

  const play = () => {
    const r = recordingRef.current;
    if (!r) return;
    if (r.getPosition() >= r.getDuration() - 1) r.seek(0, () => r.play());
    else r.play();
  };

  return (
    <PlayerShell
      rec={rec}
      onClose={onClose}
      banner={
        <>
          <OffsetBanner ms={initialMs} />
          {!loaded && !error && (
            <div className="px-3 py-1.5 text-xs bg-muted text-muted-foreground border-b flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Chargement de l'enregistrement ({formatClock(duration)}{" "}
              analysées)...
            </div>
          )}
          {error && <div className="px-3 py-2 text-sm bg-red-50 text-red-800 border-b">{error}</div>}
        </>
      }
      controls={
        <Transport
          playing={playing}
          onPlay={play}
          onPause={() => recordingRef.current?.pause()}
          onRestart={() => {
            recordingRef.current?.pause();
            recordingRef.current?.seek(0);
          }}
          position={position}
          duration={duration}
          onSeek={(ms) => {
            setPosition(ms);
            recordingRef.current?.seek(ms);
          }}
          disabled={duration === 0 || !!error}
        />
      }
    >
      <div
        ref={containerRef}
        className="w-full h-full bg-black rounded overflow-hidden relative"
        onContextMenu={(e) => e.preventDefault()}
      />
    </PlayerShell>
  );
}
