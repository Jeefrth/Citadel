// Discovered OS accounts (collected on the targets): per-server block on the
// server page and global table in the "Accès" page.
import { useCallback, useEffect, useMemo, useState } from "react";
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
  Toggle,
  btnSecondary,
  formatDate,
  iconBtn,
  inputCls,
  type NoticeData,
} from "@/components/kit";
import { DISCOVERED_STATUS, formatLastLogin, formRotationBlocker } from "@/components/secretsUi";

/** Unmanaged privileged accounts still in use: the risky ones. */
export function isRisky(d: DiscoveredAccountData): boolean {
  return d.privileged && !d.managed && d.status !== "ignored";
}

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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
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
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={mode === "credential"} onChange={() => setMode("credential")} />
            Credential enregistré
          </label>
          {mode === "credential" && (
            <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} className={inputCls}>
              <option value="">Choisir un credential</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.username}, {c.type})
                </option>
              ))}
            </select>
          )}
          <label className={`flex items-center gap-2 text-sm ${certAllowed ? "" : "opacity-50"}`}>
            <input
              type="radio"
              disabled={!certAllowed}
              checked={mode === "cert"}
              onChange={() => setMode("cert")}
            />
            Certificat éphémère (CA Citadel, Linux uniquement)
          </label>
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={privileged}
          onChange={(e) => setPrivileged(e.target.checked)}
          className="w-4 h-4 rounded"
        />
        Compte privilégié
        {item.privileged && <span className="text-xs text-muted-foreground">(détecté comme administrateur)</span>}
      </label>
      <div>
        <Toggle
          checked={rotation && !blocker}
          onChange={setRotation}
          disabled={!!blocker}
          title={blocker || undefined}
          label="Rotation automatique du mot de passe"
        />
        <p className="text-xs text-muted-foreground mt-1">
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {showServer && <th className="text-left p-3 font-medium">Serveur</th>}
            <th className="text-left p-3 font-medium">Compte</th>
            <th className="text-left p-3 font-medium">Shell / SID</th>
            <th className="text-left p-3 font-medium">Activé</th>
            <th className="text-left p-3 font-medium">Dernière connexion</th>
            <th className="text-left p-3 font-medium">Statut</th>
            <th className="text-right p-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const risky = isRisky(d);
            const st = DISCOVERED_STATUS[d.status] || DISCOVERED_STATUS.new;
            const busy = busyId === d.id;
            return (
              <tr
                key={d.id}
                className={`border-b last:border-0 ${risky ? "bg-red-50/60" : ""} ${
                  d.status === "ignored" ? "opacity-60" : ""
                }`}
                title={risky ? "Compte privilégié non géré par Citadel" : undefined}
              >
                {showServer && (
                  <td className="p-3">
                    <Link to={`/servers/${d.server_id}`} className="text-primary hover:underline">
                      {d.server_name || d.server_id.slice(0, 8)}
                    </Link>
                  </td>
                )}
                <td className="p-3">
                  <div className="flex flex-wrap items-center gap-1">
                    {risky && <ShieldAlert size={14} className="text-red-600" />}
                    <span className="font-mono">{d.username}</span>
                    {d.privileged && (
                      <Chip tone={risky ? "red" : "amber"}>
                        <ShieldAlert size={11} /> privilégié
                      </Chip>
                    )}
                    {d.managed && <Chip tone="green">géré</Chip>}
                  </div>
                </td>
                <td className="p-3 font-mono text-xs text-muted-foreground" title={d.uid ? `uid / SID : ${d.uid}` : undefined}>
                  {d.shell || d.uid || "-"}
                </td>
                <td className="p-3 text-xs">
                  {d.enabled === null ? "-" : d.enabled ? "Oui" : <span className="text-muted-foreground">Non</span>}
                </td>
                <td className="p-3 text-xs text-muted-foreground">{formatLastLogin(d.last_login)}</td>
                <td className="p-3">
                  <Chip
                    tone={st.tone}
                    title={`${st.help}\nVu pour la première fois le ${formatDate(d.first_seen)}\nVu pour la dernière fois le ${formatDate(d.last_seen)}`}
                  >
                    {st.label}
                  </Chip>
                </td>
                <td className="p-3 text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    {busy && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
                    {!d.managed && d.status !== "gone" && (
                      <button onClick={() => onManage(d)} disabled={busy} className={iconBtn} title="Gérer">
                        <UserPlus size={15} />
                      </button>
                    )}
                    {d.status === "ignored" ? (
                      <button
                        onClick={() => onSetStatus(d, "new")}
                        disabled={busy}
                        className={iconBtn}
                        title="Restaurer"
                      >
                        <Undo2 size={15} />
                      </button>
                    ) : (
                      !d.managed && (
                        <button
                          onClick={() => onSetStatus(d, "ignored")}
                          disabled={busy}
                          className={iconBtn}
                          title="Ignorer"
                        >
                          <EyeOff size={15} />
                        </button>
                      )
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
    <div className="bg-card border rounded-lg mt-6">
      <div className="flex items-center justify-between p-4 border-b gap-4">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Radar size={16} /> Comptes découverts
            {risky > 0 && (
              <Chip tone="red" title="Comptes privilégiés présents sur le serveur mais non gérés par Citadel">
                <ShieldAlert size={11} /> {risky} privilégié{risky > 1 ? "s" : ""} non géré{risky > 1 ? "s" : ""}
              </Chip>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Comptes interactifs relevés sur le serveur (via le compte par défaut). Les comptes privilégiés
            non gérés sont à traiter en priorité : les gérer, ou les ignorer s'ils sont légitimes.
          </p>
        </div>
        <button onClick={collect} disabled={collecting} className={`${btnSecondary} shrink-0`}>
          {collecting ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />}
          Lancer la collecte
        </button>
      </div>
      {(notice || d.error) && (
        <div className="p-4 pb-0 space-y-2">
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <ErrorBox message={d.error} />
        </div>
      )}
      {d.loading ? (
        <p className="p-4 text-sm text-muted-foreground">Chargement...</p>
      ) : d.rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Aucun compte découvert. Lancez la collecte (elle est aussi faite périodiquement par le planificateur).
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
            <div className="p-3 border-t">
              <button
                onClick={() => setShowIgnored((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                {showIgnored ? <EyeOff size={12} /> : <Eye size={12} />}
                {showIgnored ? "Masquer" : "Afficher"} les comptes ignorés ({ignoredCount})
              </button>
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
    </div>
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
      <div className="p-3 rounded-md border bg-muted/30 text-xs text-muted-foreground">
        Comptes relevés sur les serveurs par la collecte (manuelle depuis la fiche serveur, ou périodique).
        Un compte <strong>privilégié non géré</strong> échappe au contrôle de Citadel : gérez-le pour que
        son secret soit dans le coffre et puisse tourner, ou ignorez-le s'il est légitime.
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as "" | DiscoveredStatus)}
          className={`${inputCls} max-w-[12rem]`}
        >
          <option value="">Tous les statuts</option>
          <option value="new">Nouveaux</option>
          <option value="ignored">Ignorés</option>
          <option value="gone">Disparus</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unmanagedOnly}
            onChange={(e) => setUnmanagedOnly(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          Non gérés seulement
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={riskyOnly}
            onChange={(e) => setRiskyOnly(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          Privilégiés non gérés seulement
        </label>
        {d.loading && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
        {riskyCount > 0 && (
          <Chip tone="red">
            <ShieldAlert size={11} /> {riskyCount} privilégié{riskyCount > 1 ? "s" : ""} non géré
            {riskyCount > 1 ? "s" : ""}
          </Chip>
        )}
      </div>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={d.error} />
      {!d.loading && rows.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center">
          <Radar size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Aucun compte découvert pour ces filtres.</p>
        </div>
      ) : (
        rows.length > 0 && (
          <div className="bg-card border rounded-lg overflow-hidden">
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
