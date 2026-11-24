import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, History, KeyRound, Laptop, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, handleDeviceRevoked } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  type AccessKeyCreated,
  type AccessKeyData,
  type DeviceData,
  type LoginEventPage,
  type ServerAccess,
} from "@/services/types";
import { DevicesTable, LoginEventsTable, RevokeDeviceText } from "@/components/identityUi";
import { AccessTable } from "@/pages/Access";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  SaveButton,
  formatDate,
  iconBtnDanger,
} from "@/components/kit";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrateur",
  operator: "Opérateur",
  viewer: "Lecteur",
};

function keyState(k: AccessKeyData): { label: string; tone: "green" | "default" | "amber" } {
  if (!k.is_active) return { label: "Révoquée", tone: "default" };
  if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return { label: "Expirée", tone: "amber" };
  return { label: "Active", tone: "green" };
}

function CreateKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (k: AccessKeyCreated) => void;
}) {
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setLoading(true);
    setError(null);
    try {
      const k = await api.post<AccessKeyCreated>("/api/access-keys", {
        name: name.trim(),
        expires_in_days: days === "never" ? null : parseInt(days),
      });
      onCreated(k);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Nouvelle clé API"
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={create} loading={loading} disabled={!name.trim()}>
            Créer la clé
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom *" hint="Pour reconnaître la clé (script, outil, poste...).">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="script-inventaire"
          className="font-mono"
          autoFocus
        />
      </Field>
      <Field label="Expiration">
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 jours</SelectItem>
            <SelectItem value="30">30 jours</SelectItem>
            <SelectItem value="90">90 jours (recommandé)</SelectItem>
            <SelectItem value="180">180 jours</SelectItem>
            <SelectItem value="365">1 an</SelectItem>
            <SelectItem value="never">Jamais (déconseillé)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <p className="text-xs text-muted-foreground">
        La clé hérite de vos droits actuels. Elle ne peut pas créer d'autres clés.
      </p>
    </Modal>
  );
}

function TokenOnceModal({ created, onClose }: { created: AccessKeyCreated; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (non-secure context): the user can still select the text
    }
  };
  return (
    <Modal
      title={`Clé ${created.name} créée`}
      onClose={onClose}
      size="lg"
      footer={
        <Button onClick={onClose}>J'ai copié la clé</Button>
      }
    >
      <div className="flex gap-2 rounded-md border border-live/30 bg-live/10 px-3 py-2.5 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-live" />
        <div>
          <p className="font-medium text-live">Copiez cette clé maintenant.</p>
          <p className="mt-1 text-xs text-foreground">
            Elle ne sera plus jamais affichée : Citadel n'en conserve qu'une empreinte. Traitez-la
            comme un mot de passe et ne la partagez pas. Utilisation : en-tête{" "}
            <span className="font-mono">Authorization: Bearer &lt;clé&gt;</span>.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          readOnly
          value={created.token}
          onFocus={(e) => e.target.select()}
          className="font-mono text-xs"
        />
        <Button variant="outline" size="icon" className="shrink-0" onClick={copy} title="Copier la clé">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={copied ? "ok" : "copy"}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </motion.span>
          </AnimatePresence>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Expiration : {created.expires_at ? formatDate(created.expires_at) : "jamais"}
      </p>
    </Modal>
  );
}

