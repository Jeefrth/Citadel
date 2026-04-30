import { useEffect, useRef, useCallback } from "react";
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

  const connect = useCallback(async () => {
    if (!containerRef.current) return;

    // Get auth token
    let token: string;
    try {
      token = await getToken();
    } catch {
      return;
    }

    // Get container dimensions
    const rect = containerRef.current.getBoundingClientRect();
    const width = Math.round(rect.width) || 1024;
    const height = Math.round(rect.height) || 768;

    // Build WebSocket URL — connect directly to backend port 8000 (bypass Vite proxy for RDP)
    const wsUrl = `ws://localhost:8000/ws/rdp/${serverId}?token=${encodeURIComponent(token)}&width=${width}&height=${height}`;

    // Create Guacamole WebSocket tunnel
    const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;

    // Add display to DOM
    const display = client.getDisplay();
    const element = display.getElement();
    element.style.width = "100%";
    element.style.height = "100%";
    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(element);

    // Mouse input
    const mouse = new Guacamole.Mouse(element);
    mouse.onEach(
      ["mousedown", "mouseup", "mousemove"],
      (e: Guacamole.Mouse.Event) => {
        client.sendMouseState(e.state);
      }
    );

    // Keyboard input
    const keyboard = new Guacamole.Keyboard(document);
    keyboard.onkeydown = (keysym: number) => {
      client.sendKeyEvent(1, keysym);
      return true;
    };
    keyboard.onkeyup = (keysym: number) => {
      client.sendKeyEvent(0, keysym);
    };

    // State changes
    client.onstatechange = (state: number) => {
      // State 5 = disconnected
      if (state === 5) {
        onDisconnected?.();
      }
    };

    client.onerror = (error: Guacamole.Status) => {
      console.error("RDP error:", error.message);
    };

    // Connect (empty data string — our backend handles everything)
    client.connect("");
  }, [serverId, serverName, getToken, onDisconnected]);

  useEffect(() => {
    connect();
    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
    };
  }, [connect]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[500px] bg-black rounded-md overflow-hidden"
    />
  );
}
