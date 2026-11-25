import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { isReviewMessage, type ConnectionChoice } from "@/services/types";
import { GovernanceNotice } from "@/components/governanceUi";
import { wsBaseUrl as defaultWsBaseUrl } from "@/services/api";
import { orgAuthFields } from "@/services/org";

/** Refusals from the connection ACL (deny or review) get a banner above the terminal. */
function isGovernanceMessage(msg: string): boolean {
  return isReviewMessage(msg) || /refusée par la règle/i.test(msg);
}

/**
 * Terminal palette aligned on the "Salle de contrôle" tokens. The terminal stays dark
 * in both themes: it is a terminal.
 */
export const TERMINAL_BG = "#0E1525";
export const XTERM_THEME = {
  background: TERMINAL_BG,
  foreground: "#E6EBF5",
  cursor: "#F2A93B",
  cursorAccent: TERMINAL_BG,
  selectionBackground: "rgba(242, 169, 59, 0.3)",
  black: "#1A2336",
  red: "#F0526B",
  green: "#3DD68C",
  yellow: "#F2A93B",
  blue: "#7AA2F7",
  magenta: "#C49BF2",
  cyan: "#5CCFE6",
  white: "#C9D1E3",
  brightBlack: "#5B6781",
  brightRed: "#F57A8E",
  brightGreen: "#6BE3A8",
  brightYellow: "#F6C26F",
  brightBlue: "#9DBBFA",
  brightMagenta: "#D6B8F6",
  brightCyan: "#8ADDEE",
  brightWhite: "#F4F6FA",
};

interface TerminalProps {
  serverId: string;
  serverName: string;
  getToken: () => Promise<string>;
  certDuration?: number; // minutes, passed to backend for cert signing
  connection?: ConnectionChoice; // account picked before connecting (default account otherwise)
  wsBaseUrl?: string;
  /** WebSocket path; default /ws/terminal/{serverId}. Same protocol for /ws/k8s-exec/{clusterId}. */
  wsPath?: string;
  /** Extra fields of the first "auth" message (namespace, pod, container for Kubernetes). */
  authExtra?: Record<string, unknown>;
  onDisconnected?: () => void;
}

export default function Terminal({
  serverId,
  serverName,
  getToken,
  certDuration,
  connection,
  wsBaseUrl,
  wsPath,
  authExtra,
  onDisconnected,
}: TerminalProps) {
  // Kept in refs: a new callback or object identity from the parent must not reconnect the session
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;
  const authExtraRef = useRef(authExtra);
  authExtraRef.current = authExtra;
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [govMessage, setGovMessage] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (!containerRef.current) return;

    // Create xterm instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, monospace",
      theme: XTERM_THEME,
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
    const base = wsBaseUrl || defaultWsBaseUrl();
    const ws = new WebSocket(`${base}${wsPath || `/ws/terminal/${serverId}`}`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send auth message with terminal dimensions + cert duration
      const dims = fitAddon.proposeDimensions();
      const authMsg: Record<string, unknown> = {
        ...(authExtraRef.current || {}),
        ...orgAuthFields(),
        type: "auth",
        token,
        cols: dims?.cols || 80,
        rows: dims?.rows || 24,
      };
      if (certDuration) {
        authMsg.cert_duration = certDuration;
      }
      if (connection?.account_id) {
        authMsg.account_id = connection.account_id;
      } else if (connection?.virtual_account) {
        authMsg.virtual_account = connection.virtual_account;
        if (connection.virtual_account === "@INPUT") {
          authMsg.input_username = connection.input_username;
          authMsg.input_password = connection.input_password;
        }
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
          if (typeof msg.message === "string" && isGovernanceMessage(msg.message)) {
            setGovMessage(msg.message);
          }
          break;

        case "disconnected":
          xterm.writeln("\r\n\x1b[1;33mSession disconnected\x1b[0m");
          onDisconnectedRef.current?.();
          break;
      }
    };

    ws.onclose = () => {
      xterm.writeln("\r\n\x1b[1;33mConnection closed\x1b[0m");
      onDisconnectedRef.current?.();
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
  }, [serverId, serverName, getToken, certDuration, connection, wsBaseUrl, wsPath]);

  useEffect(() => {
    const cleanup = connect();

    return () => {
      cleanup?.then((fn) => fn?.());
      wsRef.current?.close();
      xtermRef.current?.dispose();
    };
  }, [connect]);

  return (
    <div className="flex h-full min-h-[400px] w-full flex-col gap-2">
      {govMessage && <GovernanceNotice message={govMessage} />}
      <div
        className="dark min-h-[400px] w-full flex-1 overflow-hidden rounded-lg border p-2"
        style={{ backgroundColor: TERMINAL_BG }}
      >
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
