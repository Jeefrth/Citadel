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
