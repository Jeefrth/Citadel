import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import {
  CalendarClock,
  CheckCircle2,
  History,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  UserRound,
} from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type AccountData,
  type AccountOperationResult,
  type CredentialData,
  type SecretHistoryEntry,
  type ServerData,
} from "@/services/types";
import {
  Chip,
  ConfirmModal,
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  HISTORY_REASON,
  HISTORY_STATUS,
  VerifyBadge,
  blockerLabel,
  formRotationBlocker,
} from "@/components/secretsUi";

const AUTH_LABELS: Record<AccountData["auth"], string> = {
  password: "Mot de passe",
  ssh_key: "Clé SSH",
  cert: "Certificat éphémère",
  none: "Aucun secret",
};

interface AccountForm {
  username: string;
  mode: "credential" | "cert";
  credential_id: string;
  privileged: boolean;
  is_default: boolean;
  is_active: boolean;
  description: string;
  rotation_enabled: boolean;
  rotation_interval_days: string;
}

function AccountModal({
  server,
  account,
  credentials,
  onClose,
  onSaved,
}: {
  server: ServerData;
  account: AccountData | null;
  credentials: CredentialData[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isLinux = server.os_type === "linux";
  const [form, setForm] = useState<AccountForm>(() => ({
    username: account?.username || "",
    mode: account?.use_cert ? "cert" : "credential",
    credential_id: account?.credential_id || "",
    privileged: account?.privileged ?? false,
    is_default: account?.is_default ?? server.accounts_count === 0,
    is_active: account?.is_active ?? true,
    description: account?.description || "",
    rotation_enabled: account?.rotation_enabled ?? false,
    rotation_interval_days: String(account?.rotation_interval_days ?? 30),
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<AccountForm>) => setForm((f) => ({ ...f, ...p }));

  const blocker = formRotationBlocker(form.mode === "cert", form.credential_id, credentials, account);
  const interval = Number(form.rotation_interval_days);
  const intervalOk = Number.isInteger(interval) && interval >= 1 && interval <= 365;
  const rotationOn = form.rotation_enabled && !blocker;

  const valid =
    form.username.trim() !== "" &&
    (form.mode === "cert" ? isLinux : form.credential_id !== "") &&
    (!rotationOn || intervalOk);

  const save = async () => {
    setLoading(true);
    setError(null);
    const body: Record<string, unknown> = {
      username: form.username.trim(),
      credential_id: form.mode === "credential" ? form.credential_id : null,
      use_cert: form.mode === "cert",
      privileged: form.privileged,
      is_default: form.is_default,
      description: form.description || null,
    };
    // Rotation settings: only sent when they can apply, the backend refuses
    // rotation_enabled=true on an unsupported account.
    const rotation: Record<string, unknown> = { rotation_enabled: rotationOn };
    if (intervalOk) rotation.rotation_interval_days = interval;
    if (account) body.is_active = form.is_active;
    try {
      if (account) {
        await api.patch(`/api/servers/${server.id}/accounts/${account.id}`, { ...body, ...rotation });
      } else {
        // AccountCreate has no rotation fields: create, then patch when needed.
        const created = await api.post<AccountData>(`/api/servers/${server.id}/accounts`, body);
        if (rotationOn) await api.patch(`/api/servers/${server.id}/accounts/${created.id}`, rotation);
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={account ? `Modifier le compte ${account.username}` : "Nouveau compte"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {account ? "Enregistrer" : "Ajouter"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Utilisateur *" hint="Nom du compte sur le serveur cible.">
        <Input
          value={form.username}
          onChange={(e) => set({ username: e.target.value })}
          placeholder={isLinux ? "root" : "Administrator"}
          className="font-mono"
          autoFocus
        />
      </Field>
      <Field label="Authentification">
        <AuthModePicker
          mode={form.mode}
          onMode={(mode) => set({ mode })}
          certAllowed={isLinux}
          credentialId={form.credential_id}
          onCredential={(credential_id) => set({ credential_id })}
          credentials={credentials}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <CheckField checked={form.is_default} onChange={(v) => set({ is_default: v })} label="Compte par défaut" />
        <CheckField checked={form.privileged} onChange={(v) => set({ privileged: v })} label="Compte privilégié" />
        {account && <CheckField checked={form.is_active} onChange={(v) => set({ is_active: v })} label="Actif" />}
      </div>
      <Field label="Description">
        <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <div className="space-y-2 rounded-md border p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <RotateCw className="size-3.5 text-muted-foreground" /> Rotation du mot de passe
        </p>
        {blocker ? (
          <p className="text-xs text-muted-foreground">Non disponible : {blocker}.</p>
        ) : (
          <>
            <Toggle
              checked={form.rotation_enabled}
              onChange={(v) => set({ rotation_enabled: v })}
              label="Rotation automatique"
            />
            {form.rotation_enabled && (
              <div className="flex items-center gap-2 text-sm">
                <span>Tous les</span>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={form.rotation_interval_days}
                  onChange={(e) => set({ rotation_interval_days: e.target.value })}
                  className="tabular w-24"
                />
                <span>jours</span>
                {!intervalOk && <span className="text-xs text-danger">entre 1 et 365</span>}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Citadel change le mot de passe sur le serveur via son compte privilégié par défaut, puis
              conserve le nouveau dans le coffre. Un compte jamais tourné l'est au prochain passage du
              planificateur.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function HistoryModal({
  server,
  account,
  onClose,
}: {
  server: ServerData;
  account: AccountData;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<SecretHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SecretHistoryEntry[]>(`/api/servers/${server.id}/accounts/${account.id}/history`)
      .then(setRows)
      .catch((e) => setError(errorMessage(e)));
  }, [server.id, account.id]);

  return (
    <Modal
      title={
        <>
          Historique des secrets de <span className="font-mono">{account.username}</span>
        </>
      }
      onClose={onClose}
      size="2xl"
      footer={
        <Button variant="outline" onClick={onClose}>
          Fermer
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">
        Métadonnées uniquement : les secrets restent chiffrés dans le coffre et ne sont jamais affichés.
      </p>
      <ErrorBox message={error} />
      {!rows && !error && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}
      {rows && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune rotation pour ce compte. Le secret actuel est celui du credential d'origine.
        </p>
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Généré le</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Origine</TableHead>
                <TableHead>Activé le</TableHead>
                <TableHead>Erreur</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((h) => {
                const st = HISTORY_STATUS[h.status] || { label: h.status, tone: "default" as const };
                return (
                  <TableRow key={h.id} className="align-top">
                    <TableCell className="tabular whitespace-nowrap text-xs">{formatDate(h.created_at)}</TableCell>
                    <TableCell>
                      <Chip tone={st.tone}>{st.label}</Chip>
                    </TableCell>
                    <TableCell className="text-xs" title={h.actor_id ? `Utilisateur ${h.actor_id}` : undefined}>
                      {HISTORY_REASON[h.reason] || h.reason}
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap text-xs">{formatDate(h.activated_at)}</TableCell>
                    <TableCell className="break-words text-xs text-danger">{h.error}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Modal>
  );
}

/** Rotation summary shown under the account attributes. */
function RotationInfo({ account: a }: { account: AccountData }) {
  if (!a.rotation_supported) {
    return (
      <p className="text-xs text-muted-foreground" title={blockerLabel(a.rotation_blocker) || undefined}>
        Rotation non prise en charge
      </p>
    );
  }
  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      {a.rotation_enabled ? (
        <p className="flex items-center gap-1">
          <CalendarClock className="size-3" /> Rotation tous les {a.rotation_interval_days} j,{" "}
          {a.next_rotation_at
            ? `prochaine le ${formatDate(a.next_rotation_at, false)}`
            : "prochaine au passage du planificateur"}
        </p>
      ) : (
        <p>Rotation automatique désactivée</p>
      )}
      {a.last_rotated_at && (
        <p className="flex items-center gap-1">
          <CheckCircle2 className="size-3" /> Dernière rotation le {formatDate(a.last_rotated_at)}
        </p>
      )}
      {a.last_rotation_status === "failed" && (
        <p className="break-words text-danger">
          Échec de la dernière rotation{a.last_rotation_message ? ` : ${a.last_rotation_message}` : ""}
        </p>
      )}
    </div>
  );
}

/** Admin-only management of the accounts of a server. */
export default function AccountsSection({
  server,
  onChanged,
  reloadKey = 0,
}: {
  server: ServerData;
  onChanged: () => void;
  /** Bumped by the parent when accounts were created elsewhere (discovery). */
  reloadKey?: number;
}) {
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [credentials, setCredentials] = useState<CredentialData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [editing, setEditing] = useState<AccountData | null | undefined>(undefined);
  const [historyOf, setHistoryOf] = useState<AccountData | null>(null);
  const [rotating, setRotating] = useState<AccountData | null>(null);
  const [busy, setBusy] = useState<{ id: string; op: "verify" | "rotate" } | null>(null);
  const [removing, setRemoving] = useState<AccountData | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api
      .get<AccountData[]>(`/api/servers/${server.id}/accounts`)
      .then((a) => {
        setAccounts(a);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [server.id]);

  useEffect(() => {
    load();
    api.get<CredentialData[]>("/api/servers/credentials/").then(setCredentials).catch(() => {});
  }, [load]);

  useEffect(() => {
    if (reloadKey > 0) load();
  }, [reloadKey, load]);

  const refresh = () => {
    load();
    onChanged();
  };

  const setDefault = async (acc: AccountData) => {
    try {
      await api.patch(`/api/servers/${server.id}/accounts/${acc.id}`, { is_default: true });
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async (acc: AccountData) => {
    setDeleting(true);
    try {
      await api.delete(`/api/servers/${server.id}/accounts/${acc.id}`);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
      setRemoving(null);
    }
  };

  const runOperation = async (acc: AccountData, op: "verify" | "rotate") => {
    setBusy({ id: acc.id, op });
    setNotice(null);
    try {
      const r = await api.post<AccountOperationResult>(
        `/api/servers/${server.id}/accounts/${acc.id}/${op}`,
        {}
      );
      if (r.account) {
        const updated = r.account;
        setAccounts((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      }
      setNotice({
        ok: r.ok,
        text: (
          <>
            <strong className="font-mono">{acc.username}</strong> : {r.message}
          </>
        ),
      });
    } catch (e) {
      setNotice({
        ok: false,
        text: (
          <>
            <strong className="font-mono">{acc.username}</strong> : {errorMessage(e)}
          </>
        ),
      });
    } finally {
      setBusy(null);
      setRotating(null);
    }
  };

  return (
    <section className="mt-8 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <UserRound className="size-4 text-muted-foreground" /> Comptes
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Le compte par défaut sert à l'automatisation (métriques, mises à jour, commandes, rotation des
            mots de passe). Les règles d'accès définissent qui peut utiliser quel compte.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus /> Ajouter un compte
        </Button>
      </div>
      {(error || notice) && (
        <div className="space-y-2 p-4 pb-0">
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <ErrorBox message={error} />
        </div>
      )}
      {loading ? (
        <div className="space-y-2 p-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={UserRound}
            title="Aucun compte"
            action={
              <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
                <Plus /> Ajouter un compte
              </Button>
            }
          >
            Sans compte par défaut, le test de connexion, les métriques et les mises à jour ne fonctionnent pas.
          </EmptyState>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Utilisateur</TableHead>
              <TableHead>Authentification</TableHead>
              <TableHead>Attributs</TableHead>
              <TableHead>Rotation</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="pr-4 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => {
              const isBusy = busy?.id === a.id;
              const rotateTitle = a.rotation_supported
                ? "Faire tourner le mot de passe"
                : blockerLabel(a.rotation_blocker) || "Rotation non prise en charge";
              return (
                <TableRow key={a.id} className={cn("align-top", !a.is_active && "opacity-50")}>
                  <TableCell className="pl-4 font-mono">{a.username}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-xs">
                      {a.auth === "cert" ? (
                        <ShieldCheck className="size-3.5 text-info" />
                      ) : (
                        <KeyRound className="size-3.5 text-muted-foreground" />
                      )}
                      {AUTH_LABELS[a.auth]}
                      {a.credential_name && <span className="text-muted-foreground">({a.credential_name})</span>}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <VerifyBadge account={a} />
                      {a.is_default && <Chip tone="primary">par défaut</Chip>}
                      {a.privileged && (
                        <Chip tone="amber">
                          <ShieldAlert className="size-3" /> privilégié
                        </Chip>
                      )}
                      {!a.is_active && <Chip>inactif</Chip>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <RotationInfo account={a} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.description}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <RowAction
                        label="Vérifier (connexion au serveur avec le secret stocké)"
                        onClick={() => runOperation(a, "verify")}
                        disabled={isBusy}
                      >
                        {isBusy && busy?.op === "verify" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                      </RowAction>
                      <RowAction label={rotateTitle} onClick={() => setRotating(a)} disabled={isBusy || !a.rotation_supported}>
                        {isBusy && busy?.op === "rotate" ? <Loader2 className="animate-spin" /> : <RotateCw />}
                      </RowAction>
                      <RowAction label="Historique" onClick={() => setHistoryOf(a)}>
                        <History />
                      </RowAction>
                      {!a.is_default && a.is_active && (
                        <RowAction label="Définir par défaut" onClick={() => setDefault(a)}>
                          <Star />
                        </RowAction>
                      )}
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
            })}
          </TableBody>
        </Table>
      )}

      {removing && (
        <ConfirmModal
          title={
            <>
              Supprimer le compte <span className="font-mono">{removing.username}</span>
            </>
          }
          confirmLabel="Supprimer"
          danger
          loading={deleting}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        >
          <p>
            Le compte ne sera plus utilisable depuis Citadel sur <strong>{server.name}</strong>. Il n'est pas
            supprimé du serveur lui-même.
          </p>
        </ConfirmModal>
      )}
      {editing !== undefined && (
        <AccountModal
          server={server}
          account={editing}
          credentials={credentials}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            refresh();
          }}
        />
      )}
      {historyOf && <HistoryModal server={server} account={historyOf} onClose={() => setHistoryOf(null)} />}
      {rotating && (
        <ConfirmModal
          title={
            <>
              Faire tourner le mot de passe de <span className="font-mono">{rotating.username}</span>
            </>
          }
          confirmLabel="Faire tourner"
          danger
          loading={busy?.id === rotating.id}
          onClose={() => setRotating(null)}
          onConfirm={() => runOperation(rotating, "rotate")}
        >
          <p>
            Citadel va générer un nouveau mot de passe et <strong>le changer sur le serveur</strong>{" "}
            {server.name} en passant par son compte privilégié par défaut
            {server.default_account ? (
              <>
                {" "}
                (<span className="font-mono">{server.default_account.username}</span>)
              </>
            ) : null}
            .
          </p>
          <p>
            Le nouveau mot de passe est conservé chiffré dans le coffre ; l'ancien ne fonctionnera plus.
            Pensez aux éventuels services ou scripts qui utilisent ce compte en dehors de Citadel.
          </p>
          <p className="text-xs text-muted-foreground">
            L'opération peut prendre une dizaine de secondes ; le compte est ensuite vérifié avec le
            nouveau secret.
          </p>
        </ConfirmModal>
      )}
    </section>
  );
}

// ── Shared form helpers (also used by Servers and DiscoveredAccounts) ──

/** Checkbox with its label, shadcn styled. */
export function CheckField({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-2 text-sm", disabled && "opacity-50")}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} />
      <label htmlFor={id} className="cursor-pointer select-none">
        {label}
      </label>
    </div>
  );
}

function RadioRow({
  checked,
  onSelect,
  disabled,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className="flex items-center gap-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-foreground" : "border-input",
        )}
      >
        {checked && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      {children}
    </button>
  );
}

/** Stored credential or ephemeral certificate, with the credential picker. */
export function AuthModePicker({
  mode,
  onMode,
  certAllowed,
  credentialId,
  onCredential,
  credentials,
}: {
  mode: "credential" | "cert";
  onMode: (m: "credential" | "cert") => void;
  certAllowed: boolean;
  credentialId: string;
  onCredential: (id: string) => void;
  credentials: CredentialData[];
}) {
  return (
    <div role="radiogroup" className="space-y-2">
      <RadioRow checked={mode === "credential"} onSelect={() => onMode("credential")}>
        Credential enregistré
      </RadioRow>
      {mode === "credential" && (
        <Select value={credentialId} onValueChange={onCredential}>
          <SelectTrigger>
            <SelectValue placeholder="Choisir un credential" />
          </SelectTrigger>
          <SelectContent>
            {credentials.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun credential enregistré</p>
            )}
            {credentials.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  ({c.username}, {c.type})
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <RadioRow checked={mode === "cert"} onSelect={() => onMode("cert")} disabled={!certAllowed}>
        Certificat éphémère (CA Citadel, Linux uniquement)
      </RadioRow>
    </div>
  );
}

/** Ghost icon button with a tooltip, for table rows. */
export function RowAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span keeps the tooltip working on a disabled button */}
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={cn("size-8 text-muted-foreground", danger && "hover:bg-danger/10 hover:text-danger")}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{label}</TooltipContent>
    </Tooltip>
  );
}
