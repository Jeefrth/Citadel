// Shared bits for the operations screens (files, jobs, playbooks, zones, cloud).
import { Chip, type ChipTone } from "@/components/kit";
import type { JobData, JobStatus, JobTargetStatus, ServerData } from "@/services/types";
import { Cloud, CloudOff, Loader2, Route } from "lucide-react";

/** Human readable size, French units ("12,4 Mo"). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/** Duration between two ISO dates ("1 min 05 s"), or since `start` when `end` is null. */
export function durationBetween(start: string | null, end: string | null): string {
  if (!start) return "-";
  const s = Math.max(0, Math.round(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(r).padStart(2, "0")} s`;
  return `${r} s`;
}

export const JOB_STATUS: Record<JobStatus, { label: string; tone: ChipTone }> = {
  pending: { label: "En attente", tone: "amber" },
  running: { label: "En cours", tone: "amber" },
  success: { label: "Réussie", tone: "green" },
  partial: { label: "Partielle", tone: "orange" },
  failed: { label: "Échec", tone: "red" },
  cancelled: { label: "Annulée", tone: "default" },
};

export const TARGET_STATUS: Record<JobTargetStatus, { label: string; tone: ChipTone }> = {
  pending: { label: "En attente", tone: "amber" },
  running: { label: "En cours", tone: "amber" },
  success: { label: "Réussi", tone: "green" },
  failed: { label: "Échec", tone: "red" },
  skipped: { label: "Ignoré", tone: "orange" },
  cancelled: { label: "Annulé", tone: "default" },
};

export function JobStatusChip({ status }: { status: JobStatus }) {
  const s = JOB_STATUS[status] || { label: status, tone: "default" as ChipTone };
  return (
    <Chip tone={s.tone}>
      {status === "running" && <Loader2 className="size-3 animate-spin" />}
      {s.label}
    </Chip>
  );
}

export function TargetStatusChip({ status }: { status: JobTargetStatus }) {
  const s = TARGET_STATUS[status] || { label: status, tone: "default" as ChipTone };
  return (
    <Chip tone={s.tone}>
      {status === "running" && <Loader2 className="size-3 animate-spin" />}
      {s.label}
    </Chip>
  );
}

export const isJobActive = (s: JobStatus) => s === "pending" || s === "running";

/** Parse a JSON object typed in a textarea; returns [value, error]. Empty = {}. */
export function parseJsonObject(text: string): [Record<string, unknown> | null, string | null] {
  if (!text.trim()) return [{}, null];
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return [null, "Saisissez un objet JSON, par exemple {\"version\": \"1.2\"}."];
    return [v as Record<string, unknown>, null];
  } catch (e) {
    return [null, `JSON invalide : ${e instanceof Error ? e.message : ""}`];
  }
}

/** Zone chip (servers behind SSH gateways) and Azure chip (imported VMs). */
export function ServerOriginChips({ server }: { server: Pick<ServerData, "zone_name" | "cloud_ref" | "cloud_state"> }) {
  const azure = server.cloud_ref?.startsWith("azure:");
  if (!server.zone_name && !server.cloud_ref) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {server.zone_name && (
        <Chip title="Joint par les passerelles SSH de cette zone">
          <Route className="size-3" />
          {server.zone_name}
        </Chip>
      )}
      {server.cloud_ref &&
        (server.cloud_state === "missing" ? (
          <Chip tone="red" title="La VM n'existe plus côté Azure. Le serveur est conservé dans Citadel.">
            <CloudOff className="size-3" />
            {azure ? "Azure" : "Cloud"} : disparue
          </Chip>
        ) : (
          <Chip tone="blue" title={server.cloud_ref}>
            <Cloud className="size-3" />
            {azure ? "Azure" : "Cloud"}
          </Chip>
        ))}
    </span>
  );
}

/** "2/3 réussies", plus failures and skipped targets when any. */
export function targetsSummary(job: Pick<JobData, "counts" | "target_count" | "status">): string {
  const c = job.counts || {};
  const ok = c.success || 0;
  const parts = [`${ok}/${job.target_count} réussie${ok > 1 ? "s" : ""}`];
  if (c.failed) parts.push(`${c.failed} en échec`);
  if (c.skipped) parts.push(`${c.skipped} ignorée${c.skipped > 1 ? "s" : ""}`);
  const running = (c.running || 0) + (c.pending || 0);
  if (running && isJobActive(job.status)) parts.push(`${running} en cours`);
  return parts.join(" · ");
}

