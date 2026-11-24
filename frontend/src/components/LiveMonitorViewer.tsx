// Read-only viewer of a live session (admin): xterm fed by /ws/monitor for SSH,
// Guacamole display joined read-only through /ws/monitor-rdp for RDP.
// No keyboard or mouse input is ever forwarded.
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Guacamole from "guacamole-common-js";
import { Eye, Loader2, Power } from "lucide-react";
import { api, getAuthToken, wsBaseUrl } from "@/services/api";
import { errorMessage, type LiveSession, type MonitorMessage, type MonitorTicket } from "@/services/types";
import { ProtocolBadge, READONLY_XTERM_OPTIONS, StatusDot, TERMINAL_BG, b64ToBytes } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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

  return <div ref={containerRef} className="h-full w-full" style={{ backgroundColor: TERMINAL_BG }} />;
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
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: TERMINAL_BG }}
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex h-[90vh] max-w-6xl flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between gap-3 border-b py-3 pl-4 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <ProtocolBadge protocol={session.protocol} />
            <div className="min-w-0">
              <DialogTitle className="truncate font-mono text-sm font-medium">
                {session.account && <span className="text-muted-foreground">{session.account}@</span>}
                {session.server}
              </DialogTitle>
              <DialogDescription className="truncate text-xs">
                {session.user}
                {session.client_ip && (
                  <>
                    {" "}depuis <span className="font-mono">{session.client_ip}</span>
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
          {onKill && state !== "ended" && (
            <Button variant="destructive" size="sm" onClick={onKill}>
              <Power /> Terminer la session
            </Button>
          )}
        </div>

        <div
          className={cn(
            "flex items-center gap-2 border-b px-4 py-1.5 text-xs font-medium",
            state === "error" ? "border-danger/25 bg-danger/10 text-danger" : "border-live/25 bg-live/10 text-live",
          )}
        >
          <Eye className="size-3.5" />
          Lecture seule : aucune saisie n'est transmise à la session
          <span className="ml-auto flex items-center gap-1.5">
            {state === "connecting" && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Connexion...
              </span>
            )}
            {state === "live" && (
              <>
                <StatusDot tone="live" pulse /> En direct
              </>
            )}
            {state === "ended" && <span className="text-muted-foreground">Session terminée</span>}
            {state === "error" && "Erreur"}
          </span>
        </div>

        {(state === "ended" || state === "error") && (
          <div
            className={cn(
              "border-b px-4 py-2 text-sm",
              state === "error" ? "bg-danger/5 text-danger" : "bg-muted text-muted-foreground",
            )}
          >
            {state === "ended"
              ? `La session est terminée.${message ? ` ${message}.` : ""}`
              : `Surveillance impossible : ${message || "erreur inconnue"}`}
          </div>
        )}

        <div className="min-h-0 flex-1 p-3" style={{ backgroundColor: TERMINAL_BG }}>
          {session.protocol === "rdp" ? (
            <RdpMonitor session={session} onState={onState} />
          ) : (
            <SshMonitor session={session} onState={onState} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
