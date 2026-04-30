import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  serverId: string;
  serverName: string;
  getToken: () => Promise<string>;
  certDuration?: number; // minutes, passed to backend for cert signing
  wsBaseUrl?: string;
  onDisconnected?: () => void;
}

export default function Terminal({
  serverId,
  serverName,
  getToken,
  certDuration,
  wsBaseUrl,
  onDisconnected,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const connect = useCallback(async () => {
    if (!containerRef.current) return;

    // Create xterm instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
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
    const webLinksAddon = new WebLinksAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);

    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    xterm.writeln(`\x1b[1;34mConnecting to ${serverName}...\x1b[0m`);

    // Get auth token
    let token: string;
    try {
      token = await getToken();
    } catch {
      xterm.writeln("\x1b[1;31mFailed to get authentication token\x1b[0m");
      return;
    }

    // Open WebSocket
    const base = wsBaseUrl || `ws://${window.location.host}`;
    const ws = new WebSocket(`${base}/ws/terminal/${serverId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send auth message with terminal dimensions + cert duration
      const dims = fitAddon.proposeDimensions();
      const authMsg: Record<string, unknown> = {
        type: "auth",
        token,
        cols: dims?.cols || 80,
        rows: dims?.rows || 24,
      };
      if (certDuration) {
        authMsg.cert_duration = certDuration;
      }
      ws.send(JSON.stringify(authMsg));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "connected":
          xterm.writeln(`\x1b[1;32mConnected! Session: ${msg.session_id.slice(0, 8)}...\x1b[0m\r\n`);
          break;

        case "output": {
          // Decode base64 data
          const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
          xterm.write(bytes);
          break;
        }

        case "error":
          xterm.writeln(`\r\n\x1b[1;31mError: ${msg.message}\x1b[0m`);
          break;

        case "disconnected":
          xterm.writeln("\r\n\x1b[1;33mSession disconnected\x1b[0m");
          onDisconnected?.();
          break;
      }
    };

    ws.onclose = () => {
      xterm.writeln("\r\n\x1b[1;33mConnection closed\x1b[0m");
      onDisconnected?.();
    };

    ws.onerror = () => {
      xterm.writeln("\r\n\x1b[1;31mWebSocket error\x1b[0m");
    };

    // Forward keystrokes to WebSocket
    xterm.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "input",
            data: btoa(data),
          })
        );
      }
    });

    // Handle binary data (for paste operations with special chars)
    xterm.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "input",
            data: btoa(data),
          })
        );
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: dims.cols,
            rows: dims.rows,
          })
        );
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [serverId, serverName, getToken, wsBaseUrl, onDisconnected]);

  useEffect(() => {
    const cleanup = connect();

    return () => {
      cleanup?.then((fn) => fn?.());
      wsRef.current?.close();
      xtermRef.current?.dispose();
    };
  }, [connect]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[400px] rounded-md overflow-hidden"
      style={{ backgroundColor: "#1a1b26" }}
    />
  );
}
