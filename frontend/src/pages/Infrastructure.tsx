// Admin: network zones with their SSH gateways (A4) and Azure cloud accounts (A8).
import { useCallback, useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  Cloud,
  CloudCog,
  Download,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2,
  Undo2,
  UserPlus,
  X,
} from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  type CloudAccountData,
  type CloudPendingDecision,
  type CloudPendingStatus,
  type CloudPendingVM,
  type CloudSyncResult,
  type CredentialData,
  type GatewayData,
  type NodeData,
  type OperationMessage,
  type ZoneData,
} from "@/services/types";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  Notice,
  PageHeader,
  SaveButton,
  Tabs,
  Toggle,
  LabelChips,
  formatDate,
  type NoticeData,
} from "@/components/kit";
import { RowsSkeleton, SettingsCard, StatusDot, TableSkeleton, Tip } from "@/components/auditUi";
import { AuthModePicker, RowAction } from "@/components/AccountsSection";
import AccountTemplatesPanel from "@/components/AccountTemplates";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Tab = "zones" | "azure" | "pending" | "templates";

export default function Infrastructure() {
  // Zones, Azure, VM: permission "servers"; account templates: "secrets"
  const { can, loading: userLoading } = useCurrentUser();
  const isAdmin = can("servers");
  const canTemplates = can("secrets");
  const [params, setParams] = useSearchParams();
  const tabs: Tab[] = [...(isAdmin ? (["zones", "azure", "pending"] as Tab[]) : []), ...(canTemplates ? (["templates"] as Tab[]) : [])];
  const tab: Tab = tabs.find((t) => t === params.get("tab")) ?? tabs[0] ?? "zones";
  const [zones, setZones] = useState<ZoneData[] | null>(null);
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [credentials, setCredentials] = useState<CredentialData[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadZones = useCallback(() => {
    api
      .get<ZoneData[]>("/api/zones")
      .then((z) => {
        setZones(z);
        setError(null);
      })
      .catch((e) => {
        setZones((z) => z ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadZones();
    api.get<NodeData[]>("/api/nodes").then(setNodes).catch(() => {});
    api.get<CredentialData[]>("/api/servers/credentials/").then(setCredentials).catch(() => {});
  }, [isAdmin, loadZones]);

  if (userLoading) return null;
  if (!isAdmin && !canTemplates) return <Navigate to="/" replace />;

  return (
    <div>
      <PageHeader
        title="Infrastructure"
        description="Passerelles SSH vers les réseaux isolés, import automatique des machines virtuelles Azure et modèles de comptes à pousser sur les serveurs."
      />
      <Tabs
        tabs={[
          ...(isAdmin
            ? [
                { id: "zones" as Tab, label: "Zones et passerelles", icon: Route },
                { id: "azure" as Tab, label: "Azure", icon: Cloud },
                { id: "pending" as Tab, label: "VM à valider", icon: CloudCog },
              ]
            : []),
          ...(canTemplates ? [{ id: "templates" as Tab, label: "Modèles de comptes", icon: UserPlus }] : []),
        ]}
        active={tab}
        onChange={(t) => setParams(t === tabs[0] ? {} : { tab: t }, { replace: true })}
      />
      <ErrorBox message={error} />
      {tab === "zones" && <ZonesPanel zones={zones} credentials={credentials} onChanged={loadZones} />}
      {tab === "azure" && (
        <AzurePanel nodes={nodes} zones={zones || []} onShowPending={() => setParams({ tab: "pending" }, { replace: true })} />
      )}
      {tab === "pending" && <PendingPanel />}
      {tab === "templates" && <AccountTemplatesPanel />}
    </div>
  );
}

// ── Zones & gateways ──────────────────────────────────────

function ZonesPanel({
  zones,
  credentials,
  onChanged,
}: {
  zones: ZoneData[] | null;
  credentials: CredentialData[];
  onChanged: () => void;
}) {
  const [editZone, setEditZone] = useState<ZoneData | null | undefined>(undefined);
  const [removeZone, setRemoveZone] = useState<ZoneData | null>(null);
  const [editGw, setEditGw] = useState<{ zone: ZoneData; gateway: GatewayData | null } | null>(null);
  const [removeGw, setRemoveGw] = useState<GatewayData | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<Record<string, OperationMessage>>({});
  const [notice, setNotice] = useState<NoticeData | null>(null);

  const check = async (g: GatewayData) => {
    setChecking(g.id);
    try {
      const r = await api.post<OperationMessage>(`/api/gateways/${g.id}/check`, {});
      setCheckResult((m) => ({ ...m, [g.id]: r }));
      onChanged();
    } catch (e) {
      setCheckResult((m) => ({ ...m, [g.id]: { ok: false, message: errorMessage(e) } }));
    } finally {
      setChecking(null);
    }
  };

  const doRemoveZone = async (z: ZoneData) => {
    setDeleting(true);
    try {
      await api.delete(`/api/zones/${z.id}`);
      toast.success(`Zone ${z.name} supprimée`);
      setRemoveZone(null);
      onChanged();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
      setRemoveZone(null);
    } finally {
      setDeleting(false);
    }
  };

  const doRemoveGw = async (g: GatewayData) => {
    setDeleting(true);
    try {
      await api.delete(`/api/gateways/${g.id}`);
      toast.success(`Passerelle ${g.name} supprimée`);
      setRemoveGw(null);
      onChanged();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
      setRemoveGw(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Une zone regroupe des serveurs joignables seulement par rebond SSH. Ses passerelles sont essayées par priorité
          croissante. Côté passerelle, <span className="font-mono">AllowTcpForwarding yes</span> est requis.
        </p>
        <Button onClick={() => setEditZone(null)}>
          <Plus /> Ajouter une zone
        </Button>
      </div>
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {!zones ? (
        <SettingsCard title="Zones">
          <RowsSkeleton />
        </SettingsCard>
      ) : zones.length === 0 ? (
        <EmptyState
          icon={Route}
          title="Aucune zone"
          action={
            <Button variant="outline" onClick={() => setEditZone(null)}>
              <Plus /> Ajouter une zone
            </Button>
          }
        >
          Sans zone, Citadel joint chaque serveur directement. Créez une zone pour un réseau isolé, puis ajoutez-y une
          passerelle SSH.
        </EmptyState>
      ) : (
        <AnimatePresence initial={false}>
          {zones.map((z) => (
            <motion.div
              key={z.id}
              layout="position"
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <SettingsCard
                title={z.name}
                icon={Route}
                description={
                  <>
                    {z.description && <span className="mr-1">{z.description}</span>}
                    <span className="tabular">
                      {z.server_count} serveur{z.server_count > 1 ? "s" : ""}, {z.gateways.length} passerelle
                      {z.gateways.length > 1 ? "s" : ""}
                    </span>
                  </>
                }
                actions={
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditGw({ zone: z, gateway: null })}>
                      <Plus /> Ajouter une passerelle
                    </Button>
                    <RowAction label="Modifier la zone" onClick={() => setEditZone(z)}>
                      <Pencil />
                    </RowAction>
                    <RowAction label="Supprimer la zone" danger onClick={() => setRemoveZone(z)}>
                      <Trash2 />
                    </RowAction>
                  </>
                }
              >
                {z.gateways.length === 0 ? (
                  <p className="text-sm text-live">
                    Aucune passerelle : les serveurs de cette zone sont injoignables. Ajoutez une passerelle.
                  </p>
                ) : (
                  <div className="-mx-5 -my-4">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="pl-5">Passerelle</TableHead>
                          <TableHead>Adresse</TableHead>
                          <TableHead>Compte</TableHead>
                          <TableHead className="text-right">Priorité</TableHead>
                          <TableHead>Dernier test</TableHead>
                          <TableHead className="pr-5 text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...z.gateways]
                          .sort((a, b) => a.priority - b.priority)
                          .map((g) => {
                            const res = checkResult[g.id];
                            const ok = res ? res.ok : g.last_check_ok;
                            const msg = res ? res.message : g.last_check_message;
                            return (
                              <TableRow key={g.id} className={cn("h-11", !g.is_active && "opacity-60")}>
                                <TableCell className="pl-5">
                                  <span className="flex items-center gap-2">
                                    <StatusDot
                                      tone={ok === null || ok === undefined ? "muted" : ok ? "success" : "danger"}
                                      label={ok === null || ok === undefined ? "Jamais testée" : ok ? "Joignable" : "En échec"}
                                    />
                                    <span className="font-medium">{g.name}</span>
                                    {!g.is_active && <Chip>inactive</Chip>}
                                  </span>
                                </TableCell>
                                <TableCell className="tabular font-mono text-xs">
                                  {g.host}:{g.port}
                                </TableCell>
                                <TableCell className="text-xs">
                                  <span className="font-mono">{g.username}</span>{" "}
                                  <span className="text-muted-foreground">
                                    {g.use_cert ? (
                                      <span className="inline-flex items-center gap-1">
                                        <ShieldCheck className="size-3.5 text-info" /> certificat
                                      </span>
                                    ) : (
                                      `(${g.credential_name ?? "credential"})`
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell className="tabular text-right text-xs">{g.priority}</TableCell>
                                <TableCell className="max-w-xs text-xs">
                                  <AnimatePresence mode="popLayout" initial={false}>
                                    <motion.div
                                      key={`${ok}-${msg}`}
                                      initial={{ opacity: 0, y: -4 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0 }}
                                      transition={{ duration: 0.18 }}
                                    >
                                      {msg ? (
                                        <Tip content={msg}>
                                          <p className={cn("truncate", ok === false ? "text-danger" : "text-muted-foreground")}>
                                            {msg}
                                          </p>
                                        </Tip>
                                      ) : (
                                        <p className="text-muted-foreground">Jamais testée</p>
                                      )}
                                      {g.last_check_at && !res && (
                                        <p className="tabular text-muted-foreground">{formatDate(g.last_check_at)}</p>
                                      )}
                                    </motion.div>
                                  </AnimatePresence>
                                </TableCell>
                                <TableCell className="pr-5 text-right">
                                  <div className="flex items-center justify-end gap-0.5">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 text-muted-foreground"
                                      onClick={() => check(g)}
                                      disabled={checking === g.id}
                                    >
                                      {checking === g.id ? <Loader2 className="animate-spin" /> : <PlugZap />}
                                      Tester
                                    </Button>
                                    <RowAction label="Modifier" onClick={() => setEditGw({ zone: z, gateway: g })}>
                                      <Pencil />
                                    </RowAction>
                                    <RowAction label="Supprimer" danger onClick={() => setRemoveGw(g)}>
                                      <Trash2 />
                                    </RowAction>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </SettingsCard>
            </motion.div>
          ))}
        </AnimatePresence>
      )}

      {editZone !== undefined && (
        <ZoneModal
          zone={editZone}
          onClose={() => setEditZone(undefined)}
          onSaved={() => {
            setEditZone(undefined);
            onChanged();
          }}
        />
      )}
      {editGw && (
        <GatewayModal
          zone={editGw.zone}
          gateway={editGw.gateway}
          credentials={credentials}
          onClose={() => setEditGw(null)}
          onSaved={() => {
            setEditGw(null);
            onChanged();
          }}
        />
      )}
      {removeZone && (
        <ConfirmModal
          title={`Supprimer la zone ${removeZone.name}`}
          confirmLabel="Supprimer"
          danger
          loading={deleting}
          onClose={() => setRemoveZone(null)}
          onConfirm={() => doRemoveZone(removeZone)}
        >
          <p>Ses passerelles sont supprimées avec elle.</p>
          {removeZone.server_count > 0 && (
            <p>
              <strong className="tabular">
                {removeZone.server_count} serveur{removeZone.server_count > 1 ? "s" : ""}
              </strong>{" "}
              repasse{removeZone.server_count > 1 ? "nt" : ""} en accès direct et risque
              {removeZone.server_count > 1 ? "nt" : ""} de devenir injoignable{removeZone.server_count > 1 ? "s" : ""}.
            </p>
          )}
        </ConfirmModal>
      )}
      {removeGw && (
        <ConfirmModal
          title={`Supprimer la passerelle ${removeGw.name}`}
          confirmLabel="Supprimer"
          danger
          loading={deleting}
          onClose={() => setRemoveGw(null)}
          onConfirm={() => doRemoveGw(removeGw)}
        >
          <p>
            Les sessions passeront par les autres passerelles de la zone. Sans autre passerelle, les serveurs de la zone
            deviennent injoignables.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

function ZoneModal({ zone, onClose, onSaved }: { zone: ZoneData | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(zone?.name || "");
  const [description, setDescription] = useState(zone?.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), description: description.trim() || null };
    try {
      if (zone) await api.patch(`/api/zones/${zone.id}`, body);
      else await api.post("/api/zones", body);
      toast.success(zone ? "Zone enregistrée" : "Zone créée");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <Modal
      title={zone ? `Modifier la zone ${zone.name}` : "Ajouter une zone"}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={saving} disabled={!name.trim()}>
            Enregistrer la zone
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DMZ Genève" autoFocus />
      </Field>
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </Field>
    </Modal>
  );
}

function GatewayModal({
  zone,
  gateway,
  credentials,
  onClose,
  onSaved,
}: {
  zone: ZoneData;
  gateway: GatewayData | null;
  credentials: CredentialData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(gateway?.name || "");
  const [host, setHost] = useState(gateway?.host || "");
  const [port, setPort] = useState(gateway?.port ?? 22);
  const [username, setUsername] = useState(gateway?.username || "");
  const [mode, setMode] = useState<"credential" | "cert">(gateway?.use_cert ? "cert" : "credential");
  const [credentialId, setCredentialId] = useState(gateway?.credential_id || "");
  const [priority, setPriority] = useState(gateway?.priority ?? 10);
  const [isActive, setIsActive] = useState(gateway?.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    name.trim() && host.trim() && username.trim() && port >= 1 && port <= 65535 && (mode === "cert" || credentialId);

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      credential_id: mode === "credential" ? credentialId : null,
      use_cert: mode === "cert",
      priority,
      is_active: isActive,
    };
    try {
      if (gateway) await api.patch(`/api/gateways/${gateway.id}`, body);
      else await api.post(`/api/zones/${zone.id}/gateways`, body);
      toast.success(gateway ? "Passerelle enregistrée" : "Passerelle ajoutée");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={gateway ? `Modifier la passerelle ${gateway.name}` : "Ajouter une passerelle"}
      description={`Zone ${zone.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={saving} disabled={!valid}>
            Enregistrer la passerelle
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-3">
          <Field label="Nom">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rebond DMZ 1" autoFocus />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Hôte">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.20.0.5" className="font-mono" />
          </Field>
        </div>
        <Field label="Port SSH">
          <Input
            type="number"
            value={port}
            onChange={(e) => setPort(parseInt(e.target.value) || 22)}
            className="tabular font-mono"
          />
        </Field>
        <div className="col-span-2">
          <Field label="Compte">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="citadel" className="font-mono" />
          </Field>
        </div>
        <Field label="Priorité" hint="La plus basse d'abord.">
          <Input
            type="number"
            min={0}
            max={1000}
            value={priority}
            onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
            className="tabular font-mono"
          />
        </Field>
      </div>
      <Field label="Authentification">
        <AuthModePicker
          mode={mode}
          onMode={setMode}
          certAllowed
          credentialId={credentialId}
          onCredential={setCredentialId}
          credentials={credentials}
        />
      </Field>
      <Toggle checked={isActive} onChange={setIsActive} label="Passerelle active" />
    </Modal>
  );
}

// ── Azure ─────────────────────────────────────────────────

const STAT_LABELS: Record<string, [string, string]> = {
  created: ["ajoutée", "ajoutées"],
  updated: ["mise à jour", "mises à jour"],
  missing: ["disparue", "disparues"],
  skipped: ["ignorée", "ignorées"],
  pending: ["en attente de validation", "en attente de validation"],
  new_pending: ["nouvelle à valider", "nouvelles à valider"],
};

/** Only shown when the account reviews new VMs (always 0 otherwise). */
const REVIEW_STATS = new Set(["pending", "new_pending"]);

function statsText(stats: Record<string, number | string>): string {
  return Object.entries(stats)
    .filter(([k, v]) => k !== "error" && !(REVIEW_STATS.has(k) && Number(v) === 0))
    .map(([k, v]) => {
      const n = Number(v);
      const l = STAT_LABELS[k];
      return l ? `${n} ${n > 1 ? l[1] : l[0]}` : `${k} ${v}`;
    })
    .join(", ");
}

function AzurePanel({
  nodes,
  zones,
  onShowPending,
}: {
  nodes: NodeData[];
  zones: ZoneData[];
  onShowPending: () => void;
}) {
  const [accounts, setAccounts] = useState<CloudAccountData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [editing, setEditing] = useState<CloudAccountData | null | undefined>(undefined);
  const [removing, setRemoving] = useState<CloudAccountData | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<CloudAccountData[]>("/api/cloud-accounts")
      .then((a) => {
        setAccounts(a);
        setError(null);
      })
      .catch((e) => {
        setAccounts((a) => a ?? []);
        setError(errorMessage(e));
      });
  }, []);
  useEffect(load, [load]);

  const nodePath = (id: string | null) => (id ? nodes.find((n) => n.id === id)?.path ?? "?" : "Racine");
  const zoneName = (id: string | null) => (id ? zones.find((z) => z.id === id)?.name ?? "?" : null);

  const sync = async (a: CloudAccountData) => {
    setSyncing(a.id);
    setNotice(null);
    try {
      const r = await api.post<CloudSyncResult>(`/api/cloud-accounts/${a.id}/sync`, {});
      setAccounts((list) => list?.map((x) => (x.id === a.id ? r.account : x)) ?? list);
      if (r.account.last_sync_status === "error" || "error" in r.stats) {
        setNotice({
          ok: false,
          text: (
            <>
              Synchronisation de <strong>{a.name}</strong> en échec : {String(r.stats.error ?? r.account.last_sync_message)}
            </>
          ),
        });
      } else {
        setNotice({
          ok: true,
          text: (
            <>
              <strong>{a.name}</strong> synchronisé : {statsText(r.stats)}.
              {Number(r.stats.pending) > 0 && (
                <>
                  {" "}
                  <button type="button" onClick={onShowPending} className="font-medium underline underline-offset-4">
                    Voir les VM à valider
                  </button>
                </>
              )}
            </>
          ),
        });
      }
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setSyncing(null);
    }
  };

  const remove = async (a: CloudAccountData) => {
    setDeleting(true);
    try {
      await api.delete(`/api/cloud-accounts/${a.id}`);
      toast.success(`Compte ${a.name} supprimé`);
      setRemoving(null);
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
      setRemoving(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1 text-sm text-muted-foreground">
          <p>
            Citadel lit vos VM Azure avec un principal de service doté du rôle <strong className="text-foreground">Lecteur</strong>{" "}
            sur les abonnements. Chaque VM devient un serveur sous le nœud choisi, dans un sous-nœud par groupe de
            ressources.
          </p>
          <p>
            Une VM supprimée côté Azure est marquée « disparue », jamais supprimée. Les serveurs importés n'ont pas de
            compte : ajoutez-en un depuis leur fiche.
          </p>
        </div>
        <Button onClick={() => setEditing(null)}>
          <Plus /> Ajouter un compte Azure
        </Button>
      </div>
      <ErrorBox message={error} />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {accounts && accounts.length === 0 && !error ? (
        <EmptyState
          icon={Cloud}
          title="Aucun compte Azure"
          action={
            <Button variant="outline" onClick={() => setEditing(null)}>
              <Plus /> Ajouter un compte Azure
            </Button>
          }
        >
          Ajoutez un principal de service pour importer et suivre vos VM automatiquement.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Compte</TableHead>
                <TableHead>Abonnements</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Dernière synchronisation</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!accounts ? (
                <TableSkeleton rows={2} cols={5} />
              ) : (
                accounts.map((a) => {
                  const subs = a.config.subscription_ids || [];
                  const zone = zoneName(a.zone_id);
                  return (
                    <TableRow key={a.id} className={cn("align-top", !a.is_active && "opacity-60")}>
                      <TableCell className="pl-4">
                        <span className="flex items-center gap-2">
                          <StatusDot
                            tone={a.last_sync_status === "ok" ? "success" : a.last_sync_status === "error" ? "danger" : "muted"}
                            label={a.last_sync_status === "ok" ? "Synchronisé" : a.last_sync_status === "error" ? "En échec" : "Jamais synchronisé"}
                          />
                          <span className="font-medium">{a.name}</span>
                          {!a.is_active && <Chip>inactif</Chip>}
                        </span>
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                          tenant {a.config.tenant_id?.slice(0, 8)}…
                        </p>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Tip content={subs.length ? <span className="font-mono">{subs.join("\n")}</span> : null}>
                          <span className="tabular">
                            {subs.length} abonnement{subs.length > 1 ? "s" : ""}
                          </span>
                        </Tip>
                        <p className="text-muted-foreground">
                          {a.config.use_public_ip ? "IP publique" : "IP privée"}
                          {a.config.only_running && ", VM démarrées"}
                          {a.review_new && ", revue des nouvelles VM"}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs">
                        <p>{nodePath(a.node_id)}</p>
                        <p className="text-muted-foreground">{zone ? `Zone ${zone}` : "Accès direct"}</p>
                      </TableCell>
                      <TableCell className="max-w-sm text-xs">
                        <p className="tabular">
                          {a.last_sync_at ? formatDate(a.last_sync_at) : "Jamais"}
                          <span className="text-muted-foreground"> · toutes les {a.sync_interval_minutes} min</span>
                        </p>
                        {a.last_sync_message && (
                          <p className={cn("break-words", a.last_sync_status === "error" ? "text-danger" : "text-muted-foreground")}>
                            {a.last_sync_message}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-muted-foreground"
                            onClick={() => sync(a)}
                            disabled={syncing === a.id}
                          >
                            {syncing === a.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            Synchroniser maintenant
                          </Button>
                          <RowAction label="Modifier" onClick={() => setEditing(a)}>
                            <Pencil />
                          </RowAction>
                          <RowAction label="Supprimer" danger onClick={() => setRemoving(a)}>
                            <Trash2 />
                          </RowAction>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {editing !== undefined && (
        <CloudAccountModal
          account={editing}
          nodes={nodes}
          zones={zones}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
      {removing && (
        <ConfirmModal
          title={`Supprimer le compte ${removing.name}`}
          confirmLabel="Supprimer"
          danger
          loading={deleting}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        >
          <p>La synchronisation s'arrête. Les serveurs déjà importés restent dans Citadel.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

const ROOT = "__root__";
const DIRECT = "__direct__";

function CloudAccountModal({
  account,
  nodes,
  zones,
  onClose,
  onSaved,
}: {
  account: CloudAccountData | null;
  nodes: NodeData[];
  zones: ZoneData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const cfg = account?.config || {};
  const [name, setName] = useState(account?.name || "");
  const [tenantId, setTenantId] = useState(cfg.tenant_id || "");
  const [clientId, setClientId] = useState(cfg.client_id || "");
  const [secret, setSecret] = useState("");
  const [subs, setSubs] = useState<string[]>(cfg.subscription_ids || []);
  const [subInput, setSubInput] = useState("");
  const [usePublicIp, setUsePublicIp] = useState(!!cfg.use_public_ip);
  const [onlyRunning, setOnlyRunning] = useState(!!cfg.only_running);
  const [nodeId, setNodeId] = useState(account?.node_id || "");
  const [zoneId, setZoneId] = useState(account?.zone_id || "");
  const [isActive, setIsActive] = useState(account?.is_active ?? true);
  const [interval, setIntervalMinutes] = useState(account?.sync_interval_minutes ?? 60);
  const [reviewNew, setReviewNew] = useState(account?.review_new ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addSubs = () => {
    // Accept a pasted list (spaces, commas or new lines)
    const items = subInput
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!items.length) return;
    setSubs((s) => Array.from(new Set([...s, ...items])));
    setSubInput("");
  };

  const valid =
    name.trim() &&
    tenantId.trim() &&
    clientId.trim() &&
    subs.length > 0 &&
    (account ? true : secret !== "") &&
    interval >= 5 &&
    interval <= 10080;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      provider: "azure",
      config: {
        tenant_id: tenantId.trim(),
        client_id: clientId.trim(),
        subscription_ids: subs,
        use_public_ip: usePublicIp,
        only_running: onlyRunning,
      },
      ...(secret ? { secret } : {}),
      node_id: nodeId || null,
      zone_id: zoneId || null,
      is_active: isActive,
      sync_interval_minutes: interval,
      review_new: reviewNew,
    };
    try {
      if (account) await api.patch(`/api/cloud-accounts/${account.id}`, body);
      else await api.post("/api/cloud-accounts", body);
      toast.success(account ? "Compte Azure enregistré" : "Compte Azure ajouté");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={account ? `Modifier ${account.name}` : "Ajouter un compte Azure"}
      description="Principal de service avec le rôle Lecteur sur les abonnements à importer."
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={saving} disabled={!valid}>
            Enregistrer le compte
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Azure production" autoFocus />
      </Field>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Identifiant du tenant">
          <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label="Identifiant du client (application)">
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-xs" />
        </Field>
      </div>
      <Field
        label="Secret client"
        hint={account?.has_secret ? "Laissez vide pour garder le secret enregistré." : "Chiffré dans le coffre, jamais réaffiché."}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={account?.has_secret ? "Secret enregistré" : ""}
          className="font-mono"
        />
      </Field>
      <Field label="Abonnements" hint="Collez un ou plusieurs identifiants d'abonnement, puis Entrée.">
        <div className="mb-2 flex min-h-6 flex-wrap gap-1">
          {subs.length === 0 && <span className="text-xs text-muted-foreground">Aucun abonnement</span>}
          <AnimatePresence initial={false}>
            {subs.map((s) => (
              <motion.span key={s} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
                <Chip onRemove={() => setSubs((x) => x.filter((y) => y !== s))}>
                  <span className="font-mono">{s}</span>
                </Chip>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
        <div className="flex gap-2">
          <Input
            value={subInput}
            onChange={(e) => setSubInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSubs();
              }
            }}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="font-mono text-xs"
          />
          <Button type="button" variant="outline" size="icon" onClick={addSubs} disabled={!subInput.trim()} title="Ajouter">
            <Plus />
          </Button>
          {subs.length > 0 && (
            <Button type="button" variant="ghost" size="icon" onClick={() => setSubs([])} title="Tout retirer">
              <X />
            </Button>
          )}
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nœud de destination" hint="Un sous-nœud est créé par groupe de ressources.">
          <Select value={nodeId || ROOT} onValueChange={(v) => setNodeId(v === ROOT ? "" : v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT}>Racine (aucun nœud)</SelectItem>
              {nodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Zone réseau" hint="Appliquée aux nouveaux serveurs importés.">
          <Select value={zoneId || DIRECT} onValueChange={(v) => setZoneId(v === DIRECT ? "" : v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DIRECT}>Aucune (accès direct)</SelectItem>
              {zones.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Synchronisation (minutes)" hint="De 5 à 10080.">
          <Input
            type="number"
            min={5}
            max={10080}
            value={interval}
            onChange={(e) => setIntervalMinutes(parseInt(e.target.value) || 60)}
            className="tabular font-mono"
          />
        </Field>
      </div>
      <div className="space-y-2">
        <Toggle checked={usePublicIp} onChange={setUsePublicIp} label="Utiliser l'IP publique des VM (sinon l'IP privée)" />
        <Toggle checked={onlyRunning} onChange={setOnlyRunning} label="Importer seulement les VM démarrées" />
        <Toggle checked={isActive} onChange={setIsActive} label="Synchronisation automatique active" />
        <Toggle checked={reviewNew} onChange={setReviewNew} label="Revue des nouvelles VM" />
        <p className="pl-11 text-xs text-muted-foreground">
          Une nouvelle VM n'est pas importée : elle attend dans « VM à valider » et les admins sont prévenus.
        </p>
      </div>
    </Modal>
  );
}

// ── Cloud review queue ────────────────────────────────────

type PendingAction = "import" | "ignore" | "restore";

const PENDING_DONE: Record<PendingAction, [string, string]> = {
  import: ["VM importée", "VM importées"],
  ignore: ["VM ignorée", "VM ignorées"],
  restore: ["VM remise à valider", "VM remises à valider"],
};

const POWER_LABELS: Record<string, string> = {
  running: "Démarrée",
  stopped: "Arrêtée",
  deallocated: "Désallouée",
  starting: "Démarrage",
  stopping: "Arrêt en cours",
  deallocating: "Désallocation",
};

function PendingPanel() {
  const [status, setStatus] = useState<CloudPendingStatus>("pending");
  const [rows, setRows] = useState<CloudPendingVM[] | null>(null);
  const [accounts, setAccounts] = useState<CloudAccountData[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);

  const load = useCallback(() => {
    api
      .get<CloudPendingVM[]>(`/api/cloud-pending?status=${status}`)
      .then((r) => {
        setRows(r);
        setError(null);
        // Keep only the selected VMs still in the list
        setSelected((sel) => new Set([...sel].filter((id) => r.some((x) => x.id === id))));
      })
      .catch((e) => {
        setRows((r) => r ?? []);
        setError(errorMessage(e));
      });
  }, [status]);

  useEffect(load, [load]);
  useEffect(() => {
    api.get<CloudAccountData[]>("/api/cloud-accounts").then(setAccounts).catch(() => {});
  }, []);

  const switchStatus = (s: CloudPendingStatus) => {
    setStatus(s);
    setRows(null);
    setSelected(new Set());
  };

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "?";
  const list = rows ?? [];
  const allSelected = list.length > 0 && list.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const decide = async (action: PendingAction) => {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(action);
    setNotice(null);
    try {
      const r = await api.post<CloudPendingDecision>("/api/cloud-pending/decide", { ids, action });
      const label = PENDING_DONE[action][r.done > 1 ? 1 : 0];
      if (r.errors.length) {
        setNotice({
          ok: false,
          text: (
            <>
              {r.done > 0 && (
                <p>
                  {r.done} {label}.
                </p>
              )}
              <p>
                {r.errors.length} en erreur :
              </p>
              <ul className="list-disc pl-5">
                {r.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </>
          ),
        });
      } else {
        toast.success(`${r.done} ${label}`);
      }
      setSelected(new Set());
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nouvelles VM trouvées par les comptes Azure en « revue des nouvelles VM ». Importez celles qui doivent devenir
          des serveurs Citadel, ignorez les autres : une VM ignorée le reste aux synchronisations suivantes.
        </p>
        <Select value={status} onValueChange={(v) => switchStatus(v as CloudPendingStatus)}>
          <SelectTrigger className="h-8 w-auto min-w-40 gap-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">À valider</SelectItem>
            <SelectItem value="ignored">Ignorées</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ErrorBox message={error} />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <span className="tabular mr-auto">
            {selected.size} VM sélectionnée{selected.size > 1 ? "s" : ""}
          </span>
          <Button size="sm" onClick={() => decide("import")} disabled={busy !== null}>
            {busy === "import" ? <Loader2 className="animate-spin" /> : <Download />}
            Importer
          </Button>
          {status === "pending" ? (
            <Button variant="outline" size="sm" onClick={() => decide("ignore")} disabled={busy !== null}>
              {busy === "ignore" ? <Loader2 className="animate-spin" /> : <EyeOff />}
              Ignorer
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => decide("restore")} disabled={busy !== null}>
              {busy === "restore" ? <Loader2 className="animate-spin" /> : <Undo2 />}
              Remettre à valider
            </Button>
          )}
        </div>
      )}

      {rows && rows.length === 0 && !error ? (
        <EmptyState icon={CloudCog} title={status === "pending" ? "Aucune VM à valider" : "Aucune VM ignorée"}>
          {status === "pending"
            ? "Activez « Revue des nouvelles VM » sur un compte Azure pour valider chaque nouvelle VM avant son import."
            : "Les VM que vous ignorez apparaissent ici. Vous pourrez les remettre à valider."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(list.map((r) => r.id)) : new Set())}
                    aria-label="Tout sélectionner"
                    disabled={list.length === 0}
                  />
                </TableHead>
                <TableHead>VM</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Système</TableHead>
                <TableHead>Compte et groupe de ressources</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Étiquettes</TableHead>
                <TableHead className="pr-4">Détection</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!rows ? (
                <TableSkeleton rows={3} cols={8} />
              ) : (
                <AnimatePresence initial={false}>
                  {rows.map((r) => (
                    <motion.tr
                      key={r.id}
                      layout
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      data-state={selected.has(r.id) ? "selected" : undefined}
                      className="border-b align-top transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted"
                    >
                      <TableCell className="pl-4">
                        <Checkbox
                          checked={selected.has(r.id)}
                          onCheckedChange={() => toggle(r.id)}
                          aria-label={`Sélectionner ${r.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <p className="font-mono text-xs font-medium">{r.name}</p>
                        {r.computer_name && r.computer_name !== r.name && (
                          <p className="font-mono text-xs text-muted-foreground">{r.computer_name}</p>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{r.ip_address || "-"}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.os_type === "windows" ? "Windows" : r.os_type === "linux" ? "Linux" : r.os_type || "-"}
                      </TableCell>
                      <TableCell className="text-xs">
                        <p>{accountName(r.cloud_account_id)}</p>
                        <p className="font-mono text-muted-foreground">
                          {r.resource_group || "-"}
                          {r.location && ` · ${r.location}`}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.power_state ? (
                          <Chip tone={r.power_state === "running" ? "green" : "default"}>
                            {POWER_LABELS[r.power_state] ?? r.power_state}
                          </Chip>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <LabelChips tags={r.tags} />
                      </TableCell>
                      <TableCell className="tabular whitespace-nowrap pr-4 text-xs text-muted-foreground">
                        <p>première : {formatDate(r.first_seen)}</p>
                        <p>dernière : {formatDate(r.last_seen)}</p>
                      </TableCell>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
