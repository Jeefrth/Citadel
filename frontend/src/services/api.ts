import {
  BrowserAuthError,
  CacheLookupPolicy,
  InteractionRequiredAuthError,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import { loginRequest, apiConfig } from "./authConfig";

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
  throw new ApiError(formatDetail(error.detail) || `API error ${response.status}`, response.status);
}

/** Authenticated GET returning the raw body as a Blob (recordings, CSV exports). */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(`${apiConfig.baseUrl}${path}`, { headers });
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
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

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
