// Organisation selection (SaaS phase 1). The chosen organisation slug is kept in
// localStorage and sent as X-Citadel-Org on every API call and in WebSocket auth
// messages. No stored slug: the backend uses the user's first organisation.
// Storage may be unavailable (private mode, blocked site data): every access is guarded.

const ORG_KEY = "citadel.org";

export function getOrgSlug(): string | null {
  try {
    return localStorage.getItem(ORG_KEY) || null;
  } catch {
    return null;
  }
}

export function setOrgSlug(slug: string): void {
  try {
    localStorage.setItem(ORG_KEY, slug);
  } catch {
    /* storage unavailable: the backend keeps using the default organisation */
  }
}

export function clearOrgSlug(): void {
  try {
    localStorage.removeItem(ORG_KEY);
  } catch {
    /* storage unavailable */
  }
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

/** 403 details meaning the stored organisation cannot be used by this user. */
const ORG_REFUSED = /organisation inconnue|pas membre de cette organisation/i;

let resetting = false;

/**
 * The stored organisation was refused (unknown, inactive or no membership): forget it
 * and reload once on the default organisation. Returns true when a reload was started.
 * Without a stored slug nothing happens, so a refusal of the default org cannot loop.
 */
export function handleOrgRefused(status: number, detail: string): boolean {
  if (status !== 403 || !ORG_REFUSED.test(detail)) return false;
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