function initials(name: string | undefined): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export default function MyAccount() {
  const { user, isAdmin } = useCurrentUser();
  const [access, setAccess] = useState<ServerAccess[] | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [keys, setKeys] = useState<AccessKeyData[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [allUsers, setAllUsers] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<AccessKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<AccessKeyData | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [devices, setDevices] = useState<DeviceData[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [revokingDevice, setRevokingDevice] = useState<DeviceData | null>(null);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [logins, setLogins] = useState<LoginEventPage | null>(null);
  const [loginsError, setLoginsError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ServerAccess[]>("/api/me/access")
      .then(setAccess)
      .catch((e) => setAccessError(errorMessage(e)));
  }, []);

  const loadKeys = useCallback(() => {
    setKeysLoading(true);
    api
      .get<AccessKeyData[]>(`/api/access-keys${allUsers ? "?all_users=true" : ""}`)
      .then((k) => {
        setKeys(k);
        setKeysError(null);
      })
      .catch((e) => setKeysError(errorMessage(e)))
      .finally(() => setKeysLoading(false));
  }, [allUsers]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const loadDevices = useCallback(() => {
    setDevicesLoading(true);
    api
      .get<DeviceData[]>("/api/me/devices")
      .then((d) => {
        setDevices(d);
        setDevicesError(null);
      })
      .catch((e) => setDevicesError(errorMessage(e)))
      .finally(() => setDevicesLoading(false));
  }, []);

  useEffect(() => {
    loadDevices();
    api
      .get<LoginEventPage>("/api/login-events?limit=20")
      .then(setLogins)
      .catch((e) => setLoginsError(errorMessage(e)));
  }, [loadDevices]);

  const revokeDevice = async () => {
    const d = revokingDevice;
    if (!d) return;
    setDeviceLoading(true);
    try {
      await api.post(`/api/me/devices/${d.id}/revoke`, {});
      if (d.current) {
        // This very browser: sign out now rather than on the next API call
        handleDeviceRevoked();
        return;
      }
      toast.success(`${d.label} déconnecté`);
      loadDevices();
      if (d.kind === "access_key") loadKeys();
    } catch (e) {
      setDevicesError(errorMessage(e));
    } finally {
      setDeviceLoading(false);
      setRevokingDevice(null);
    }
  };

  const revoke = async () => {
    const k = revoking;
    if (!k) return;
    setRevokeLoading(true);
    try {
      await api.delete(`/api/access-keys/${k.id}`);
      toast.success(`Clé ${k.name} révoquée`);
      loadKeys();
    } catch (e) {
      setKeysError(errorMessage(e));
    } finally {
      setRevokeLoading(false);
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mon compte"
        description="Votre profil, vos accès, vos appareils, vos connexions et vos clés API."
      />

      {/* Profile */}
      <Card className="flex items-center gap-4 p-4">
        <Avatar className="size-10">
          <AvatarFallback className="bg-muted text-sm font-medium">{initials(user?.display_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          {user ? (
            <>
              <p className="truncate font-medium">{user.display_name}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
            </>
          ) : (
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3.5 w-56" />
            </div>
          )}
        </div>
        {user && <Chip tone={user.role === "admin" ? "amber" : "primary"}>{ROLE_LABELS[user.role] || user.role}</Chip>}
      </Card>

      {/* My access */}
      <Card className="overflow-hidden">
        <CardHeader className="space-y-1 border-b p-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-muted-foreground" /> Mes accès
          </CardTitle>
          <CardDescription className="text-xs">
            Serveurs auxquels vous avez accès, avec les comptes et actions accordés par les règles d'accès.
          </CardDescription>
        </CardHeader>
        {accessError && (
          <div className="p-4">
            <ErrorBox message={accessError} />
          </div>
        )}
        {access === null && !accessError && (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        )}
        {access && <AccessTable rows={access} />}
      </Card>

      {/* API keys */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="space-y-1">
            <h3 className="flex items-center gap-2 text-base font-semibold leading-none">
              <KeyRound className="size-4 text-muted-foreground" /> Clés API
            </h3>
            <p className="text-xs text-muted-foreground">
              Jetons personnels pour l'API Citadel (scripts, intégrations). Ils héritent de vos droits.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={allUsers} onCheckedChange={(v) => setAllUsers(v === true)} />
                Toutes les clés
              </label>
            )}
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus /> Nouvelle clé
            </Button>
          </div>
        </div>
        {keysError && (
          <div className="p-4 pb-0">
            <ErrorBox message={keysError} />
          </div>
        )}
        {keysLoading && keys.length === 0 ? (
          <div className="space-y-3 p-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={KeyRound}
              title="Aucune clé API"
              action={
                <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
                  <Plus /> Créer une clé
                </Button>
              }
            >
              Créez une clé pour appeler l'API Citadel depuis un script ou un outil.
            </EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-3">Nom</TableHead>
                <TableHead className="px-3">Préfixe</TableHead>
                {allUsers && <TableHead className="px-3">Utilisateur</TableHead>}
                <TableHead className="px-3">Statut</TableHead>
                <TableHead className="px-3">Créée</TableHead>
                <TableHead className="px-3">Expire</TableHead>
                <TableHead className="px-3">Dernière utilisation</TableHead>
                <TableHead className="px-3">
                  <span className="sr-only">Gestion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={cn(keysLoading && "opacity-60")}>
              {keys.map((k) => {
                const st = keyState(k);
                return (
                  <TableRow key={k.id} className={k.is_active ? "" : "text-muted-foreground"}>
                    <TableCell className="px-3 font-medium">{k.name}</TableCell>
                    <TableCell className="px-3 font-mono text-xs">ctk_{k.prefix}_...</TableCell>
                    {allUsers && <TableCell className="px-3 text-xs">{k.user_name}</TableCell>}
                    <TableCell className="px-3">
                      <Chip tone={st.tone}>{st.label}</Chip>
                    </TableCell>
                    <TableCell className="tabular px-3 text-xs text-muted-foreground">{formatDate(k.created_at)}</TableCell>
                    <TableCell className="tabular px-3 text-xs text-muted-foreground">
                      {k.expires_at ? formatDate(k.expires_at) : "jamais"}
                    </TableCell>
                    <TableCell className="tabular px-3 text-xs text-muted-foreground">
                      {formatDate(k.last_used_at)}
                    </TableCell>
                    <TableCell className="px-3 py-1.5 text-right">
                      {k.is_active && (
                        <button onClick={() => setRevoking(k)} className={iconBtnDanger} title="Révoquer la clé">
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Devices */}
      <Card className="overflow-hidden">
        <CardHeader className="space-y-1 border-b p-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Laptop className="size-4 text-muted-foreground" /> Appareils
          </CardTitle>
          <CardDescription className="text-xs">
            Navigateurs et clés API qui ont utilisé votre compte. Déconnectez ceux que vous ne reconnaissez pas.
          </CardDescription>
        </CardHeader>
        {devicesError && (
          <div className="p-4 pb-0">
            <ErrorBox message={devicesError} />
          </div>
        )}
        {!devicesLoading && devices.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Aucun appareil enregistré.</p>
        ) : (
          <DevicesTable devices={devices} loading={devicesLoading} showUser={false} onRevoke={setRevokingDevice} />
        )}
      </Card>

      {/* Recent sign-ins */}
      <Card className="overflow-hidden">
        <CardHeader className="space-y-1 border-b p-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4 text-muted-foreground" /> Mes connexions
          </CardTitle>
          <CardDescription className="text-xs">
            Vos 20 dernières connexions à Citadel, réussies ou refusées.
          </CardDescription>
        </CardHeader>
        {loginsError && (
          <div className="p-4 pb-0">
            <ErrorBox message={loginsError} />
          </div>
        )}
        {logins && logins.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Aucune connexion enregistrée.</p>
        ) : (
          !loginsError && <LoginEventsTable items={logins?.items || []} loading={logins === null} showUser={false} />
        )}
      </Card>

      {revokingDevice && (
        <ConfirmModal
          title={`Déconnecter ${revokingDevice.label}`}
          confirmLabel="Déconnecter"
          danger
          loading={deviceLoading}
          onConfirm={revokeDevice}
          onClose={() => setRevokingDevice(null)}
        >
          <RevokeDeviceText device={revokingDevice} own />
        </ConfirmModal>
      )}

      {showCreate && (
        <CreateKeyModal
          onClose={() => setShowCreate(false)}
          onCreated={(k) => {
            setShowCreate(false);
            setCreated(k);
            loadKeys();
          }}
        />
      )}
      {created && <TokenOnceModal created={created} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmModal
          title={`Révoquer la clé ${revoking.name}`}
          confirmLabel="Révoquer la clé"
          danger
          loading={revokeLoading}
          onConfirm={revoke}
          onClose={() => setRevoking(null)}
        >
          <p>
            La clé <span className="font-mono text-foreground">ctk_{revoking.prefix}_...</span> cessera de fonctionner
            immédiatement. Les outils qui l'utilisent perdront l'accès.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}
