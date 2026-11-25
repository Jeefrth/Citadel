import {
  BrowserAuthError,
  CacheLookupPolicy,
  InteractionRequiredAuthError,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import { loginRequest, apiConfig } from "./authConfig";
import { getOrgSlug, handleOrgRefused } from "./org";

const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

let msalInstance: IPublicClientApplication | null = null;

export function setMsalInstance(instance: IPublicClientApplication) {
  msalInstance = instance;
}

// Errors meaning "silent renewal is not possible, the user must go through Entra again"
const INTERACTIVE_CODES = new Set(["monitor_window_timeout", "timed_out", "no_tokens_found", "block_iframe_reload"]);
let redirecting = false;

/**
 * Access token for the Citadel API.
 *
 * Silent renewal uses the cache then the refresh token only, never the hidden
 * iframe: with device-based Conditional Access (Intune, platform SSO) the
 * iframe cannot complete and MSAL fails after a 10 s "monitor_window_timeout".
 * When silent renewal is not possible, the whole tab is redirected to Entra
 * (where Conditional Access can run) and comes back to the same page.
 */
async function getToken(): Promise<string | null> {
  if (DEV_MODE) return null;

  if (!msalInstance) throw new Error("MSAL not initialized");

  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
  if (!account) throw new Error("No authenticated account");

  try {
    const response = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account,
      cacheLookupPolicy: CacheLookupPolicy.AccessTokenAndRefreshToken,
    });
    return response.accessToken;
  } catch (e) {
    const interactive =
      e instanceof InteractionRequiredAuthError ||
      (e instanceof BrowserAuthError && INTERACTIVE_CODES.has(e.errorCode));
    if (!interactive) throw e;
    if (!redirecting) {
      redirecting = true;
      await msalInstance.acquireTokenRedirect({
        ...loginRequest,
        account,
        redirectStartPage: window.location.href,
      });
    }
    // The page is navigating away: never resolve, so callers don't show an error
    return new Promise<string>(() => {});
  }
}

// ── Device identifier (lot 6) ──────────────────────────
// Each browser sends a random id in X-Citadel-Device so an admin (or the user)
// can sign this browser out of Citadel. Kept in localStorage; storage may be
// unavailable (private mode, blocked site data): fall back to an in-memory id.

const DEVICE_KEY = "citadel.device";
const SIGNOUT_KEY = "citadel.signout";
let memoryDeviceId: string | null = null;

function newDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const id = memoryDeviceId ?? newDeviceId();
    localStorage.setItem(DEVICE_KEY, id);
    memoryDeviceId = id;
    return id;
  } catch {
    memoryDeviceId ??= newDeviceId();
    return memoryDeviceId;
  }
}

function forgetDeviceId(): void {
  memoryDeviceId = null;
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Reason shown on the sign-in page after a forced sign-out. */
export function signOutReason(): string | null {
  try {
    return localStorage.getItem(SIGNOUT_KEY);
  } catch {
    return null;
  }
}

export function clearSignOutReason(): void {
  try {
    localStorage.removeItem(SIGNOUT_KEY);
  } catch {
    /* storage unavailable */
  }
}

let signingOut = false;

/**
 * This browser was signed out of Citadel ("Déconnecter" in Mon compte or by an
 * admin): forget the device id, then sign out of MSAL. The next sign-in gets a
 * fresh device id.
 */
export function handleDeviceRevoked(): void {
  if (signingOut) return;
  signingOut = true;
  forgetDeviceId();
  try {
    localStorage.setItem(
      SIGNOUT_KEY,
      "Ce navigateur a été déconnecté de Citadel. Reconnectez-vous pour continuer.",
    );
  } catch {
    /* storage unavailable: no message on the sign-in page */
  }
  if (DEV_MODE || !msalInstance) {
    window.location.reload();
    return;
  }
  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
  msalInstance.logoutRedirect(account ? { account } : undefined).catch(() => window.location.reload());
}

function isDeviceRevoked(status: number, detail: unknown): boolean {
  return status === 401 && detail === "device_revoked";
}

/**
 * Headers sent on every API call: device id, the selected organisation (if any),
 * plus the bearer token when there is one.
 */
function baseHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { "X-Citadel-Device": getDeviceId() };
  const org = getOrgSlug();
  if (org) headers["X-Citadel-Org"] = org;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// FastAPI returns either a string or a list of validation errors in `detail`
function formatDetail(detail: unknown): string {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
      .join(" ; ");
  }
  return JSON.stringify(detail);
}

/** Error thrown by the API helpers; `status` lets callers react to e.g. 409 (integrity). */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Bearer token for WebSocket auth messages (same MSAL token as the terminal).
 * In dev mode the backend ignores it, so an empty string is returned.
 */
export async function getAuthToken(): Promise<string> {
  return (await getToken()) || "";
}

/** ws(s)://host, matching the page protocol (same origin as the API). */
export function wsBaseUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

async function throwForResponse(response: Response): Promise<never> {
  const error = await response.json().catch(() => ({ detail: response.statusText }));
  if (isDeviceRevoked(response.status, error?.detail)) {
    handleDeviceRevoked();
    // The page is navigating away: never settle, so callers don't show an error
    return new Promise<never>(() => {});
  }
  const message = formatDetail(error?.detail);
  if (handleOrgRefused(response.status, message)) {
    // Stored organisation refused: the page reloads on the default one
    return new Promise<never>(() => {});
  }
  throw new ApiError(message || `API error ${response.status}`, response.status);
}

/** Authenticated GET returning the raw body as a Blob (recordings, CSV exports). */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = await getToken();
  const response = await fetch(`${apiConfig.baseUrl}${path}`, { headers: baseHeaders(token) });
  if (!response.ok) await throwForResponse(response);
  return response.blob();
}

/** Authenticated POST with a JSON body returning a Blob (e.g. ZIP of recordings). */
export async function postBlob(path: string, body: unknown): Promise<Blob> {
  const token = await getToken();
  const response = await fetch(`${apiConfig.baseUrl}${path}`, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwForResponse(response);
  return response.blob();
}

/** Save a Blob as a file through a temporary link. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers as Record<string, string>,
    ...baseHeaders(token),
  };

  const response = await fetch(`${apiConfig.baseUrl}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) await throwForResponse(response);

  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (path: string) =>
    apiFetch<void>(path, { method: "DELETE" }),
};

/**
 * Authenticated multipart POST with upload progress (XMLHttpRequest, since fetch
 * has no upload progress). `onProgress` receives a ratio between 0 and 1.
 */
export async function postMultipart<T>(
  path: string,
  form: FormData,
  onProgress?: (ratio: number) => void,
): Promise<T> {
  const token = await getToken();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiConfig.baseUrl}${path}`);
    for (const [k, v] of Object.entries(baseHeaders(token))) xhr.setRequestHeader(k, v);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
      } else {
        const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
        if (isDeviceRevoked(xhr.status, detail)) {
          handleDeviceRevoked();
          return;
        }
        const message = formatDetail(detail);
        if (handleOrgRefused(xhr.status, message)) return;
        reject(new ApiError(message || `API error ${xhr.status}`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError("Erreur réseau pendant l'envoi", 0));
    xhr.onabort = () => reject(new ApiError("Envoi annulé", 0));
    xhr.send(form);
  });
}
