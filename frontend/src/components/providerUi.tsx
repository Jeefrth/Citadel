// Sign-in provider display: one generic icon per kind (no brand logos) and labels.
import { Building2, Globe, KeyRound, ShieldCheck, type LucideIcon } from "lucide-react";

export const PROVIDER_KIND_LABELS: Record<string, string> = {
  entra: "Microsoft Entra",
  okta: "Okta",
  google: "Google Workspace",
  oidc: "OIDC générique",
};

const ICONS: Record<string, LucideIcon> = {
  entra: Building2,
  okta: ShieldCheck,
  google: Globe,
};

export function ProviderIcon({ kind, className = "size-4" }: { kind: string; className?: string }) {
  const Icon = ICONS[kind] ?? KeyRound;
  return <Icon className={className} aria-hidden="true" />;
}
