import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, Plus, ShieldAlert, ShieldCheck, Star, Trash2, UserRound } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type AccountData,
  type CredentialData,
  type ServerData,
} from "@/services/types";
import {
  Chip,
  ErrorBox,
  Field,
  Modal,
  SaveButton,
  btnSecondary,
  iconBtn,
  iconBtnDanger,
  inputCls,
} from "@/components/ui";

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
  }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<AccountForm>) => setForm((f) => ({ ...f, ...p }));

  const valid =
    form.username.trim() !== "" && (form.mode === "cert" ? isLinux : form.credential_id !== "");

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
    if (account) body.is_active = form.is_active;
    try {
      if (account) await api.patch(`/api/servers/${server.id}/accounts/${account.id}`, body);
      else await api.post(`/api/servers/${server.id}/accounts`, body);
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
    </Modal>
  );
}

/** Admin-only management of the accounts of a server. */
export default function AccountsSection({
  server,
  onChanged,
}: {
  server: ServerData;
  onChanged: () => void;
}) {
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [credentials, setCredentials] = useState<CredentialData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountData | null | undefined>(undefined);

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

  return (
    <div className="bg-card border rounded-lg mt-6">
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <UserRound size={16} /> Comptes
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Le compte par défaut sert à l'automatisation (métriques, mises à jour, commandes). Les
            règles d'accès définissent qui peut utiliser quel compte.
          </p>
        </div>
        <button
          onClick={() => setEditing(null)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={14} /> Ajouter un compte
        </button>
      </div>
      {error && (
        <div className="p-4 pb-0">
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
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3 font-medium">Utilisateur</th>
              <th className="text-left p-3 font-medium">Authentification</th>
              <th className="text-left p-3 font-medium">Attributs</th>
              <th className="text-left p-3 font-medium">Description</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className={`border-b last:border-0 ${a.is_active ? "" : "opacity-50"}`}>
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
                    {a.is_default && <Chip tone="primary">par défaut</Chip>}
                    {a.privileged && (
                      <Chip tone="amber">
                        <ShieldAlert size={11} /> privilégié
                      </Chip>
                    )}
                    {!a.is_active && <Chip>inactif</Chip>}
                  </div>
                </td>
                <td className="p-3 text-xs text-muted-foreground">{a.description}</td>
                <td className="p-3 text-right">
                  <div className="flex items-center justify-end gap-1">
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
            ))}
          </tbody>
        </table>
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
    </div>
  );
}
