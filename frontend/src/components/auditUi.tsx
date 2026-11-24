// Shared bits for the audit screens (live sessions, recordings, command journal).
import { Monitor, Terminal as TerminalIcon } from "lucide-react";
import type { ITerminalOptions } from "@xterm/xterm";
import type { CommandDecision, CommandSource, RecordingStorageType, SessionProtocol } from "@/services/types";
import { Chip, type ChipTone } from "@/components/ui";

/** xterm options shared by the replay player and the live monitor (read-only). */
export const READONLY_XTERM_OPTIONS: ITerminalOptions = {
  cursorBlink: false,
  disableStdin: true,
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
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
};

export function b64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/** "1 h 02 min", "3 min 05 s", "12 s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(r).padStart(2, "0")} s`;
  return `${r} s`;
}

/** Player clock: "m:ss" or "h:mm:ss" from milliseconds. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1048576).toFixed(1)} Mo`;
}

export function ProtocolBadge({ protocol }: { protocol: SessionProtocol }) {
  const rdp = protocol === "rdp";
  const Icon = rdp ? Monitor : TerminalIcon;
  return (
    <Chip tone={rdp ? "blue" : "default"} title={rdp ? "Bureau à distance (RDP)" : "Terminal SSH"}>
      <Icon size={12} />
      {rdp ? "RDP" : "SSH"}
    </Chip>
  );
}

export const STORAGE_LABELS: Record<RecordingStorageType, string> = {
  local: "Local",
  s3: "S3",
  azure: "Azure Blob",
};

export function StorageChip({ type }: { type: RecordingStorageType | null }) {
  if (!type) return <Chip title="Ancien enregistrement stocké en base, sans empreinte">Base</Chip>;
  return <Chip tone="primary">{STORAGE_LABELS[type] || type}</Chip>;
}

export const DECISION_INFO: Record<CommandDecision, { label: string; tone: ChipTone }> = {
  allowed: { label: "Autorisée", tone: "green" },
  alert: { label: "Alerte", tone: "orange" },
  denied: { label: "Refusée", tone: "red" },
  review: { label: "En validation", tone: "amber" },
  approved_run: { label: "Validée", tone: "blue" },
};

export function DecisionChip({ decision }: { decision: string }) {
  const d = DECISION_INFO[decision as CommandDecision] || { label: decision, tone: "default" as ChipTone };
  return <Chip tone={d.tone}>{d.label}</Chip>;
}

export const SOURCE_LABELS: Record<CommandSource, string> = {
  terminal: "Terminal",
  execute: "Exécution",
};
