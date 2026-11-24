// Discovered OS accounts (collected on the targets): per-server block on the
// server page and global table in the "Accès" page.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router-dom";
import { Eye, EyeOff, Loader2, Radar, ShieldAlert, Undo2, UserPlus } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type AccountData,
  type CredentialData,
  type DiscoveredAccountData,
  type DiscoveredStatus,
  type ManageDiscoveredBody,
  type OSType,
  type OperationMessage,
  type ServerData,
} from "@/services/types";
import {
  Chip,
  ErrorBox,
  Field,
  Modal,
  Notice,
  SaveButton,
  EmptyState,
  Toggle,
  formatDate,
  type NoticeData,
} from "@/components/kit";
import { AuthModePicker, CheckField, RowAction } from "@/components/AccountsSection";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { DISCOVERED_STATUS, formatLastLogin, formRotationBlocker } from "@/components/secretsUi";

/** Unmanaged privileged accounts still in use: the risky ones. */
export function isRisky(d: DiscoveredAccountData): boolean {
  return d.privileged && !d.managed && d.status !== "ignored";
}

const ALL_STATUSES = "__all__";

// ── Manage dialog ────────────────────────────────────────────

function ManageModal({
  item,
  osType,
  credentials,
  onClose,
  onManaged,
}: {
  item: DiscoveredAccountData;
  /** Unknown in some contexts: the certificate option is then left enabled. */
  osType: OSType | null;
  credentials: CredentialData[];
  onClose: () => void;
  onManaged: (account: AccountData) => void;
}) {
  const certAllowed = osType !== "windows";
  const [mode, setMode] = useState<"credential" | "cert">("credential");
  const [credentialId, setCredentialId] = useState("");
  const [privileged, setPrivileged] = useState(item.privileged);
  const [rotation, setRotation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocker = formRotationBlocker(mode === "cert", credentialId, credentials);
  const valid = mode === "cert" ? certAllowed : credentialId !== "";

  const save = async () => {
    setLoading(true);
    setError(null);
    const body: ManageDiscoveredBody = {
      credential_id: mode === "credential" ? credentialId : null,
      use_cert: mode === "cert",
      privileged,
      rotation_enabled: rotation && !blocker,
    };
    try {
      const acc = await api.post<AccountData>(`/api/discovered-accounts/${item.id}/manage`, body);
      onManaged(acc);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <>
          Gérer le compte <span className="font-mono">{item.username}</span>
          {item.server_name && <span className="text-muted-foreground font-normal"> sur {item.server_name}</span>}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            Gérer ce compte
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-xs text-muted-foreground">
        Le compte devient un compte Citadel du serveur. Choisissez le secret avec lequel Citadel s'y
        connecte ; les règles d'accès décident ensuite qui peut l'utiliser.
      </p>
      <Field label="Authentification">
        <AuthModePicker
          mode={mode}
          onMode={setMode}
          certAllowed={certAllowed}
          credentialId={credentialId}
          onCredential={setCredentialId}
          credentials={credentials}
        />
      </Field>
      <CheckField
        checked={privileged}
        onChange={setPrivileged}
        label={
          <>
            Compte privilégié
            {item.privileged && <span className="ml-1 text-xs text-muted-foreground">(détecté comme administrateur)</span>}
          </>
        }
      />
      <div>
        <Toggle
          checked={rotation && !blocker}
          onChange={setRotation}
          disabled={!!blocker}
          title={blocker || undefined}
          label="Rotation automatique du mot de passe"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {blocker
            ? blocker
            : "Tous les 30 jours par défaut (modifiable ensuite dans le compte). La première rotation a lieu au prochain passage du planificateur."}
        </p>
      </div>
    </Modal>
  );
}

// ── Table ────────────────────────────────────────────────────

function DiscoveredTable({
  rows,
  showServer,
  busyId,
  onManage,
  onSetStatus,
}: {
  rows: DiscoveredAccountData[];
  showServer: boolean;
  busyId: string | null;
  onManage: (d: DiscoveredAccountData) => void;
  onSetStatus: (d: DiscoveredAccountData, status: "new" | "ignored") => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {showServer && <TableHead className="pl-4">Serveur</TableHead>}
          <TableHead className={showServer ? undefined : "pl-4"}>Compte</TableHead>
          <TableHead>Shell / SID</TableHead>
          <TableHead>Activé</TableHead>
          <TableHead>Dernière connexion</TableHead>
          <TableHead>Statut</TableHead>
          <TableHead className="pr-4 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <AnimatePresence initial={false}>
          {rows.map((d) => {
            const risky = isRisky(d);
            const st = DISCOVERED_STATUS[d.status] || DISCOVERED_STATUS.new;
            const busy = busyId === d.id;
            return (
              <motion.tr
                key={d.id}
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: d.status === "ignored" ? 0.6 : 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className={cn("h-11 border-b transition-colors hover:bg-muted/50", risky && "bg-danger/5")}
                title={risky ? "Compte privilégié non géré par Citadel" : undefined}
              >
                {showServer && (
                  <TableCell className="pl-4">
                    <Link to={`/servers/${d.server_id}`} className="font-medium hover:underline">
                      {d.server_name || d.server_id.slice(0, 8)}
                    </Link>
                  </TableCell>
                )}
                <TableCell className={showServer ? undefined : "pl-4"}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {risky && <ShieldAlert className="size-3.5 text-danger" />}
                    <span className="font-mono">{d.username}</span>
                    {d.privileged && (
                      <Chip tone={risky ? "red" : "amber"}>
                        <ShieldAlert className="size-3" /> privilégié
                      </Chip>
                    )}
                    {d.managed && <Chip tone="green">géré</Chip>}
                  </div>
                </TableCell>
                <TableCell
                  className="font-mono text-xs text-muted-foreground"
                  title={d.uid ? `uid / SID : ${d.uid}` : undefined}
                >
                  {d.shell || d.uid || "-"}
                </TableCell>
                <TableCell className="text-xs">
                  {d.enabled === null ? "-" : d.enabled ? "Oui" : <span className="text-muted-foreground">Non</span>}
                </TableCell>
                <TableCell className="tabular text-xs text-muted-foreground">{formatLastLogin(d.last_login)}</TableCell>
                <TableCell>
                  <Chip
                    tone={st.tone}
                    title={`${st.help}\nVu pour la première fois le ${formatDate(d.first_seen)}\nVu pour la dernière fois le ${formatDate(d.last_seen)}`}
                  >
                    {st.label}
                  </Chip>
                </TableCell>
                <TableCell className="whitespace-nowrap pr-4 text-right">
                  <div className="flex items-center justify-end gap-0.5">
                    {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                    {!d.managed && d.status !== "gone" && (
                      <RowAction label="Gérer" onClick={() => onManage(d)} disabled={busy}>
                        <UserPlus />
                      </RowAction>
                    )}
                    {d.status === "ignored" ? (
                      <RowAction label="Restaurer" onClick={() => onSetStatus(d, "new")} disabled={busy}>
                        <Undo2 />
                      </RowAction>
                    ) : (
                      !d.managed && (
                        <RowAction label="Ignorer" onClick={() => onSetStatus(d, "ignored")} disabled={busy}>
                          <EyeOff />
                        </RowAction>
                      )
                    )}
                  </div>
                </TableCell>
              </motion.tr>
            );
          })}
        </AnimatePresence>
      </TableBody>
    </Table>
  );
}

/** Shared state + actions for both views. */
function useDiscovered(query: string) {
  const [rows, setRows] = useState<DiscoveredAccountData[]>([]);
  const [credentials, setCredentials] = useState<CredentialData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [managing, setManaging] = useState<DiscoveredAccountData | null>(null);

  const load = useCallback(() => {
    api
      .get<DiscoveredAccountData[]>(`/api/discovered-accounts${query}`)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<CredentialData[]>("/api/servers/credentials/").then(setCredentials).catch(() => {});
  }, []);

  const setStatus = async (d: DiscoveredAccountData, status: "new" | "ignored") => {
    setBusyId(d.id);
    try {
      const updated = await api.patch<DiscoveredAccountData>(`/api/discovered-accounts/${d.id}`, { status });
      setRows((prev) => prev.map((x) => (x.id === d.id ? updated : x)));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  return { rows, credentials, loading, error, setError, busyId, managing, setManaging, load, setStatus };
}

// ── Server page block ────────────────────────────────────────

export function DiscoveredAccountsSection({
  server,
  reloadKey,
  onManaged,
}: {
  server: ServerData;
  /** Bumped by the parent when the managed accounts changed. */
  reloadKey: number;
  onManaged: () => void;
}) {
  const d = useDiscovered(`?server_id=${server.id}`);
  const { load } = d;
  const [collecting, setCollecting] = useState(false);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);

  useEffect(() => {
    if (reloadKey > 0) load();
  }, [reloadKey, load]);

  const collect = async () => {
    setCollecting(true);
    setNotice(null);
    try {
      const r = await api.post<OperationMessage>(`/api/servers/${server.id}/discover-accounts`, {});
      setNotice({ ok: r.ok, text: r.message });
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setCollecting(false);
    }
  };

  const visible = showIgnored ? d.rows : d.rows.filter((r) => r.status !== "ignored");
  const ignoredCount = d.rows.length - d.rows.filter((r) => r.status !== "ignored").length;
  const risky = d.rows.filter(isRisky).length;

  return (
    <section className="mt-6 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <Radar className="size-4 text-muted-foreground" /> Comptes découverts
            {risky > 0 && (
              <Chip tone="red" title="Comptes privilégiés présents sur le serveur mais non gérés par Citadel">
                <ShieldAlert className="size-3" /> {risky} privilégié{risky > 1 ? "s" : ""} non géré{risky > 1 ? "s" : ""}
              </Chip>
            )}
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Comptes interactifs relevés sur le serveur (via le compte par défaut). Traitez d'abord les comptes
            privilégiés non gérés : gérez-les, ou ignorez-les s'ils sont légitimes.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={collect} disabled={collecting} className="shrink-0">
          {collecting ? <Loader2 className="animate-spin" /> : <Radar />}
          Lancer la collecte
        </Button>
      </div>
      {(notice || d.error) && (
        <div className="space-y-2 p-4 pb-0">
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <ErrorBox message={d.error} />
        </div>
      )}
      {d.loading ? (
        <div className="space-y-2 p-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : d.rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Aucun compte découvert. Lancez la collecte (le planificateur la refait aussi périodiquement).
        </p>
      ) : (
        <>
          <DiscoveredTable
            rows={visible}
            showServer={false}
            busyId={d.busyId}
            onManage={d.setManaging}
            onSetStatus={d.setStatus}
          />
          {ignoredCount > 0 && (
            <div className="border-t px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowIgnored((v) => !v)}
                className="-ml-2 h-7 text-xs text-muted-foreground"
              >
                {showIgnored ? <EyeOff /> : <Eye />}
                {showIgnored ? "Masquer" : "Afficher"} les comptes ignorés ({ignoredCount})
              </Button>
            </div>
          )}
        </>
      )}

      {d.managing && (
        <ManageModal
          item={{ ...d.managing, server_name: d.managing.server_name || server.name }}
          osType={server.os_type}
          credentials={d.credentials}
          onClose={() => d.setManaging(null)}
          onManaged={(acc) => {
            d.setManaging(null);
            setNotice({ ok: true, text: `Le compte ${acc.username} est désormais géré par Citadel.` });
            load();
            onManaged();
          }}
        />
      )}
    </section>
  );
}

// ── Global view (Accès page) ─────────────────────────────────

export function DiscoveredAccountsPanel({ servers }: { servers: ServerData[] }) {
  const [status, setStatus] = useState<"" | DiscoveredStatus>("new");
  const [unmanagedOnly, setUnmanagedOnly] = useState(true);
  const [riskyOnly, setRiskyOnly] = useState(false);
  const [notice, setNotice] = useState<NoticeData | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (unmanagedOnly) p.set("unmanaged_only", "true");
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [status, unmanagedOnly]);
  const d = useDiscovered(query);

  const osById = useMemo(() => new Map(servers.map((s) => [s.id, s.os_type])), [servers]);
  const riskyCount = d.rows.filter(isRisky).length;
  const rows = riskyOnly ? d.rows.filter(isRisky) : d.rows;

  return (
    <div className="space-y-4">
      <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        Comptes relevés sur les serveurs par la collecte (manuelle depuis la fiche serveur, ou périodique).
        Un compte <strong className="text-foreground">privilégié non géré</strong> échappe au contrôle de Citadel :
        gérez-le pour que son secret soit dans le coffre et puisse tourner, ou ignorez-le s'il est légitime.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Select value={status || ALL_STATUSES} onValueChange={(v) => setStatus(v === ALL_STATUSES ? "" : (v as DiscoveredStatus))}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUSES}>Tous les statuts</SelectItem>
            <SelectItem value="new">Nouveaux</SelectItem>
            <SelectItem value="ignored">Ignorés</SelectItem>
            <SelectItem value="gone">Disparus</SelectItem>
          </SelectContent>
        </Select>
        <CheckField checked={unmanagedOnly} onChange={setUnmanagedOnly} label="Non gérés seulement" />
        <CheckField checked={riskyOnly} onChange={setRiskyOnly} label="Privilégiés non gérés seulement" />
        {d.loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {riskyCount > 0 && (
          <Chip tone="red">
            <ShieldAlert className="size-3" /> {riskyCount} privilégié{riskyCount > 1 ? "s" : ""} non géré
            {riskyCount > 1 ? "s" : ""}
          </Chip>
        )}
      </div>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={d.error} />
      {!d.loading && rows.length === 0 ? (
        <EmptyState icon={Radar} title="Aucun compte découvert pour ces filtres">
          Élargissez les filtres, ou lancez une collecte depuis la fiche d'un serveur.
        </EmptyState>
      ) : (
        rows.length > 0 && (
          <div className="overflow-hidden rounded-lg border bg-card">
            <DiscoveredTable
              rows={rows}
              showServer
              busyId={d.busyId}
              onManage={d.setManaging}
              onSetStatus={d.setStatus}
            />
          </div>
        )
      )}

      {d.managing && (
        <ManageModal
          item={d.managing}
          osType={osById.get(d.managing.server_id) || null}
          credentials={d.credentials}
          onClose={() => d.setManaging(null)}
          onManaged={(acc) => {
            const srv = d.managing?.server_name;
            d.setManaging(null);
            setNotice({
              ok: true,
              text: `Le compte ${acc.username}${srv ? ` sur ${srv}` : ""} est désormais géré par Citadel.`,
            });
            d.load();
          }}
        />
      )}
    </div>
  );
}
