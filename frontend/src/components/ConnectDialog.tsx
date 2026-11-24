import { useEffect, useState } from "react";
import { KeyRound, Loader2, Monitor, ShieldAlert, ShieldCheck, TerminalSquare, UserRound } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type ConnectableAccount,
  type ConnectionChoice,
  type ServerData,
} from "@/services/types";
import { Chip, ErrorBox, Field, Modal } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
    <Modal
      title={
        <span className="flex items-center gap-2">
          {isRdp ? <Monitor className="size-4 text-muted-foreground" /> : <TerminalSquare className="size-4 text-muted-foreground" />}
          Ouvrir une session sur {server.name}
        </span>
      }
      description="Choisissez le compte, puis confirmez votre identité (authentification renforcée)."
      onClose={loading ? () => {} : onCancel}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Annuler
          </Button>
          <Button onClick={confirm} disabled={loading || !canConfirm}>
            {loading ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Confirmer avec MFA
          </Button>
        </>
      }
    >
      {accounts === null && (
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {accounts !== null && accounts.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          Aucun compte ne vous est accordé sur ce serveur. Demandez un accès à un administrateur.
        </p>
      )}

      {accounts !== null && accounts.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Compte</Label>
          {accounts.length === 1 ? (
            <div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm">
              <UserRound className="size-3.5 text-muted-foreground" />
              <span className="font-mono">{accounts[0].username}</span>
              {accounts[0].privileged && (
                <Chip tone="amber">
                  <ShieldAlert className="size-3" /> privilégié
                </Chip>
              )}
            </div>
          ) : (
            <div role="radiogroup" aria-label="Compte" className="max-h-56 space-y-1 overflow-auto">
              {accounts.map((a) => {
                const on = selected === keyOf(a);
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    key={keyOf(a)}
                    onClick={() => setSelected(keyOf(a))}
                    className={cn(
                      "flex h-10 w-full items-center gap-2.5 rounded-md border px-3 text-left text-sm transition-colors",
                      on ? "border-foreground/40 bg-accent" : "hover:bg-muted/50",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        on ? "border-foreground" : "border-input",
                      )}
                    >
                      {on && <span className="size-2 rounded-full bg-foreground" />}
                    </span>
                    <span className="truncate font-mono">{a.username}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {a.is_default && <Chip>par défaut</Chip>}
                      {a.privileged && <Chip tone="amber">privilégié</Chip>}
                      {a.virtual === "@USER" && <span className="text-xs text-muted-foreground">votre identité</span>}
                      {a.virtual === "@INPUT" && <span className="text-xs text-muted-foreground">saisie manuelle</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {isInput && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" /> Identifiants utilisés pour cette connexion uniquement, jamais
            enregistrés.
          </p>
          <Input
            type="text"
            value={inputUser}
            onChange={(e) => setInputUser(e.target.value)}
            placeholder="Utilisateur"
            autoComplete="off"
            className="font-mono"
          />
          <Input
            type="password"
            value={inputPassword}
            onChange={(e) => setInputPassword(e.target.value)}
            placeholder="Mot de passe"
            autoComplete="new-password"
          />
        </div>
      )}

      {usesCert && (
        <Field label="Durée de la session" hint="Un certificat SSH est signé pour cette durée.">
          <Select value={String(certDuration)} onValueChange={(v) => setCertDuration(parseInt(v))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATIONS.map(([v, l]) => (
                <SelectItem key={v} value={String(v)}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <ErrorBox message={error} />
    </Modal>
  );
}
