// Shared helpers for the secrets lifecycle screens (rotation, verification,
// discovery). Labels in French, logic mirrors backend/app/services/secrets_ops.py.
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import type {
  AccountData,
  CredentialData,
  DiscoveredStatus,
  SecretHistoryStatus,
  VerifyStatus,
} from "@/services/types";
import { Chip, formatDate, type ChipTone } from "@/components/kit";

// Backend messages are in English; translate the known rotation blockers
// (secrets_ops.rotation_blocker) and fall back to the raw text otherwise.
const BLOCKER_FR: Record<string, string> = {
  "Ephemeral certificate accounts have no secret to rotate":
    "Les comptes à certificat éphémère n'ont pas de secret à faire tourner",
  "SSH key rotation is not supported yet (passwords only)":
    "La rotation des clés SSH n'est pas encore prise en charge (mots de passe uniquement)",
  "Account has no password credential": "Le compte n'a pas de credential à mot de passe",
};

export function blockerLabel(blocker: string | null | undefined): string | null {
  if (!blocker) return null;
  return BLOCKER_FR[blocker] || blocker;
}

/**
 * Client-side equivalent of rotation_blocker() for a form that is being edited
 * (the credential or the certificate mode may have changed since the last load).
 */
export function formRotationBlocker(
  useCert: boolean,
  credentialId: string,
  credentials: CredentialData[],
  account?: AccountData | null
): string | null {
  if (useCert) return BLOCKER_FR["Ephemeral certificate accounts have no secret to rotate"];
  if (account && !account.use_cert && account.credential_id === credentialId) {
    return blockerLabel(account.rotation_blocker);
  }
  const cred = credentials.find((c) => c.id === credentialId);
  if (!cred) return BLOCKER_FR["Account has no password credential"];
  if (cred.type === "ephemeral_cert") return BLOCKER_FR["Ephemeral certificate accounts have no secret to rotate"];
  if (cred.type === "ssh_key") return BLOCKER_FR["SSH key rotation is not supported yet (passwords only)"];
  return null;
}

const VERIFY: Record<VerifyStatus, { label: string; tone: ChipTone; icon: typeof ShieldCheck }> = {
  ok: { label: "vérifié", tone: "green", icon: ShieldCheck },
  failed: { label: "échec", tone: "red", icon: ShieldX },
  error: { label: "erreur", tone: "amber", icon: ShieldAlert },
  unknown: { label: "non vérifié", tone: "default", icon: ShieldQuestion },
};

/** Verification badge; message and date are in the tooltip. */
export function VerifyBadge({ account }: { account: AccountData }) {
  const v = VERIFY[account.verify_status] || VERIFY.unknown;
  const Icon = v.icon;
  const parts: string[] = [];
  if (account.last_verified_at) parts.push(`Vérifié le ${formatDate(account.last_verified_at)}`);
  else parts.push("Jamais vérifié");
  if (account.verify_message) parts.push(account.verify_message);
  return (
    <Chip tone={v.tone} title={parts.join("\n")}>
      <Icon size={11} /> {v.label}
    </Chip>
  );
}

export const HISTORY_STATUS: Record<SecretHistoryStatus, { label: string; tone: ChipTone }> = {
  pending: { label: "en attente", tone: "amber" },
  active: { label: "actif", tone: "green" },
  retired: { label: "retiré", tone: "default" },
  failed: { label: "échec", tone: "red" },
};

export const HISTORY_REASON: Record<string, string> = {
  manual: "Manuelle",
  scheduled: "Planifiée",
};

export const DISCOVERED_STATUS: Record<DiscoveredStatus, { label: string; tone: ChipTone; help: string }> = {
  new: { label: "nouveau", tone: "blue", help: "Compte présent sur le serveur, pas encore traité" },
  ignored: { label: "ignoré", tone: "default", help: "Compte écarté volontairement de la gestion" },
  gone: { label: "disparu", tone: "amber", help: "Compte absent lors de la dernière collecte" },
};

/** Windows lastLogon comes as an ISO date, Linux lastlog as free text. */
export function formatLastLogin(v: string | null): string {
  if (!v) return "jamais";
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return formatDate(v);
  }
  return v;
}
