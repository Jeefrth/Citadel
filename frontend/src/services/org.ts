// Organisation selection (SaaS phase 1). The chosen organisation slug is kept in
// localStorage and sent as X-Citadel-Org on every API call and in WebSocket auth
// messages. No stored slug: the backend uses the user's first organisation.
// Storage may be unavailable (private mode, blocked site data): every access is guarded.

const ORG_KEY = "citadel.org";

function readStoredSlug(): string | null {
  try {
    return localStorage.getItem(ORG_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Organisation of THIS tab, read once at load. Another tab switching organisation
 * changes localStorage but never this value: this tab keeps acting in its own
 * organisation until it is reloaded (see onOrgChangedElsewhere).
 */
let currentSlug: string | null = readStoredSlug();

export function getOrgSlug(): string | null {
  return currentSlug;
}

export function setOrgSlug(slug: string): void {
  currentSlug = slug;
  try {
    localStorage.setItem(ORG_KEY, slug);
  } catch {
    /* storage unavailable: only this tab knows the choice */
  }
}

export function clearOrgSlug(): void {
  currentSlug = null;
  try {
    localStorage.removeItem(ORG_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ── Organisation changed in another tab ───────────────
let changedElsewhere = false;
const changeListeners = new Set<(changed: boolean) => void>();

/** True when another tab stored a different organisation than this tab's. */
export function orgChangedElsewhere(): boolean {
  return changedElsewhere;
}

export function onOrgChangedElsewhere(listener: (changed: boolean) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    // key null: the whole storage was cleared
    if (e.key !== ORG_KEY && e.key !== null) return;
    const stored = e.key === null ? null : e.newValue || null;
    const changed = stored !== currentSlug;
    if (changed === changedElsewhere) return;
    changedElsewhere = changed;
    changeListeners.forEach((l) => l(changed));
  });
}

/** Extra fields for WebSocket `{"type": "auth"}` messages: the selected organisation, if any. */
export function orgAuthFields(): { org?: string } {
  const slug = getOrgSlug();
  return slug ? { org: slug } : {};
}

/**
 * Switch to another organisation: every cached query belongs to the previous one,
 * so the whole app is reloaded on the dashboard.
 */
export function switchOrg(slug: string): void {
  setOrgSlug(slug);
  window.location.assign("/");
}

/**
 * 403 details meaning the stored organisation cannot be used by this user.
 * "Aucune organisation pour ce compte" is NOT one of them: that person has no
 * organisation at all and gets the no-organisation screen (see isNoOrgError).
 */
const ORG_REFUSED = /organisation inconnue|pas membre de cette organisation/i;
const NO_ORG = /aucune organisation pour ce compte/i;
/** Exact 403 detail when the organisation's address allow-list refuses this request. */
export const IP_REFUSED_DETAIL = "Adresse IP non autorisée par cette organisation";

// ── Address refused by the organisation (SaaS phase 2) ──
let ipBlocked = false;
const ipListeners = new Set<(blocked: boolean) => void>();

export function isIpBlocked(): boolean {
  return ipBlocked;
}

/** Any API call refused by the allow-list: the app switches to the "access refused" screen. */
export function markIpBlocked(): void {
  if (ipBlocked) return;
  ipBlocked = true;
  ipListeners.forEach((l) => l(true));
}

export function onIpBlocked(listener: (blocked: boolean) => void): () => void {
  ipListeners.add(listener);
  return () => {
    ipListeners.delete(listener);
  };
}

/** The signed-in person belongs to no organisation (403 "Aucune organisation pour ce compte"). */
export function isNoOrgError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { status, message } = e as { status?: unknown; message?: unknown };
  return status === 403 && typeof message === "string" && NO_ORG.test(message);
}

let resetting = false;

/**
 * The stored organisation was refused (unknown, inactive or no membership): forget it
 * and reload once on the default organisation. Returns true when a reload was started.
 * Without a stored slug nothing happens, so a refusal of the default org cannot loop.
 */
export function handleOrgRefused(status: number, detail: string): boolean {
  // Neither "no organisation" nor "address refused" means the stored slug is wrong
  if (status !== 403 || detail === IP_REFUSED_DETAIL || NO_ORG.test(detail) || !ORG_REFUSED.test(detail)) return false;
  if (!getOrgSlug()) return false;
  if (resetting) return true;
  resetting = true;
  clearOrgSlug();
  window.location.assign("/");
  return true;
}

export const ROLE_LABELS: Record<string, string> = {
  admin: "Administrateur",
  operator: "Opérateur",
  viewer: "Lecteur",
};

export function roleLabel(role: string | null | undefined): string {
  return role ? ROLE_LABELS[role] || role : "";
}

/** Slug suggested from an organisation name: lowercase ASCII letters, digits and dashes. */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export const SLUG_PATTERN = /^[a-z0-9-]{3,63}$/;
