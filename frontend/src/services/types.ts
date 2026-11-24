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

// ── Governance (lot 3): ACLs, approvals, notifications ──────

export interface TimeWindow {
  /** 0 = Monday ... 6 = Sunday. */
  days: number[];
  /** "HH:MM"; an end before the start spans midnight. */
  start: string;
  end: string;
}

export type RuleScope = "login" | "connect";
export type ConnectRuleAction = "allow" | "deny" | "review";
export type CommandRuleAction = "allow" | "deny" | "alert" | "review";

interface RuleReadBase {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  is_active: boolean;
  users: Ref[];
  groups: Ref[];
  servers: Ref[];
  nodes: Ref[];
  labels: string[];
  accounts: string[];
  approver_groups: Ref[];
  created_at: string;
}

export interface ConnectionRuleData extends RuleReadBase {
  scope: RuleScope;
  action: ConnectRuleAction;
  source_ips: string[];
  time_windows: TimeWindow[];
}

export interface CommandRuleData extends RuleReadBase {
  action: CommandRuleAction;
  patterns: string[];
}

interface RuleTargetsIn {
  name: string;
  description: string | null;
  priority: number;
  is_active: boolean;
  user_ids: string[];
  group_ids: string[];
  server_ids: string[];
  node_ids: string[];
  labels: string[];
  accounts: string[];
  approver_group_ids: string[];
}

export interface ConnectionRuleIn extends RuleTargetsIn {
  scope: RuleScope;
  action: ConnectRuleAction;
  source_ips: string[];
  time_windows: TimeWindow[];
}

export interface CommandRuleIn extends RuleTargetsIn {
  action: CommandRuleAction;
  patterns: string[];
}

export interface CommandTestIn {
  command: string;
  server_id: string;
  user_id?: string | null;
  account?: string | null;
}

/** Result of the command dry run. */
export interface RuleDecision {
  action: CommandRuleAction;
  rule: string | null;
  reason: string | null;
}

export type ApprovalKind = "access" | "connect" | "command";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired" | "used";
export type ApprovalScope = "todo" | "mine" | "all";

/** Payload of an "access" request. */
export interface AccessRequestPayload {
  server_ids?: string[];
  node_ids?: string[];
  actions?: string[];
  accounts?: string[];
  duration_hours?: number;
}

export interface ApprovalData {
  id: string;
  number: number;
  kind: ApprovalKind;
  status: ApprovalStatus;
  requester: Ref;
  server: Ref | null;
  account_username: string | null;
  command: string | null;
  reason: string | null;
  payload: AccessRequestPayload;
  rule_name: string | null;
  decided_by: Ref | null;
  decided_at: string | null;
  decision_comment: string | null;
  /** Deadline for a decision. */
  expires_at: string;
  /** Validity of an approved request (connect / command grant, temporary access). */
  grant_until: string | null;
  used_at: string | null;
  policy_id: string | null;
  created_at: string;
  can_decide: boolean;
  /** Approvers other than the requester; 0 = nobody can approve. */
  approvers_available: number;
}

export interface AccessRequestIn {
  server_ids: string[];
  node_ids: string[];
  actions: ServerAction[];
  accounts: string[];
  duration_hours: number;
  reason: string;
}

export interface CountResponse {
  count: number;
}

export type NotificationLevel = "info" | "warning" | "critical";

