import { useCallback, useEffect, useState } from "react";
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
  Toggle,
  btnSecondary,
  formatDate,
  iconBtn,
  iconBtnDanger,
  inputCls,
  type NoticeData,
} from "@/components/kit";
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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {account ? "Enregistrer" : "Ajouter"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Utilisateur *" hint="Nom du compte sur le serveur cible.">
        <input
          value={form.username}
          onChange={(e) => set({ username: e.target.value })}
          placeholder={isLinux ? "root" : "Administrator"}
          className={inputCls}
          autoFocus
        />
      </Field>
      <Field label="Authentification">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={form.mode === "credential"} onChange={() => set({ mode: "credential" })} />
            Credential enregistré
          </label>
          {form.mode === "credential" && (
            <select
              value={form.credential_id}
              onChange={(e) => set({ credential_id: e.target.value })}
              className={inputCls}
            >
              <option value="">Choisir un credential</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.username}, {c.type})
                </option>
              ))}
            </select>
          )}
          <label className={`flex items-center gap-2 text-sm ${isLinux ? "" : "opacity-50"}`}>
            <input
              type="radio"
              disabled={!isLinux}
              checked={form.mode === "cert"}
              onChange={() => set({ mode: "cert" })}
            />
            Certificat éphémère (CA Citadel, Linux uniquement)
          </label>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(e) => set({ is_default: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          Compte par défaut
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.privileged}
            onChange={(e) => set({ privileged: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          Compte privilégié
        </label>
        {account && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set({ is_active: e.target.checked })}
              className="w-4 h-4 rounded"
            />
            Actif
          </label>
        )}
      </div>
      <Field label="Description">
        <input
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          className={inputCls}
        />
      </Field>
      <div className="border rounded-md p-3 space-y-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <RotateCw size={14} /> Rotation du mot de passe
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
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.rotation_interval_days}
                  onChange={(e) => set({ rotation_interval_days: e.target.value })}
                  className={`${inputCls} w-24`}
                />
                <span>jours</span>
                {!intervalOk && <span className="text-xs text-red-600">entre 1 et 365</span>}
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
        <button onClick={onClose} className={btnSecondary}>
          Fermer
        </button>
      }
    >
      <p className="text-xs text-muted-foreground">
        Métadonnées uniquement : les secrets restent chiffrés dans le coffre et ne sont jamais affichés.
      </p>
      <ErrorBox message={error} />
      {!rows && !error && <Loader2 size={18} className="animate-spin text-muted-foreground" />}
      {rows && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune rotation pour ce compte. Le secret actuel est celui du credential d'origine.
        </p>
      )}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-2 font-medium">Généré le</th>
              <th className="text-left p-2 font-medium">Statut</th>
              <th className="text-left p-2 font-medium">Origine</th>
              <th className="text-left p-2 font-medium">Activé le</th>
              <th className="text-left p-2 font-medium">Erreur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const st = HISTORY_STATUS[h.status] || { label: h.status, tone: "default" as const };
              return (
                <tr key={h.id} className="border-b last:border-0 align-top">
                  <td className="p-2 text-xs whitespace-nowrap">{formatDate(h.created_at)}</td>
                  <td className="p-2">
                    <Chip tone={st.tone}>{st.label}</Chip>
                  </td>
                  <td className="p-2 text-xs" title={h.actor_id ? `Utilisateur ${h.actor_id}` : undefined}>
                    {HISTORY_REASON[h.reason] || h.reason}
                  </td>
                  <td className="p-2 text-xs whitespace-nowrap">{formatDate(h.activated_at)}</td>
                  <td className="p-2 text-xs text-red-700 break-words">{h.error}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
          <CalendarClock size={11} /> Rotation tous les {a.rotation_interval_days} j,{" "}
          {a.next_rotation_at
            ? `prochaine le ${formatDate(a.next_rotation_at, false)}`
            : "prochaine au passage du planificateur"}
        </p>
      ) : (
        <p>Rotation automatique désactivée</p>
      )}
      {a.last_rotated_at && (
        <p className="flex items-center gap-1">
          <CheckCircle2 size={11} /> Dernière rotation le {formatDate(a.last_rotated_at)}
        </p>
      )}
      {a.last_rotation_status === "failed" && (
        <p className="text-red-600 break-words">
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
    if (!confirm(`Supprimer le compte ${acc.username} ?`)) return;
    try {
      await api.delete(`/api/servers/${server.id}/accounts/${acc.id}`);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
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
    <div className="bg-card border rounded-lg mt-6">
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <UserRound size={16} /> Comptes
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Le compte par défaut sert à l'automatisation (métriques, mises à jour, commandes, rotation des
            mots de passe). Les règles d'accès définissent qui peut utiliser quel compte.
          </p>
        </div>
        <button
          onClick={() => setEditing(null)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={14} /> Ajouter un compte
        </button>
      </div>
      {(error || notice) && (
        <div className="p-4 pb-0 space-y-2">
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <ErrorBox message={error} />
        </div>
      )}
      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">Chargement...</p>
      ) : accounts.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Aucun compte. Sans compte par défaut, le test de connexion, les métriques et les mises à jour
          ne fonctionnent pas.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Utilisateur</th>
                <th className="text-left p-3 font-medium">Authentification</th>
                <th className="text-left p-3 font-medium">Attributs</th>
                <th className="text-left p-3 font-medium">Rotation</th>
                <th className="text-left p-3 font-medium">Description</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const isBusy = busy?.id === a.id;
                const rotateTitle = a.rotation_supported
                  ? "Faire tourner le mot de passe"
                  : blockerLabel(a.rotation_blocker) || "Rotation non prise en charge";
                return (
                  <tr
                    key={a.id}
                    className={`border-b last:border-0 align-top ${a.is_active ? "" : "opacity-50"}`}
                  >
                    <td className="p-3 font-mono">{a.username}</td>
                    <td className="p-3">
                      <span className="flex items-center gap-1.5 text-xs">
                        {a.auth === "cert" ? (
                          <ShieldCheck size={13} className="text-blue-500" />
                        ) : (
                          <KeyRound size={13} className="text-muted-foreground" />
                        )}
                        {AUTH_LABELS[a.auth]}
                        {a.credential_name && (
                          <span className="text-muted-foreground">({a.credential_name})</span>
                        )}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        <VerifyBadge account={a} />
                        {a.is_default && <Chip tone="primary">par défaut</Chip>}
                        {a.privileged && (
                          <Chip tone="amber">
                            <ShieldAlert size={11} /> privilégié
                          </Chip>
                        )}
                        {!a.is_active && <Chip>inactif</Chip>}
                      </div>
                    </td>
                    <td className="p-3 max-w-xs">
                      <RotationInfo account={a} />
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{a.description}</td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => runOperation(a, "verify")}
                          disabled={isBusy}
                          className={iconBtn}
                          title="Vérifier (connexion au serveur avec le secret stocké)"
                        >
                          {isBusy && busy?.op === "verify" ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <ShieldCheck size={15} />
                          )}
                        </button>
                        <button
                          onClick={() => setRotating(a)}
                          disabled={isBusy || !a.rotation_supported}
                          className={iconBtn}
                          title={rotateTitle}
                        >
                          {isBusy && busy?.op === "rotate" ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <RotateCw size={15} />
                          )}
                        </button>
                        <button onClick={() => setHistoryOf(a)} className={iconBtn} title="Historique">
                          <History size={15} />
                        </button>
                        {!a.is_default && a.is_active && (
                          <button onClick={() => setDefault(a)} className={iconBtn} title="Définir par défaut">
                            <Star size={15} />
                          </button>
                        )}
                        <button onClick={() => setEditing(a)} className={iconBtn} title="Modifier">
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => remove(a)} className={iconBtnDanger} title="Supprimer">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
    </div>
  );
}
