import { useEffect, useRef } from "react";
import Guacamole from "guacamole-common-js";

interface RdpViewerProps {
  serverId: string;
  serverName: string;
  getToken: () => Promise<string>;
  onDisconnected?: () => void;
}

export default function RdpViewer({
  serverId,
  serverName,
  getToken,
  onDisconnected,
}: RdpViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let client: Guacamole.Client | null = null;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      let token: string;
      try {
        token = await getToken();
      } catch {
        return;
      }
      if (cancelled) return;

      const container = containerRef.current!;
      const rect = container.getBoundingClientRect();
      const width = Math.min(Math.round(rect.width) || 1024, 1920);
      const height = Math.min(Math.round(rect.height) || 768, 1080);

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//${window.location.host}/ws/rdp/${serverId}?token=${encodeURIComponent(token)}&width=${width}&height=${height}`;

      const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
      client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      const element = display.getElement();
      container.innerHTML = "";
      container.appendChild(element);

      // Scaling state
      let currentScale = 1;
      let offsetX = 0;
      let offsetY = 0;

      const scaleDisplay = () => {
        const cRect = container.getBoundingClientRect();
        const dw = display.getWidth();
        const dh = display.getHeight();
        if (dw && dh && cRect.width && cRect.height) {
          currentScale = Math.min(cRect.width / dw, cRect.height / dh);
          display.scale(currentScale);
          const scaledW = dw * currentScale;
          const scaledH = dh * currentScale;
          offsetX = Math.max(0, (cRect.width - scaledW) / 2);
          offsetY = Math.max(0, (cRect.height - scaledH) / 2);
          element.style.position = "absolute";
          element.style.left = `${offsetX}px`;
          element.style.top = `${offsetY}px`;
        }
      };

      display.onresize = () => scaleDisplay();
      resizeObserver = new ResizeObserver(() => scaleDisplay());
      resizeObserver.observe(container);

      // Mouse input on CONTAINER — calculate display coordinates manually
      const mouseState = { x: 0, y: 0, left: false, middle: false, right: false, up: false, down: false };

      const toDisplayCoords = (clientX: number, clientY: number) => {
        const cRect = container.getBoundingClientRect();
        const x = (clientX - cRect.left - offsetX) / currentScale;
        const y = (clientY - cRect.top - offsetY) / currentScale;
        return { x: Math.round(x), y: Math.round(y) };
      };

      const sendMouse = () => {
        const state = new Guacamole.Mouse.State(
          mouseState.x, mouseState.y,
          mouseState.left, mouseState.middle, mouseState.right,
          mouseState.up, mouseState.down
        );
        client!.sendMouseState(state);
      };

      container.addEventListener("mousemove", (e) => {
        const { x, y } = toDisplayCoords(e.clientX, e.clientY);
        mouseState.x = x;
        mouseState.y = y;
        sendMouse();
      });
      container.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const { x, y } = toDisplayCoords(e.clientX, e.clientY);
        mouseState.x = x;
        mouseState.y = y;
        if (e.button === 0) mouseState.left = true;
        if (e.button === 1) mouseState.middle = true;
        if (e.button === 2) mouseState.right = true;
        sendMouse();
      });
      container.addEventListener("mouseup", (e) => {
        const { x, y } = toDisplayCoords(e.clientX, e.clientY);
        mouseState.x = x;
        mouseState.y = y;
        if (e.button === 0) mouseState.left = false;
        if (e.button === 1) mouseState.middle = false;
        if (e.button === 2) mouseState.right = false;
        sendMouse();
      });
      container.addEventListener("wheel", (e) => {
        e.preventDefault();
        const { x, y } = toDisplayCoords(e.clientX, e.clientY);
        mouseState.x = x;
        mouseState.y = y;
        mouseState.up = e.deltaY < 0;
        mouseState.down = e.deltaY > 0;
        sendMouse();
        // Reset scroll buttons
        mouseState.up = false;
        mouseState.down = false;
        sendMouse();
      }, { passive: false });
      container.addEventListener("contextmenu", (e) => e.preventDefault());

      // Keyboard input
      const keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (keysym: number) => {
        client!.sendKeyEvent(1, keysym);
        return true;
      };
      keyboard.onkeyup = (keysym: number) => {
        client!.sendKeyEvent(0, keysym);
      };

      client.onstatechange = (state: number) => {
        if (state === 5) onDisconnected?.();
      };

      client.onerror = (error: Guacamole.Status) => {
        console.error("[RDP] error:", error.code, error.message);
      };

      client.connect("");
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      if (client) {
        client.disconnect();
        client = null;
        clientRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const sendCtrlAltDel = () => {
    const client = clientRef.current;
    if (!client) return;
    client.sendKeyEvent(1, 0xFFE3);
    client.sendKeyEvent(1, 0xFFE9);
    client.sendKeyEvent(1, 0xFFFF);
    client.sendKeyEvent(0, 0xFFFF);
    client.sendKeyEvent(0, 0xFFE9);
    client.sendKeyEvent(0, 0xFFE3);
  };

  return (
    <div className="w-full h-full min-h-[500px] flex flex-col">
      <div className="flex items-center gap-2 p-1 bg-zinc-800 rounded-t-md">
        <button
          onClick={sendCtrlAltDel}
          className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded"
        >
          Ctrl+Alt+Del
        </button>
      </div>
      <div
        ref={containerRef}
        className="flex-1 bg-black rounded-b-md overflow-hidden relative cursor-none"
      />
    </div>
  );
}
