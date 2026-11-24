import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Plus, ShieldCheck, Trash2, User } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  type AccessKeyCreated,
  type AccessKeyData,
  type ServerAccess,
} from "@/services/types";
import { AccessTable } from "@/pages/Access";
import {
  Chip,
  ErrorBox,
  Field,
  Modal,
  SaveButton,
  btnSecondary,
  formatDate,
  iconBtnDanger,
  inputCls,
} from "@/components/kit";

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
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={create} loading={loading} disabled={!name.trim()}>
            Créer la clé
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom *" hint="Pour reconnaître la clé (script, outil, poste...).">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="script-inventaire"
          className={inputCls}
          autoFocus
        />
      </Field>
      <Field label="Expiration">
        <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
          <option value="7">7 jours</option>
          <option value="30">30 jours</option>
          <option value="90">90 jours (recommandé)</option>
          <option value="180">180 jours</option>
          <option value="365">1 an</option>
          <option value="never">Jamais (déconseillé)</option>
        </select>
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
        <button onClick={onClose} className={btnSecondary}>
          J'ai copié la clé
        </button>
      }
    >
      <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-900 flex gap-2">
        <AlertTriangle size={18} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Copiez cette clé maintenant.</p>
          <p className="text-xs mt-1">
            Elle ne sera plus jamais affichée : Citadel n'en conserve qu'une empreinte. Traitez-la
            comme un mot de passe et ne la partagez pas. Utilisation : en-tête{" "}
            <span className="font-mono">Authorization: Bearer &lt;clé&gt;</span>.
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <input
          readOnly
          value={created.token}
          onFocus={(e) => e.target.select()}
          className={`${inputCls} font-mono text-xs`}
        />
        <button onClick={copy} className={btnSecondary} title="Copier">
          {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Expiration : {created.expires_at ? formatDate(created.expires_at) : "jamais"}
      </p>
    </Modal>
  );
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

  const revoke = async (k: AccessKeyData) => {
    if (!confirm(`Révoquer la clé ${k.name} (${k.prefix}) ? Les outils qui l'utilisent perdront l'accès.`)) return;
    try {
      await api.delete(`/api/access-keys/${k.id}`);
      loadKeys();
    } catch (e) {
      setKeysError(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Mon compte</h2>

      {/* Profile */}
      <div className="bg-card border rounded-lg p-4 flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
          <User size={22} className="text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-medium">{user?.display_name || "..."}</p>
          <p className="text-sm text-muted-foreground">{user?.email}</p>
        </div>
        {user && <Chip tone={user.role === "admin" ? "amber" : "primary"}>{ROLE_LABELS[user.role] || user.role}</Chip>}
      </div>

      {/* My access */}
      <div className="bg-card border rounded-lg">
        <div className="p-4 border-b">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <ShieldCheck size={16} /> Mes accès
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Serveurs auxquels vous avez accès, avec les comptes et actions accordés par les règles
            d'accès.
          </p>
        </div>
        {accessError && (
          <div className="p-4">
            <ErrorBox message={accessError} />
          </div>
        )}
        {access === null && !accessError && <p className="p-4 text-sm text-muted-foreground">Chargement...</p>}
        {access && <AccessTable rows={access} />}
      </div>

      {/* API keys */}
      <div className="bg-card border rounded-lg">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <KeyRound size={16} /> Clés API
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Jetons personnels pour l'API Citadel (scripts, intégrations). Ils héritent de vos droits.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allUsers}
                  onChange={(e) => setAllUsers(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                Toutes les clés
              </label>
            )}
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90"
            >
              <Plus size={14} /> Nouvelle clé
            </button>
          </div>
        </div>
        {keysError && (
          <div className="p-4 pb-0">
            <ErrorBox message={keysError} />
          </div>
        )}
        {keysLoading ? (
          <div className="p-4">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : keys.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Aucune clé API.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Nom</th>
                <th className="text-left p-3 font-medium">Préfixe</th>
                {allUsers && <th className="text-left p-3 font-medium">Utilisateur</th>}
                <th className="text-left p-3 font-medium">Statut</th>
                <th className="text-left p-3 font-medium">Créée</th>
                <th className="text-left p-3 font-medium">Expire</th>
                <th className="text-left p-3 font-medium">Dernière utilisation</th>
                <th className="text-right p-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const st = keyState(k);
                return (
                  <tr key={k.id} className={`border-b last:border-0 ${k.is_active ? "" : "opacity-60"}`}>
                    <td className="p-3 font-medium">{k.name}</td>
                    <td className="p-3 font-mono text-xs">ctk_{k.prefix}_...</td>
                    {allUsers && <td className="p-3 text-xs">{k.user_name}</td>}
                    <td className="p-3">
                      <Chip tone={st.tone}>{st.label}</Chip>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{formatDate(k.created_at)}</td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {k.expires_at ? formatDate(k.expires_at) : "jamais"}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{formatDate(k.last_used_at)}</td>
                    <td className="p-3 text-right">
                      {k.is_active && (
                        <button onClick={() => revoke(k)} className={iconBtnDanger} title="Révoquer">
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

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
    </div>
  );
}
