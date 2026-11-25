// Shared API types (mirror backend/app/schemas)

export type OSType = "linux" | "windows";
export type ServerAction = "connect" | "execute" | "copy" | "paste" | "upload" | "download";
export const ALL_ACTIONS: ServerAction[] = ["connect", "execute", "copy", "paste", "upload", "download"];
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
  /** Network zone reached through SSH gateways; null = direct. */
  zone_id: string | null;
  zone_name: string | null;
  /** "azure:/subscriptions/..." for servers imported from a cloud account. */
  cloud_ref: string | null;
  cloud_state: "present" | "missing" | null;
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
  /** Lot 7: custom role and resulting permissions (an admin has them all). */
  custom_role_id?: string | null;
  custom_role_name?: string | null;
  permissions?: string[];
  /** SaaS phase 1 (/api/auth/me only): role and permissions above are those in `org`. */
  is_platform_admin?: boolean;
  org?: OrgBrief | null;
  orgs?: OrgBrief[];
  /** Invitations waiting for this person's consent (Mon compte > Invitations). */
  pending_invitations?: number;
}

export type BaseRole = "admin" | "operator" | "viewer";

/** Organisation the user can switch to; role null = platform admin without membership (acts as admin). */
export interface OrgBrief {
  id: string;
  name: string;
  slug: string;
  is_default: boolean;
  role: BaseRole | null;
}

/** /api/platform/orgs row (platform admin). */
export interface PlatformOrg {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  is_default: boolean;
  has_own_key: boolean;
  has_own_ca: boolean;
  created_at: string;
  members: number;
}

/** /api/orgs/mine row. */
export interface MyOrg extends PlatformOrg {
  role: BaseRole | null;
  current: boolean;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: BaseRole;
  created_at: string;
}

/** /api/me/invitations row: an organisation inviting the signed-in person. */
export interface MyInvitation {
  id: string;
  org: { id: string; name: string; slug: string };
  role: BaseRole;
  created_at: string;
}

export interface MyInvitationAnswer {
  accepted: boolean;
  org: { id: string; name: string; slug: string };
}

