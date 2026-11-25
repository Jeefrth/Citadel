// Popup flows run inside the current session: re-authentication before a terminal
// (new auth_time) and linking another sign-in provider (Mon compte).
import { api } from "./api";
import { DEV_MODE, refreshSession, runAuthPopup } from "./session";

/**
 * Sign in again at the provider of the current session, then refresh the access
 * token so it carries the new auth_time. Call it straight from a click (the popup
 * opens before any await). Throws with a readable message on failure.
 */
export async function reauthenticate(): Promise<void> {
  if (DEV_MODE) return;
  const result = await runAuthPopup(
    async () => (await api.post<{ url: string }>("/api/auth/reauth", {})).url,
    "citadel-reauth",
  );
  if (!result.ok) throw new Error(result.message || "La nouvelle authentification a échoué.");
  const token = await refreshSession();
  if (!token) throw new Error("La session a pris fin. Reconnectez-vous.");
}

/** Link another provider to this person (popup); throws with a readable message on failure. */
export async function linkProvider(providerId: string): Promise<string> {
  const result = await runAuthPopup(
    async () => (await api.post<{ url: string }>(`/api/auth/link/${encodeURIComponent(providerId)}`, {})).url,
    "citadel-link",
  );
  if (!result.ok) throw new Error(result.message || "La liaison a échoué.");
  return result.message || "Compte lié.";
}

/** WebSocket error asking for a recent sign-in at the provider. */
export function isReauthRequired(message: unknown): boolean {
  return typeof message === "string" && message.includes("reauth_required");
}
