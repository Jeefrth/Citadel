// Shared API types (mirror backend/app/schemas)

export type OSType = "linux" | "windows";
export type ServerAction = "connect" | "execute" | "copy" | "paste";
export const ALL_ACTIONS: ServerAction[] = ["connect", "execute", "copy", "paste"];
export type VirtualAccount = "@ALL" | "@USER" | "@INPUT";
export const VIRTUAL_ACCOUNTS: VirtualAccount[] = ["@ALL", "@USER", "@INPUT"];

export interface AccountSummary {
  id: string;
  username: string;
  auth: "password" | "ssh_key" | "cert" | "none";
  privileged: boolean;
  is_default: boolean;
}

export interface ServerData {
  id: string;
  name: string;
  hostname: string;
  ip_address: string;
  os_type: OSType;
  os_version: string | null;
  ssh_port: number;
  winrm_port: number;
  rdp_port: number;
  status: "online" | "offline" | "unknown";
  last_seen: string | null;
  tags: Record<string, string> | null;
  node_id: string | null;
  node_path: string | null;
  created_at: string;
  default_account: AccountSummary | null;
  accounts_count: number;
  is_favorite: boolean;
  actions: ServerAction[];
}

export interface NodeData {
  id: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  path: string;
  server_count: number;
}

export interface CredentialData {
  id: string;
  name: string;
  type: string;
  username: string;
  cert_validity_minutes?: number | null;
  created_at: string;
}

export interface AccountData {
  id: string;
  server_id: string;
  username: string;
  credential_id: string | null;
  credential_name: string | null;
  auth: "password" | "ssh_key" | "cert" | "none";
  use_cert: boolean;
  privileged: boolean;
  is_default: boolean;
  is_active: boolean;
  description: string | null;
  created_at: string;
  // Secrets lifecycle (rotation / verification)
  rotation_enabled: boolean;
  rotation_interval_days: number;
  rotation_supported: boolean;
  /** Why the account cannot be rotated (certificate, SSH key...), null when supported. */
  rotation_blocker: string | null;
  last_rotated_at: string | null;
  /** Null when rotation is off, unsupported, or the account was never rotated yet. */
  next_rotation_at: string | null;
  last_rotation_status: "ok" | "failed" | null;
  last_rotation_message: string | null;
  verify_status: VerifyStatus;
  verify_message: string | null;
  last_verified_at: string | null;
}

export type VerifyStatus = "unknown" | "ok" | "failed" | "error";

/** Result of POST .../verify and POST .../rotate. */
export interface AccountOperationResult {
  ok: boolean;
  message: string;
  account: AccountData | null;
}

export type SecretHistoryStatus = "pending" | "active" | "retired" | "failed";

/** One generated secret of an account (metadata only, never the secret). */
export interface SecretHistoryEntry {
  id: string;
  status: SecretHistoryStatus;
  reason: string; // manual | scheduled | ...
  error: string | null;
  actor_id: string | null;
  created_at: string;
  activated_at: string | null;
}

export type DiscoveredStatus = "new" | "ignored" | "gone";

export interface DiscoveredAccountData {
  id: string;
  server_id: string;
  server_name: string | null;
  username: string;
  /** Linux uid or Windows SID. */
  uid: string | null;
  /** Login shell (Linux only). */
  shell: string | null;
  enabled: boolean | null;
  privileged: boolean;
  /** Free text as reported by the target (lastlog line or ISO date). */
  last_login: string | null;
  status: DiscoveredStatus;
  /** A Citadel account with this username exists on the server. */
  managed: boolean;
  first_seen: string;
  last_seen: string;
}

export interface ManageDiscoveredBody {
  credential_id?: string | null;
  use_cert: boolean;
  privileged?: boolean | null;
  rotation_enabled: boolean;
}

export interface OperationMessage {
  ok: boolean;
  message: string;
}

export interface VaultStatusOk {
  reachable: true;
  initialized: boolean | null;
  sealed: boolean | null;
  version: string | null;
  // Only present when SECRETS_BACKEND is vault and the vault is unsealed
  transit_key?: string;
  latest_version?: number;
  min_decryption_version?: number;
  outdated_blobs?: number;
}

export interface VaultStatusDown {
  reachable: false;
  error: string;
}

export interface SecretsStatus {
  secrets_backend: "local" | "vault";
  ca_backend: string;
  vault_addr: string | null;
  /** Encrypted blob counts keyed by "local" or "vault:v<N>". */
  blobs: Record<string, number>;
  local_blobs: number;
  local_key_configured: boolean;
  vault: VaultStatusOk | VaultStatusDown | null;
}

export interface SecretsMigrateResult {
  migrated: number;
  failed: number;
  errors: string[];
}

export interface SecretsRotateKeyResult {
  latest_version: number;
  rewrapped: number;
}

export interface ConnectableAccount {
  id: string | null;
  username: string;
  privileged: boolean;
  is_default: boolean;
  virtual: null | "@USER" | "@INPUT";
  /** Secret type; the backend already filters out what the protocol cannot use. */
  auth: "password" | "ssh_key" | "cert";
}

/** Account chosen by the user before opening a terminal / RDP session. */
export interface ConnectionChoice {
  account_id?: string;
  virtual_account?: "@USER" | "@INPUT";
  input_username?: string;
  input_password?: string;
  /** Label shown in the UI (never contains the password). */
  label: string;
}

export interface ConnectTicketResponse {
  ticket: string;
  expires_in: number;
  account: string;
}

export interface UserData {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "operator" | "viewer";
  is_active: boolean;
  last_login: string | null;
  created_at?: string;
}

export interface UserBrief {
  id: string;
  display_name: string;
  email: string;
}

export interface UserGroupData {
  id: string;
  name: string;
  description: string | null;
  users: UserBrief[];
  created_at: string;
}

export interface Ref {
  id: string;
  name: string;
}

export interface AccessPolicyData {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  actions: ServerAction[];
  accounts: string[];
  labels: string[];
  users: Ref[];
  groups: Ref[];
  servers: Ref[];
  nodes: Ref[];
  created_at: string;
}

export interface ServerAccess {
  server_id: string;
  server_name: string;
  actions: string[];
  accounts: string[];
  policies: string[];
}

export interface AccessKeyData {
  id: string;
  name: string;
  prefix: string;
  user_id: string;
  user_name: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  is_active: boolean;
}

export interface AccessKeyCreated extends AccessKeyData {
  token: string;
}

export const ACTION_LABELS: Record<string, string> = {
  connect: "Connexion",
  execute: "Exécution",
  copy: "Copier",
  paste: "Coller",
  "*": "Tout",
};

export const VIRTUAL_ACCOUNT_HELP: Record<VirtualAccount, string> = {
  "@ALL": "Tous les comptes du serveur",
  "@USER": "Compte au nom de l'utilisateur (certificat éphémère, Linux)",
  "@INPUT": "Identifiants saisis à la connexion",
};

export function hasAction(server: Pick<ServerData, "actions">, action: ServerAction): boolean {
  return server.actions?.includes(action) ?? false;
}

export function errorMessage(e: unknown, fallback = "Erreur inconnue"): string {
  return e instanceof Error ? e.message : fallback;
}