export interface OrgInviteResult {
  /** Always "invited" since invitations need the invitee's consent. */
  status: "invited";
  email: string;
  role: BaseRole;
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
  upload: "Envoyer des fichiers",
  download: "Télécharger des fichiers",
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

/** "k8s": shell in a Kubernetes container, recorded and replayed like SSH. */
export type SessionProtocol = "ssh" | "rdp" | "k8s";

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
  /** web | ssh-proxy | k8s; for "k8s", server_id is the cluster id. */
  channel?: string;
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
export type CommandSource = "terminal" | "execute" | "job" | "playbook";

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

// ── Operations (lot 5): files, jobs, playbooks, zones, cloud ──────

export type FileEntryType = "file" | "dir" | "link" | "other";

export interface FileEntry {
  name: string;
  path: string;
  type: FileEntryType;
  size: number | null;
  /** "-rw-r--r--" */
  mode: string;
  /** Unix seconds. */
  mtime: number | null;
  owner: string | null;
  group: string | null;
}

export interface FileListing {
  /** Resolved absolute path. */
  path: string;
  account: string;
  can_upload: boolean;
  can_download: boolean;
  entries: FileEntry[];
}

export interface UploadResult {
  path: string;
  size: number;
  sha256: string;
}

export interface JobSelector {
  server_ids: string[];
  node_ids: string[];
  labels: string[];
  account?: string | null;
}

export interface TargetPreview {
  server_id: string;
  server_name: string;
  ip_address: string;
  os_type: OSType;
  allowed: boolean;
  reason: string | null;
}

export type JobKind = "command" | "playbook" | "push";
export type JobStatus = "pending" | "running" | "success" | "partial" | "failed" | "cancelled";
export type JobTargetStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

export interface JobData {
  id: string;
  kind: JobKind;
  name: string;
  command: string | null;
  playbook_id: string | null;
  selector: JobSelector;
  parallelism: number;
  timeout: number;
  status: JobStatus;
  user_id: string;
  user_name?: string | null;
  extra_vars?: Record<string, unknown>;
  counts: Partial<Record<JobTargetStatus, number>>;
  target_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobTarget {
  id: string;
  server_id: string | null;
  server_name: string;
  account: string | null;
  status: JobTargetStatus;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobDetail extends JobData {
  output: string | null;
  targets: JobTarget[];
}

export interface PlaybookData {
  id: string;
  name: string;
  description: string | null;
  content: string;
  variables: Record<string, unknown>;
  created_at: string;
}

export interface GatewayData {
  id: string;
  zone_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credential_id: string | null;
  credential_name: string | null;
  use_cert: boolean;
  priority: number;
  is_active: boolean;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_check_message: string | null;
}

export interface ZoneData {
  id: string;
  name: string;
  description: string | null;
  server_count: number;
  gateways: GatewayData[];
  created_at: string;
}

export interface AzureConfig {
  tenant_id: string;
  client_id: string;
  subscription_ids: string[];
  use_public_ip: boolean;
  only_running: boolean;
}

export interface CloudAccountData {
  id: string;
  name: string;
  provider: "azure";
  config: Partial<AzureConfig>;
  has_secret: boolean;
  node_id: string | null;
  zone_id: string | null;
  is_active: boolean;
  sync_interval_minutes: number;
  last_sync_at: string | null;
  last_sync_status: "ok" | "error" | null;
  last_sync_message: string | null;
  /** New VMs wait in "À valider" instead of being imported. */
  review_new: boolean;
  created_at: string;
}

export interface CloudSyncResult {
  /** created / updated / missing / skipped / pending / new_pending; "error" (message) when the sync failed. */
  stats: Record<string, number | string>;
  account: CloudAccountData;
}

// ── Lot 6: cloud review queue ───────────────────────────

export type CloudPendingStatus = "pending" | "ignored";

export interface CloudPendingVM {
  id: string;
  cloud_account_id: string;
  cloud_ref: string;
  name: string;
  computer_name: string | null;
  ip_address: string | null;
  os_type: string | null;
  resource_group: string | null;
  location: string | null;
  power_state: string | null;
  tags: Record<string, string>;
  status: CloudPendingStatus;
  first_seen: string;
  last_seen: string;
}

export interface CloudPendingDecision {
  done: number;
  errors: string[];
}

// ── Lot 6: sign-ins, devices, reports, policy import ─────

export type DeviceKind = "web" | "access_key";

export interface DeviceData {
  id: string;
  user_id: string;
  user_name: string;
  kind: DeviceKind;
  label: string;
  ip_address: string | null;
  first_seen: string;
  last_seen: string;
  revoked_at: string | null;
  revoked_by: string | null;
  current: boolean;
}

export type LoginMethod = "entra" | "access_key";
export type LoginResult = "success" | "denied";

export interface LoginEventData {
  id: string;
  user_id: string | null;
  user_name: string;
  method: LoginMethod;
  result: LoginResult;
  reason: string | null;
  ip_address: string | null;
  device: string | null;
  created_at: string;
}

export interface LoginEventPage {
  total: number;
  items: LoginEventData[];
}

export type ReportKind = "users" | "servers" | "accounts";
export type ReportValue = string | number | boolean | null;

export interface ReportData {
  kind: ReportKind;
  title: string;
  from: string;
  to: string;
  generated_at: string;
  generated_by: string;
  rows: Record<string, ReportValue>[];
}

export interface PolicyImportReport {
  dry_run: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  errors: { name: string; problems: string[] }[];
}

// ── Lot 7: SSH proxy, account templates, backups, applications, risks, roles, masking ──

export interface SshProxyInfo {
  enabled: boolean;
  host: string;
  port: number;
  login: string;
  host_key_fingerprint: string | null;
  example: string;
  example_direct: string;
}

export interface SshKeyData {
  id: string;
  name: string;
  fingerprint: string;
  algorithm: string;
  created_at: string;
  last_used_at: string | null;
}

export interface SshTokenData {
  id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

export interface SshTokenCreated {
  token: string;
  expires_at: string;
}

export type TemplateOsScope = "any" | "linux" | "windows";
export type TemplateSecretType = "password" | "ssh_key" | "cert";
export type TemplateSudo = "none" | "password" | "nopasswd";

export interface AccountTemplateInput {
  name: string;
  description: string | null;
  username: string;
  os_scope: TemplateOsScope;
  secret_type: TemplateSecretType;
  password_length: number;
  privileged: boolean;
  sudo: TemplateSudo;
  groups: string[];
  rotation_enabled: boolean;
  rotation_interval_days: number;
}

export interface AccountTemplateData extends AccountTemplateInput {
  id: string;
  created_at: string;
}

export type BackupDestination = "download" | "storage" | "email";
export type BackupStatus = "success" | "partial" | "failed" | "running";

export interface BackupEntry {
  id: string;
  created_at: string;
  trigger: string;
  destinations: string[];
  status: BackupStatus;
  message: string | null;
  accounts: number | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_type?: string | null;
  storage_key: string | null;
}

export interface BackupState {
  has_passphrase: boolean;
  history: BackupEntry[];
}

export interface ApplicationInput {
  name: string;
  description: string | null;
  is_active: boolean;
  expires_in_days: number | null;
  allowed_ips: string[];
  server_ids: string[];
  node_ids: string[];
  labels: string[];
  accounts: string[];
}

export interface ApplicationData {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  is_active: boolean;
  expires_at: string | null;
  allowed_ips: string[];
  server_ids: string[];
  node_ids: string[];
  labels: string[];
  accounts: string[];
  last_used_at: string | null;
  last_used_ip: string | null;
  created_at: string;
}

export interface ApplicationCreated extends ApplicationData {
  key: string;
}

export type RiskSeverity = "high" | "medium" | "low";
export type RiskStatus = "open" | "ignored" | "resolved";

export interface RiskItem {
  id: string;
  key?: string;
  category: string;
  severity: RiskSeverity;
  title: string;
  detail: string | null;
  link: string | null;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  ignored: boolean;
  ignored_by: string | null;
  ignored_reason: string | null;
}

export interface RiskList {
  last_scan: string | null;
  counts: Partial<Record<RiskSeverity, number>>;
  items: RiskItem[];
}

export interface CustomRoleData {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  members: number;
  created_at: string;
}

export interface MaskingRule {
  name: string;
  pattern: string;
  replacement: string;
  enabled: boolean;
}

export interface MaskingPreset {
  name: string;
  pattern: string;
  replacement: string;
}

export interface MaskingTestResult {
  result: string;
  hits: number;
}

// ── Sign-in providers and Citadel sessions (SaaS phase 3) ──────

export type ProviderKind = "entra" | "google" | "okta" | "oidc";

/** Public view of a provider (sign-in buttons, discovery, linkable). */
export interface AuthProvider {
  id: string;
  name: string;
  kind: ProviderKind | string;
}

export interface AuthIdentity {
  id: string;
  provider: AuthProvider | null;
  email: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface AuthSessionData {
  id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  ip_address: string | null;
  device: string | null;
  current: boolean;
}

/** Identity provider as administered (organisation SSO or platform button). */
export interface IdentityProviderData {
  id: string;
  kind: ProviderKind;
  name: string;
  issuer: string;
  client_id: string;
  has_secret: boolean;
  scopes: string;
  domains: string[];
  jit_role: BaseRole | null;
  enforced: boolean;
  is_active: boolean;
  created_at: string;
  redirect_uri: string;
}

export interface IdentityProviderInput {
  kind: ProviderKind;
  name: string;
  issuer: string;
  client_id: string;
  /** Write-only: null keeps the current secret. */
  client_secret: string | null;
  scopes: string;
  domains: string[];
  jit_role: BaseRole | null;
  enforced: boolean;
  is_active: boolean;
}
