import { useEffect, useState } from "react";
import { KeyRound, Loader2, Server, ShieldCheck, UserRound } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type ConnectableAccount,
  type ConnectionChoice,
  type ServerData,
} from "@/services/types";
import { ErrorBox, inputCls } from "@/components/ui";

const DURATIONS: [number, string][] = [
  [5, "5 minutes"],
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 heure"],
  [120, "2 heures"],
  [240, "4 heures"],
  [480, "8 heures"],
  [720, "12 heures"],
  [1440, "24 heures"],
];

function keyOf(a: ConnectableAccount): string {
  return a.id ?? a.virtual ?? a.username;
}

/**
 * Account picker + strong-auth confirmation shown before opening a terminal or RDP session.
 * The @INPUT password lives only in this component's state and in the in-memory choice
 * handed to the caller; it is never persisted nor logged.
 */
export default function ConnectDialog({
  server,
  onCancel,
  onConfirm,
}: {
  server: Pick<ServerData, "id" | "name" | "os_type" | "default_account">;
  onCancel: () => void;
  onConfirm: (choice: ConnectionChoice, certDuration?: number) => Promise<void>;
}) {
  const isRdp = server.os_type === "windows";
  const [accounts, setAccounts] = useState<ConnectableAccount[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [inputUser, setInputUser] = useState("");
  const [inputPassword, setInputPassword] = useState("");
  const [certDuration, setCertDuration] = useState(480);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<ConnectableAccount[]>(`/api/servers/${server.id}/connectable-accounts`)
      .then((list) => {
        if (!alive) return;
        // @USER relies on an ephemeral SSH certificate: not usable for RDP
        const usable = isRdp ? list.filter((a) => a.virtual !== "@USER") : list;
        setAccounts(usable);
        const def = usable.find((a) => a.is_default) || usable[0];
        if (def) setSelected(keyOf(def));
      })
      .catch((e) => alive && (setAccounts([]), setError(errorMessage(e))));
    return () => {
      alive = false;
    };
  }, [server.id, isRdp]);

  const chosen = accounts?.find((a) => keyOf(a) === selected) || null;
  const isInput = chosen?.virtual === "@INPUT";
  // Only the default account's auth type is known client-side (see report)
  const usesCert = !isRdp && !!chosen && chosen.auth === "cert";

  const canConfirm = !!chosen && (!isInput || (inputUser.trim() !== "" && inputPassword !== ""));

  const confirm = async () => {
    if (!chosen) return;
    const choice: ConnectionChoice = chosen.virtual
      ? chosen.virtual === "@INPUT"
        ? {
            virtual_account: "@INPUT",
            input_username: inputUser.trim(),
            input_password: inputPassword,
            label: inputUser.trim(),
          }
        : { virtual_account: "@USER", label: "@USER" }
      : { account_id: chosen.id!, label: chosen.username };
    setLoading(true);
    setError(null);
    try {
      await onConfirm(choice, usesCert ? certDuration : undefined);
    } catch (e) {
      setError(errorMessage(e, "MFA failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg shadow-lg w-full max-w-sm mx-4 p-6">
        <div className="space-y-4">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
              <Server size={24} className="text-amber-600" />
            </div>
            <h3 className="font-semibold text-lg">Connexion à {server.name}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Choisissez le compte puis confirmez votre identité (authentification renforcée).
            </p>
          </div>

          {accounts === null && (
            <div className="flex justify-center py-4">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          )}

          {accounts !== null && accounts.length === 0 && !error && (
            <p className="text-sm text-center text-muted-foreground">
              Aucun compte ne vous est accordé sur ce serveur.
            </p>
          )}

          {accounts !== null && accounts.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-1">Compte</label>
              {accounts.length === 1 ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md border text-sm">
                  <UserRound size={14} className="text-muted-foreground" />
                  <span className="font-mono">{accounts[0].username}</span>
                  {accounts[0].privileged && (
                    <span className="ml-auto text-xs text-amber-700">privilégié</span>
                  )}
                </div>
              ) : (
                <div className="space-y-1 max-h-48 overflow-auto">
                  {accounts.map((a) => (
                    <label
                      key={keyOf(a)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm cursor-pointer ${
                        selected === keyOf(a) ? "border-primary bg-primary/5" : "hover:bg-accent"
                      }`}
                    >
                      <input
                        type="radio"
                        name="connect-account"
                        checked={selected === keyOf(a)}
                        onChange={() => setSelected(keyOf(a))}
                      />
                      <span className="font-mono">{a.username}</span>
                      <span className="ml-auto flex gap-1 text-xs">
                        {a.is_default && <span className="text-muted-foreground">par défaut</span>}
                        {a.privileged && <span className="text-amber-700">privilégié</span>}
                        {a.virtual === "@USER" && (
                          <span className="text-muted-foreground">votre identité</span>
                        )}
                        {a.virtual === "@INPUT" && (
                          <span className="text-muted-foreground">saisie manuelle</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {isInput && (
            <div className="space-y-3 p-3 rounded-md border bg-muted/30">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRound size={12} /> Identifiants utilisés pour cette connexion uniquement, jamais
                enregistrés.
              </div>
              <input
                type="text"
                value={inputUser}
                onChange={(e) => setInputUser(e.target.value)}
                placeholder="Utilisateur"
                autoComplete="off"
                className={inputCls}
              />
              <input
                type="password"
                value={inputPassword}
                onChange={(e) => setInputPassword(e.target.value)}
                placeholder="Mot de passe"
                autoComplete="new-password"
                className={inputCls}
              />
            </div>
          )}

          {usesCert && (
            <div>
              <label className="block text-sm font-medium mb-1">Durée de la session</label>
              <select
                value={certDuration}
                onChange={(e) => setCertDuration(parseInt(e.target.value))}
                className={inputCls}
              >
                {DURATIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Un certificat SSH sera généré pour cette durée.
              </p>
            </div>
          )}

          <ErrorBox message={error} />

          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="flex-1 px-4 py-2 rounded-md border text-sm hover:bg-accent"
            >
              Annuler
            </button>
            <button
              onClick={confirm}
              disabled={loading || !canConfirm}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <>
                  <ShieldCheck size={16} /> Confirmer (MFA)
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