export interface NotificationData {
  id: string;
  event: string;
  level: NotificationLevel;
  title: string;
  body: string | null;
  /** App path, e.g. "/approvals?id=<uuid>" or "/servers/<id>". */
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationEvent {
  event: string;
  label: string;
}

export type ChannelType = "email" | "teams" | "webhook";

export interface EmailChannelConfig {
  host?: string;
  port?: number;
  starttls?: boolean;
  username?: string;
  sender?: string;
  to?: string[];
  /** Also mail the users concerned by the event. */
  to_recipients?: boolean;
}

export interface NotificationChannelData {
  id: string;
  name: string;
  type: ChannelType;
  is_active: boolean;
  config: EmailChannelConfig & Record<string, unknown>;
  has_secret: boolean;
  /** Empty = all events. */
  events: string[];
  min_level: NotificationLevel;
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface NotificationChannelIn {
  name: string;
  type: ChannelType;
  is_active: boolean;
  config: EmailChannelConfig;
  /** Write-only; omitted on update = unchanged. */
  secret?: string;
  events: string[];
  min_level: NotificationLevel;
}

/** True when a backend refusal means "put under review" rather than a plain deny. */
export function isReviewMessage(msg: string | null | undefined): boolean {
  return !!msg && /soumise? à validation/i.test(msg);
}

// ── Audit (lot 4): live sessions, recordings, command journal, storage, SIEM ──

export type SessionProtocol = "ssh" | "rdp";

/** Active session from GET /api/live-sessions (timestamps are unix seconds). */
export interface LiveSession {
  session_id: string;
  protocol: SessionProtocol;
  user: string;
  user_id: string;
  server: string;
  server_id: string;
  account: string | null;
  client_ip: string | null;
  started_at: number;
  last_activity: number;
  watchers: string[];
  guac_connection_id?: string;
  width?: number;
  height?: number;
}

export interface KillSessionResult {
  delivered: boolean;
}

export interface MonitorTicket {
  ticket: string;
  expires_in: number;
  width: number | null;
  height: number | null;
}

/** Messages of the SSH monitoring WebSocket (/ws/monitor/{session_id}). */
export type MonitorMessage =
  | { type: "meta"; session: LiveSession }
  | { type: "output"; data: string }
  | { type: "ended" }
  | { type: "error"; message: string };

export type RecordingStorageType = "local" | "s3" | "azure";

export interface SessionRecordingData {
  id: string;
  session_id: string;
  server_id: string | null; // null when the server was deleted
  user_id: string;
  server_name: string;
  user_name: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  event_count: number;
  size_bytes: number;
  protocol: SessionProtocol;
  account: string | null;
  client_ip: string | null;
  storage_type: RecordingStorageType | null; // null = legacy, stored in database
  sha256: string | null;
  terminated_by: string | null;
  termination_reason: string | null;
}

export interface SessionEvent {
  t: number; // ms since start
  type: "o" | "i";
  data: string; // base64
}

export interface SessionRecordingDetail extends SessionRecordingData {
  events: SessionEvent[];
}

export interface RecordingVerifyResult {
  ok: boolean;
  message: string;
  storage?: RecordingStorageType | null;
}

export type CommandDecision = "allowed" | "alert" | "denied" | "review" | "approved_run";
export const COMMAND_DECISIONS: CommandDecision[] = ["allowed", "alert", "denied", "review", "approved_run"];
export type CommandSource = "terminal" | "execute";

export interface CommandLogEntry {
  id: string;
  session_id: string | null;
  user_id: string;
  user_name: string;
  server_id: string | null;
  server_name: string;
  account: string | null;
  command: string;
  source: CommandSource;
  decision: CommandDecision;
  rule: string | null;
  exit_code: number | null;
  offset_ms: number | null;
  ip_address: string | null;
  created_at: string;
}

export interface CommandLogPage {
  total: number;
  items: CommandLogEntry[];
}

export interface S3StorageConfig {
  endpoint?: string;
  bucket?: string;
  region?: string;
  access_key?: string;
  secure?: boolean;
  prefix?: string;
}

export interface AzureStorageConfig {
  container_url?: string;
  prefix?: string;
}

export interface RecordingStorageData {
  type: RecordingStorageType;
  config: S3StorageConfig & AzureStorageConfig;
  has_secret: boolean;
  last_error: string | null;
}

export interface RecordingStorageIn {
  type: RecordingStorageType;
  config: S3StorageConfig | AzureStorageConfig | Record<string, never>;
  secret?: string;
}

export interface StorageTestResult {
  ok: boolean;
  message: string;
  type: RecordingStorageType;
}

export type SiemTransport = "udp" | "tcp" | "tls" | "http";
export type SiemFormat = "json" | "cef" | "hec";
export type SiemStream = "audit" | "commands";

export interface SiemConfig {
  // syslog (udp / tcp / tls)
  host?: string;
  port?: number;
  // http
  url?: string;
  sourcetype?: string;
  index?: string;
  bearer?: boolean; // HEC: "Bearer" instead of "Splunk" auth scheme
  // tls / http
  verify_tls?: boolean;
}

export interface SiemTargetData {
  id: string;
  name: string;
  is_active: boolean;
  transport: SiemTransport;
  format: SiemFormat;
  config: SiemConfig;
  has_secret: boolean;
  streams: SiemStream[];
  cursors: Partial<Record<SiemStream, { ts: string; id: string }>>;
  sent_count: number;
  last_sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface SiemTargetIn {
  name: string;
  is_active: boolean;
  transport: SiemTransport;
  format: SiemFormat;
  config: SiemConfig;
  secret?: string;
  streams: SiemStream[];
  start_from?: "now" | "beginning"; // creation only
}
