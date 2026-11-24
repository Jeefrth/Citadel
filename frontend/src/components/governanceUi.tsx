// Shared bits for the governance screens (ACLs, approvals, notifications).
import { Link } from "react-router-dom";
import { AlertTriangle, Hourglass } from "lucide-react";
import {
  isReviewMessage,
  type ApprovalKind,
  type ApprovalStatus,
  type CommandRuleAction,
  type ConnectRuleAction,
  type NotificationLevel,
} from "@/services/types";
import { Chip, type ChipTone } from "@/components/kit";
import { cn } from "@/lib/utils";

export const KIND_LABELS: Record<ApprovalKind, string> = {
  access: "Accès temporaire",
  connect: "Connexion",
  command: "Commande",
};

export const STATUS_INFO: Record<ApprovalStatus, { label: string; tone: ChipTone }> = {
  pending: { label: "En attente", tone: "amber" },
  approved: { label: "Approuvée", tone: "green" },
  rejected: { label: "Refusée", tone: "red" },
  cancelled: { label: "Annulée", tone: "default" },
  expired: { label: "Expirée", tone: "default" },
  used: { label: "Utilisée", tone: "blue" },
};

export function ApprovalStatusChip({ status }: { status: ApprovalStatus }) {
  const s = STATUS_INFO[status] || { label: status, tone: "default" as ChipTone };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export const RULE_ACTION_INFO: Record<CommandRuleAction | ConnectRuleAction, { label: string; tone: ChipTone }> = {
  allow: { label: "Autoriser", tone: "green" },
  deny: { label: "Refuser", tone: "red" },
  review: { label: "Validation", tone: "amber" },
  alert: { label: "Alerte", tone: "orange" },
};

export function RuleActionChip({ action }: { action: string }) {
  const a = RULE_ACTION_INFO[action as CommandRuleAction] || { label: action, tone: "default" as ChipTone };
  return <Chip tone={a.tone}>{a.label}</Chip>;
}

export const LEVEL_INFO: Record<NotificationLevel, { label: string; dot: string; tone: ChipTone }> = {
  info: { label: "Info", dot: "bg-info", tone: "blue" },
  warning: { label: "Avertissement", dot: "bg-live", tone: "amber" },
  critical: { label: "Critique", dot: "bg-danger", tone: "red" },
};

/** "il y a 5 min", "il y a 2 h", "hier", then a short date. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 0) {
    // Future date (deadlines, validity)
    const ahead = -diff;
    if (ahead < 3600) return `dans ${Math.max(1, Math.round(ahead / 60))} min`;
    if (ahead < 86400) return `dans ${Math.round(ahead / 3600)} h`;
    return `dans ${Math.round(ahead / 86400)} j`;
  }
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.round(diff / 3600)} h`;
  if (diff < 172800) return "hier";
  if (diff < 7 * 86400) return `il y a ${Math.round(diff / 86400)} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

/** Human duration for an access request. */
export function formatHours(h: number | undefined): string {
  if (!h) return "-";
  if (h % 24 === 0) return `${h / 24} j`;
  return `${h} h`;
}

/**
 * Banner for a refusal coming from the connection / command ACLs.
 * A "soumise à validation" message gets an amber look and a link to the approvals page.
 */
export function GovernanceNotice({ message, className = "" }: { message: string; className?: string }) {
  const review = isReviewMessage(message);
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        review ? "border-live/30 bg-live/10" : "border-danger/30 bg-danger/10",
        className,
      )}
    >
      {review ? (
        <Hourglass className="mt-0.5 size-4 shrink-0 text-live" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      )}
      <div className="min-w-0 space-y-1 text-foreground">
        <p className="break-words">{message}</p>
        {review && (
          <Link
            to="/approvals?tab=mine"
            className="inline-block font-medium text-live underline-offset-4 hover:underline"
          >
            Voir mes demandes
          </Link>
        )}
      </div>
    </div>
  );
}
