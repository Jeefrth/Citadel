// Recording replay players: SSH (xterm fed with timestamped output events)
// and RDP (Guacamole protocol dump replayed with Guacamole.SessionRecording).
// Both support play / pause, seeking and an initial offset (command journal link).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Guacamole from "guacamole-common-js";
import { Loader2, Pause, Play, RotateCcw } from "lucide-react";
import type { SessionRecordingData, SessionRecordingDetail } from "@/services/types";
import {
  ProtocolBadge,
  READONLY_XTERM_OPTIONS,
  TERMINAL_BG,
  Tip,
  b64ToBytes,
  formatClock,
} from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex h-[90vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-3 border-b py-3 pl-4 pr-12">
          <ProtocolBadge protocol={rec.protocol} />
          <div className="min-w-0">
            <DialogTitle className="truncate font-mono text-sm font-medium">
              {rec.account && <span className="text-muted-foreground">{rec.account}@</span>}
              {rec.server_name}
            </DialogTitle>
            <DialogDescription className="truncate text-xs">
              {rec.user_name}, {new Date(rec.started_at).toLocaleString("fr-FR")}
              {rec.client_ip && (
                <>
                  , depuis <span className="font-mono">{rec.client_ip}</span>
                </>
              )}
            </DialogDescription>
          </div>
        </div>
        {banner}
        <div className="min-h-0 flex-1 p-3" style={{ backgroundColor: TERMINAL_BG }}>
          {children}
        </div>
        <div className="flex items-center gap-3 border-t px-4 py-2.5">{controls}</div>
      </DialogContent>
    </Dialog>
  );
}

/** Slim seek bar: a thin track with the played part, a native range on top for input and keyboard. */
function SeekBar({
  position,
  duration,
  disabled,
  onSeek,
}: {
  position: number;
  duration: number;
  disabled?: boolean;
  onSeek: (ms: number) => void;
}) {
  const max = Math.max(1, duration);
  const pct = Math.min(100, (Math.min(position, duration) / max) * 100);
  return (
    <div className={cn("group relative flex h-5 flex-1 items-center", disabled && "opacity-50")}>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/80" style={{ width: `${pct}%` }} />
      </div>
      <div
        className="pointer-events-none absolute size-3 -translate-x-1/2 rounded-full border-2 border-background bg-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        style={{ left: `${pct}%` }}
      />
      <input
        type="range"
        min={0}
        max={max}
        step={100}
        value={Math.min(position, duration)}
        disabled={disabled}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        aria-label="Position"
      />
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
  return (
    <>
      <div className="flex items-center gap-1">
        {playing ? (
          <Tip content="Pause">
            <Button size="icon" className="size-8" onClick={onPause} aria-label="Pause">
              <Pause />
            </Button>
          </Tip>
        ) : (
          <Tip content="Lecture">
            <Button size="icon" className="size-8" onClick={onPlay} disabled={disabled} aria-label="Lecture">
              <Play />
            </Button>
          </Tip>
        )}
        <Tip content="Revenir au début">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={onRestart}
            disabled={disabled}
            aria-label="Revenir au début"
          >
            <RotateCcw />
          </Button>
        </Tip>
      </div>
      <span className="tabular w-14 text-right font-mono text-xs text-muted-foreground">{formatClock(position)}</span>
      <SeekBar position={position} duration={duration} disabled={disabled} onSeek={onSeek} />
      <span className="tabular w-14 font-mono text-xs text-muted-foreground">{formatClock(duration)}</span>
      {extra}
    </>
  );
}

function SpeedPicker({ speed, onChange }: { speed: number; onChange: (s: number) => void }) {
  return (
    <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="Vitesse de lecture">
      {SPEEDS.map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          aria-pressed={speed === s}
          className={cn(
            "tabular h-6 rounded-sm px-2 text-xs transition-colors",
            speed === s ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
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
    <div className="border-b border-info/25 bg-info/10 px-4 py-1.5 text-xs text-info">
      Lecture positionnée à <span className="tabular font-mono">{formatClock(ms)}</span>, au moment de la commande du
      journal.
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
  // Callback ref: the dialog portal mounts its content after this component's first effects
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
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
    if (!containerEl) return;
    const x = new XTerm(READONLY_XTERM_OPTIONS);
    const fit = new FitAddon();
    x.loadAddon(fit);
    x.open(containerEl);
    fit.fit();
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerEl);
    xtermRef.current = x;
    writeHeader(x);
    if (initialMs) seekTo(initialMs);
    return () => {
      stop();
      ro.disconnect();
      x.dispose();
      xtermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, containerEl]);

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
      <div ref={setContainerEl} className="h-full w-full" style={{ backgroundColor: TERMINAL_BG }} />
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
  // Callback ref: the dialog portal mounts its content after this component's first effects
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const recordingRef = useRef<Guacamole.SessionRecording | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerEl;
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
  }, [blob, containerEl]);

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
            <div className="flex items-center gap-2 border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Chargement de l'enregistrement (
              <span className="tabular font-mono">{formatClock(duration)}</span> analysées)...
            </div>
          )}
          {error && <div className="border-b border-danger/25 bg-danger/10 px-4 py-2 text-sm text-danger">{error}</div>}
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
        ref={setContainerEl}
        className="relative h-full w-full overflow-hidden"
        style={{ backgroundColor: TERMINAL_BG }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </PlayerShell>
  );
}
