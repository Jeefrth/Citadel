// Shared bits for the audit screens (live sessions, recordings, command journal)
// and the settings cards (status dot, card frame, tooltip, table skeleton).
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Monitor, Terminal as TerminalIcon } from "lucide-react";
import type { ITerminalOptions } from "@xterm/xterm";
import type { CommandDecision, CommandSource, RecordingStorageType, SessionProtocol } from "@/services/types";
import { Chip, type ChipTone } from "@/components/kit";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Terminal surface: always "Nuit", in both themes (it frames xterm and Guacamole). */
export const TERMINAL_BG = "#0E1525";

/** xterm options shared by the replay player and the live monitor (read-only). */
export const READONLY_XTERM_OPTIONS: ITerminalOptions = {
  cursorBlink: false,
  disableStdin: true,
  fontSize: 13,
  lineHeight: 1.2,
  fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  theme: {
    background: TERMINAL_BG,
    foreground: "#E6EBF5",
    cursor: "#F2A93B",
    cursorAccent: TERMINAL_BG,
    selectionBackground: "#F2A93B4D",
    black: "#1A2336",
    red: "#F0526B",
    green: "#3DD68C",
    yellow: "#F2A93B",
    blue: "#7AA2F7",
    magenta: "#BB9AF7",
    cyan: "#7DCFFF",
    white: "#C7D0E0",
    brightBlack: "#5B6781",
    brightRed: "#F0526B",
    brightGreen: "#3DD68C",
    brightYellow: "#F2A93B",
    brightBlue: "#7AA2F7",
    brightMagenta: "#BB9AF7",
    brightCyan: "#7DCFFF",
    brightWhite: "#E6EBF5",
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
    <Chip tone="default" title={rdp ? "Bureau à distance (RDP)" : "Terminal SSH"}>
      <Icon className="size-3" />
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
  return <Chip>{STORAGE_LABELS[type] || type}</Chip>;
}

export const DECISION_INFO: Record<CommandDecision, { label: string; tone: ChipTone }> = {
  allowed: { label: "Autorisée", tone: "green" },
  alert: { label: "Alerte", tone: "orange" },
  denied: { label: "Refusée", tone: "red" },
  review: { label: "En validation", tone: "amber" },
  approved_run: { label: "Validée", tone: "green" },
};

export function DecisionChip({ decision }: { decision: string }) {
  if (decision === "approved_run") {
    // Approved after review: green outline, to tell it apart from a plain "Autorisée"
    return (
      <span className="inline-flex h-5 items-center whitespace-nowrap rounded-md border border-success/50 px-1.5 text-xs font-medium text-success">
        {DECISION_INFO.approved_run.label}
      </span>
    );
  }
  const d = DECISION_INFO[decision as CommandDecision] || { label: decision, tone: "default" as ChipTone };
  return <Chip tone={d.tone}>{d.label}</Chip>;
}

export const SOURCE_LABELS: Record<CommandSource, string> = {
  terminal: "Terminal",
  execute: "Exécution",
};

// ── Small shared UI helpers ──────────────────────────────────

/** Tooltip around any element (the trigger must accept a ref). */
export function Tip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className={cn("max-w-sm", className)}>{content}</TooltipContent>
    </Tooltip>
  );
}

export type DotTone = "success" | "danger" | "live" | "muted";

const DOT: Record<DotTone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  live: "bg-live",
  muted: "bg-muted-foreground/40",
};

/** State dot (success / danger / live / muted). `pulse` is reserved for the live state. */
export function StatusDot({ tone, pulse = false, label }: { tone: DotTone; pulse?: boolean; label?: string }) {
  return (
    <span className="relative inline-flex size-2.5 shrink-0 items-center justify-center" aria-label={label} role={label ? "img" : undefined}>
      {pulse && (
        <motion.span
          className={cn("absolute inset-0 rounded-full", DOT[tone])}
          initial={{ scale: 1, opacity: 0.6 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span className={cn("relative size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

/** Settings card: title (+ optional status dot / icon), one sentence, actions on the right. */
export function SettingsCard({
  title,
  description,
  icon: Icon,
  status,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: typeof Monitor;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("rounded-lg shadow-none", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            {status}
            {Icon && <Icon className="size-4 text-muted-foreground" />}
            {title}
          </h3>
          {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && <div className="px-5 py-4">{children}</div>}
    </Card>
  );
}

/** Label / value row used inside settings cards. */
export function FactRow({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2.5 last:border-0">
      <div className="min-w-0">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  );
}

/** Inline error line under an object (last delivery error...). */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p className="break-words rounded-md border border-danger/25 bg-danger/10 px-2 py-1 text-xs text-danger">{children}</p>
  );
}

/** Skeleton rows on the shape of a table body. */
export function TableSkeleton({ rows = 5, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r} className="hover:bg-transparent">
          {Array.from({ length: cols }).map((__, c) => (
            <TableCell key={c} className="h-11">
              <Skeleton className={cn("h-3.5", c === 0 ? "w-24" : c % 3 === 0 ? "w-16" : "w-28")} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/** Skeleton for a list of compact rows (settings cards). */
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-2.5 rounded-full" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="ml-auto h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}
