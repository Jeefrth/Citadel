// Read-only viewer of a live session (admin): xterm fed by /ws/monitor for SSH,
// Guacamole display joined read-only through /ws/monitor-rdp for RDP.
// No keyboard or mouse input is ever forwarded.
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Guacamole from "guacamole-common-js";
import { Eye, Loader2, Power, X } from "lucide-react";
import { api, getAuthToken, wsBaseUrl } from "@/services/api";
import { errorMessage, type LiveSession, type MonitorMessage, type MonitorTicket } from "@/services/types";
import { ProtocolBadge, READONLY_XTERM_OPTIONS, b64ToBytes } from "@/components/auditUi";

type ViewerState = "connecting" | "live" | "ended" | "error";

interface StateProps {
  onState: (s: ViewerState, message?: string) => void;
}

function SshMonitor({ session, onState }: { session: LiveSession } & StateProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let ended = false;
    let ws: WebSocket | null = null;

    const xterm = new XTerm(READONLY_XTERM_OPTIONS);
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(containerRef.current);
    fit.fit();
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    (async () => {
      let token: string;
      try {
        token = await getAuthToken();
      } catch (e) {
        onState("error", `Jeton d'authentification indisponible : ${errorMessage(e)}`);
        return;
      }
      if (disposed) return;
      ws = new WebSocket(`${wsBaseUrl()}/ws/monitor/${encodeURIComponent(session.session_id)}`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token }));
      ws.onmessage = (event) => {
        let msg: MonitorMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "meta":
            onState("live");
            break;
          case "output":
            xterm.write(b64ToBytes(msg.data));
            break;
          case "ended":
            ended = true;
            xterm.writeln("\r\n\x1b[1;33m[Session terminée]\x1b[0m");
            onState("ended");
            break;
          case "error":
            ended = true;
            onState("error", msg.message);
            break;
        }
      };
      ws.onclose = () => {
        if (!disposed && !ended) onState("ended", "Connexion de surveillance fermée");
      };
      ws.onerror = () => {
        if (!disposed) onState("error", "Erreur WebSocket");
      };
    })();

    return () => {
      disposed = true;
      ro.disconnect();
      ws?.close();
      xterm.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.session_id]);

  return <div ref={containerRef} className="w-full h-full rounded" style={{ backgroundColor: "#1a1b26" }} />;
}

function RdpMonitor({ session, onState }: { session: LiveSession } & StateProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let client: Guacamole.Client | null = null;
    let ro: ResizeObserver | null = null;

    (async () => {
      let ticket: MonitorTicket;
      try {
        ticket = await api.post<MonitorTicket>(
          `/api/live-sessions/${encodeURIComponent(session.session_id)}/monitor-ticket`,
          {}
        );
      } catch (e) {
        if (!cancelled) onState("error", errorMessage(e));
        return;
      }
      if (cancelled) return;

      const container = containerRef.current!;
      // Join with the original session size so the shared display matches
      const width = ticket.width || session.width || 1024;
      const height = ticket.height || session.height || 768;
      const url =
        `${wsBaseUrl()}/ws/monitor-rdp/${encodeURIComponent(session.session_id)}` +
        `?ticket=${encodeURIComponent(ticket.ticket)}&width=${width}&height=${height}`;

      client = new Guacamole.Client(new Guacamole.WebSocketTunnel(url));
      const display = client.getDisplay();
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
      ro = new ResizeObserver(() => scale());
      ro.observe(container);

      // Read-only: no Guacamole.Mouse / Guacamole.Keyboard attached on purpose
      client.onstatechange = (state: number) => {
        if (cancelled) return;
        if (state === 3) onState("live"); // CONNECTED
        if (state === 5) onState("ended"); // DISCONNECTED
      };
      client.onerror = (status: Guacamole.Status) => {
        if (!cancelled) onState("error", status.message || `Erreur Guacamole ${status.code}`);
      };
      client.connect("");
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      client?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.session_id]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-black rounded overflow-hidden relative"
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

export default function LiveMonitorViewer({
  session,
  onClose,
  onKill,
}: {
  session: LiveSession;
  onClose: () => void;
  onKill?: () => void;
}) {
  const [state, setState] = useState<ViewerState>("connecting");
  const [message, setMessage] = useState<string | null>(null);

  const onState = (s: ViewerState, msg?: string) => {
    // "ended" / "error" are final
    setState((prev) => (prev === "ended" || prev === "error" ? prev : s));
    if (msg) setMessage((prev) => prev || msg);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg shadow-lg w-full max-w-6xl mx-4 flex flex-col h-[90vh]">
        <div className="flex items-center justify-between gap-3 p-3 border-b">
          <div className="flex items-center gap-3 min-w-0">
            <Eye size={18} className="text-primary shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold text-sm flex items-center gap-2">
                <ProtocolBadge protocol={session.protocol} />
                <span className="truncate">
                  {session.account ? `${session.account}@` : ""}
                  {session.server}
                </span>
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {session.user}
                {session.client_ip && <> depuis {session.client_ip}</>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onKill && state !== "ended" && (
              <button
                onClick={onKill}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-medium hover:bg-red-700"
              >
                <Power size={14} /> Terminer
              </button>
            )}
            <button onClick={onClose} title="Fermer">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 bg-red-600 text-white text-xs font-semibold">
          <Eye size={14} />
          Lecture seule : aucune saisie n'est transmise à la session
          <span className="ml-auto flex items-center gap-1.5 font-normal">
            {state === "connecting" && (
              <>
                <Loader2 size={12} className="animate-spin" /> Connexion...
              </>
            )}
            {state === "live" && (
              <>
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> En direct
              </>
            )}
            {state === "ended" && "Session terminée"}
            {state === "error" && "Erreur"}
          </span>
        </div>

        {(state === "ended" || state === "error") && (
          <div
            className={`px-3 py-2 text-sm border-b ${
              state === "error" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"
            }`}
          >
            {state === "ended"
              ? `La session est terminée.${message ? ` ${message}.` : ""}`
              : `Surveillance impossible : ${message || "erreur inconnue"}`}
          </div>
        )}

        <div className="flex-1 p-2 min-h-0">
          {session.protocol === "rdp" ? (
            <RdpMonitor session={session} onState={onState} />
          ) : (
            <SshMonitor session={session} onState={onState} />
          )}
        </div>
      </div>
    </div>
  );
}
