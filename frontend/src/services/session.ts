// Citadel session (SaaS phase 3). Sign-in happens on the server (OIDC at the
// provider); the browser holds an HttpOnly refresh cookie (path /api/auth) and
// exchanges it for short access tokens with POST /api/auth/refresh. The access
// token lives in memory only (never in storage). The cookie rotates on every
// refresh, so refreshes are single-flight and scheduled ~60 s before expiry.
// Cookie endpoints (/api/auth/login, refresh, logout) are always called on the
// app origin, never on VITE_API_URL: the cookie is set there by the callback.
import { useEffect, useState } from "react";

export const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

const REFRESH_HEADER = { "X-Citadel-Refresh": "1" };
/** Refresh this long before the access token expires. */
const EARLY_SECONDS = 60;

let accessToken: string | null = null;
let expiresAt = 0; // ms epoch
let authTime = 0; // s epoch, last interactive sign-in at the provider
let inflight: Promise<string | null> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

// ── Signed-in state (drives App: sign-in page or app) ──
export type AuthState = "loading" | "signedIn" | "signedOut";
let state: AuthState = DEV_MODE ? "signedIn" : "loading";
const listeners = new Set<(s: AuthState) => void>();

function setState(next: AuthState): void {
  if (state === next) return;
  state = next;
  listeners.forEach((l) => l(next));
}

export function useAuthState(): AuthState {
  const [s, set] = useState(state);
  useEffect(() => {
    listeners.add(set);
    set(state);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return s;
}

function schedule(expiresInSeconds: number): void {
  if (timer) clearTimeout(timer);
  const delay = Math.max(5, expiresInSeconds - EARLY_SECONDS) * 1000;
  timer = setTimeout(() => {
    refreshSession().catch(() => {
      /* network error: the next API call retries */
    });
  }, delay);
}

function clearToken(): void {
  accessToken = null;
  expiresAt = 0;
  authTime = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Exchange the refresh cookie for a new access token. Single-flight: concurrent
 * callers share the same request (the cookie rotates on each call).
 * Resolves null when not signed in (401); rejects on a network or server error.
 */
export function refreshSession(): Promise<string | null> {
  if (DEV_MODE) return Promise.resolve(null);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`/api/auth/refresh`, {
        method: "POST",
        headers: REFRESH_HEADER,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 401) {
        clearToken();
        setState("signedOut");
        return null;
      }
      if (!res.ok) throw new Error(`Renouvellement de session impossible (${res.status})`);
      const data = (await res.json()) as { access_token: string; expires_in: number; auth_time: number };
      accessToken = data.access_token;
      expiresAt = Date.now() + data.expires_in * 1000;
      authTime = data.auth_time;
      schedule(data.expires_in);
      setState("signedIn");
      return accessToken;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** App start: one refresh decides between the sign-in page and the app. */
export async function bootstrapSession(): Promise<void> {
  if (DEV_MODE) return;
  try {
    await refreshSession();
  } catch {
    setState("signedOut");
  }
}

/**
 * Access token for API calls and WebSocket auth messages (null in dev mode).
 * When the session is over, switches the app to the sign-in page and never settles.
 */
export async function getAccessToken(): Promise<string | null> {
  if (DEV_MODE) return null;
  if (accessToken && Date.now() < expiresAt - 15_000) return accessToken;
  const token = await refreshSession();
  if (token) return token;
  return new Promise<string>(() => {});
}

/** Time of the last interactive sign-in of this session (s epoch, 0 when unknown). */
export function sessionAuthTime(): number {
  return authTime;
}

/** The API answered 401 even after a refresh: back to the sign-in page. */
export function markSignedOut(): void {
  clearToken();
  setState("signedOut");
}

/** End the Citadel session (cookie revoked server-side), then back to the sign-in page. */
export async function logout(): Promise<void> {
  if (!DEV_MODE) {
    try {
      await fetch(`/api/auth/logout`, {
        method: "POST",
        headers: REFRESH_HEADER,
        credentials: "same-origin",
      });
    } catch {
      /* already offline: the cookie expires on its own */
    }
  }
  clearToken();
  window.location.assign("/");
}

/** Full-page navigation to a provider (sign-in). */
export function signInUrl(providerId: string, returnTo: string, loginHint?: string): string {
  const q = new URLSearchParams({ return_to: returnTo || "/" });
  if (loginHint) q.set("login_hint", loginHint);
  return `/api/auth/login/${encodeURIComponent(providerId)}?${q.toString()}`;
}

// ── Popups (re-authentication, linking another provider) ──

export class PopupBlockedError extends Error {
  constructor() {
    super(
      "La fenêtre de connexion a été bloquée par le navigateur. Autorisez les fenêtres surgissantes pour ce site, puis réessayez.",
    );
    this.name = "PopupBlockedError";
  }
}

export interface PopupResult {
  ok: boolean;
  message: string;
}

/**
 * Open a centred popup right away (call it synchronously from a click, before any
 * await, or browsers block it), load the URL given by `getUrl`, then wait for the
 * `{type}` message posted by the final page. Only messages from this origin and
 * from this popup are accepted.
 */
export async function runAuthPopup(getUrl: () => Promise<string>, type: string): Promise<PopupResult> {
  const w = 500;
  const h = 650;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  const popup = window.open("", "citadel-auth", `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!popup) throw new PopupBlockedError();

  let url: string;
  try {
    url = await getUrl();
  } catch (e) {
    popup.close();
    throw e;
  }
  popup.location.href = url;

  return new Promise<PopupResult>((resolve) => {
    let done = false;
    const finish = (r: PopupResult) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      resolve(r);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data as { type?: unknown; ok?: unknown; message?: unknown } | null;
      if (!data || data.type !== type) return;
      finish({ ok: data.ok === true, message: typeof data.message === "string" ? data.message : "" });
    };
    window.addEventListener("message", onMessage);
    // Closed by the person before the end: give the last message a moment to arrive
    const poll = setInterval(() => {
      if (popup.closed) {
        clearInterval(poll);
        setTimeout(() => finish({ ok: false, message: "Fenêtre de connexion fermée avant la fin." }), 300);
      }
    }, 500);
  });
}
