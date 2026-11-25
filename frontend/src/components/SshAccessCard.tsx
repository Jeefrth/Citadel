// Mon compte > Accès SSH (lot 7): connect with one's own SSH client through the
// Citadel proxy, with a public key or a connection token shown once.
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Fingerprint, KeyRound, Plus, Terminal, Ticket, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type SshKeyData,
  type SshProxyInfo,
  type SshTokenCreated,
  type SshTokenData,
} from "@/services/types";
import { Chip, ConfirmModal, ErrorBox, Field, Modal, SaveButton, formatDate, iconBtnDanger } from "@/components/kit";
import { TableSkeleton } from "@/components/auditUi";
import { CopyLine, OnceWarning, SecretField } from "@/components/secretOnce";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const TOKEN_DURATIONS: { value: string; label: string }[] = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 heure" },
  { value: "240", label: "4 heures" },
  { value: "480", label: "8 heures" },
  { value: "1440", label: "24 heures (maximum)" },
];

function AddKeyModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.post<SshKeyData>("/api/me/ssh-keys", { name: name.trim(), public_key: publicKey.trim() });
      toast.success(`Clé ${name.trim()} ajoutée`);
      onAdded();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Ajouter une clé publique"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={add} loading={loading} disabled={!name.trim() || publicKey.trim().length < 20}>
            Ajouter la clé
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom" hint="Pour reconnaître la clé (poste, usage...).">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="portable-jf" autoFocus />
      </Field>
      <Field
        label="Clé publique"
        hint={
          <>
            Contenu du fichier <span className="font-mono">.pub</span>, par exemple{" "}
            <span className="font-mono">~/.ssh/id_ed25519.pub</span>. Ed25519 conseillée, RSA 3072 bits au moins. Ne
            collez jamais la clé privée.
          </>
        }
      >
        <Textarea
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... jf@portable"
          className="font-mono text-xs"
        />
      </Field>
    </Modal>
  );
}

function NewTokenModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [minutes, setMinutes] = useState("60");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<SshTokenCreated | null>(null);

  const create = async () => {
    setLoading(true);
    setError(null);
    try {
      setCreated(await api.post<SshTokenCreated>("/api/me/ssh-tokens", { minutes: parseInt(minutes) }));
      onCreated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <Modal title="Jeton de connexion créé" onClose={onClose} size="lg" footer={<Button onClick={onClose}>J'ai copié le jeton</Button>}>
        <OnceWarning title="Copiez ce jeton maintenant.">
          Il ne sera plus jamais affiché. Saisissez-le quand votre client SSH demande un mot de passe. Il reste
          utilisable jusqu'à son expiration, pour plusieurs connexions : traitez-le comme un mot de passe.
        </OnceWarning>
        <SecretField value={created.token} label="Copier le jeton" />
        <p className="text-xs text-muted-foreground">Expire le {formatDate(created.expires_at)}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Nouveau jeton de connexion"
      description="Un mot de passe temporaire pour le proxy SSH, quand vous n'avez pas votre clé sous la main."
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={create} loading={loading}>
            Créer le jeton
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Validité">
        <Select value={minutes} onValueChange={setMinutes}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOKEN_DURATIONS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </Modal>
  );
}

export default function SshAccessCard() {
  const [info, setInfo] = useState<SshProxyInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKeyData[] | null>(null);
  const [tokens, setTokens] = useState<SshTokenData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newToken, setNewToken] = useState(false);
  const [removing, setRemoving] = useState<SshKeyData | null>(null);
  const [revoking, setRevoking] = useState<SshTokenData | null>(null);
  const [busy, setBusy] = useState(false);

  const loadKeys = useCallback(() => {
    api
      .get<SshKeyData[]>("/api/me/ssh-keys")
      .then(setKeys)
      .catch((e) => {
        setKeys((k) => k ?? []);
        setError(errorMessage(e));
      });
  }, []);
  const loadTokens = useCallback(() => {
    api
      .get<SshTokenData[]>("/api/me/ssh-tokens")
      .then(setTokens)
      .catch((e) => {
        setTokens((t) => t ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    api
      .get<SshProxyInfo>("/api/me/ssh-proxy")
      .then(setInfo)
      .catch((e) => setInfoError(errorMessage(e)));
    loadKeys();
    loadTokens();
  }, [loadKeys, loadTokens]);

  const removeKey = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/api/me/ssh-keys/${removing.id}`);
      toast.success(`Clé ${removing.name} supprimée`);
      setKeys((k) => (k || []).filter((x) => x.id !== removing.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const revokeToken = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.delete(`/api/me/ssh-tokens/${revoking.id}`);
      toast.success("Jeton révoqué");
      setTokens((t) => (t || []).filter((x) => x.id !== revoking.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  };

  return (
    <Card id="ssh" className="scroll-mt-20 overflow-hidden">
      <div className="space-y-1 border-b p-4">
        <h3 className="flex items-center gap-2 text-base font-semibold leading-none">
          <Terminal className="size-4 text-muted-foreground" /> Accès SSH
        </h3>
        <p className="text-xs text-muted-foreground">
          Connectez-vous aux serveurs Linux accordés avec votre propre client SSH, avec les mêmes contrôles que le
          terminal web (règles, enregistrement, observation). Authentification par clé publique ou par jeton.
        </p>
      </div>

      <div className="space-y-4 p-4">
        <ErrorBox message={infoError || error} />

        {!info && !infoError ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : info && !info.enabled ? (
          <p className="text-sm text-muted-foreground">
            Le proxy SSH est désactivé sur cette instance. Un administrateur peut l'activer (SSH_PROXY_ENABLED).
          </p>
        ) : info ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">Menu des serveurs</p>
              <CopyLine value={info.example} label="Copier la commande" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">
                Directement sur un serveur (compte par défaut ; <span className="font-mono">compte#serveur</span> pour
                un compte précis)
              </p>
              <CopyLine value={info.example_direct} label="Copier la commande" />
            </div>
            {info.host_key_fingerprint && (
              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Fingerprint className="size-3.5" /> Empreinte de la clé d'hôte, à comparer à la première connexion
                </p>
                <CopyLine value={info.host_key_fingerprint} label="Copier l'empreinte" />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Shell interactif seulement : pas de commande directe, de SFTP, de redirection de ports ni de transfert
              d'agent. L'authentification forte Entra ne s'applique pas ici : protégez votre clé privée par une phrase de
              passe.
            </p>
          </div>
        ) : null}
      </div>

      {/* Public keys */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4 text-muted-foreground" /> Clés publiques
        </p>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Ajouter une clé
        </Button>
      </div>
      {keys && keys.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Aucune clé. Ajoutez votre clé publique pour vous connecter sans jeton.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Nom</TableHead>
              <TableHead>Algorithme</TableHead>
              <TableHead>Empreinte</TableHead>
              <TableHead>Ajoutée</TableHead>
              <TableHead>Dernière utilisation</TableHead>
              <TableHead className="pr-4">
                <span className="sr-only">Gestion</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!keys ? (
              <TableSkeleton cols={6} rows={2} />
            ) : (
              <AnimatePresence initial={false}>
                {keys.map((k) => (
                  <motion.tr key={k.id} layout exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="border-b hover:bg-muted/50">
                    <TableCell className="py-2 pl-4 font-medium">{k.name}</TableCell>
                    <TableCell className="py-2 font-mono text-xs text-muted-foreground">{k.algorithm}</TableCell>
                    <TableCell className="max-w-xs truncate py-2 font-mono text-xs" title={k.fingerprint}>
                      {k.fingerprint}
                    </TableCell>
                    <TableCell className="tabular py-2 text-xs text-muted-foreground">{formatDate(k.created_at)}</TableCell>
                    <TableCell className="tabular py-2 text-xs text-muted-foreground">
                      {k.last_used_at ? formatDate(k.last_used_at) : "jamais"}
                    </TableCell>
                    <TableCell className="py-1.5 pr-4 text-right">
                      <button onClick={() => setRemoving(k)} className={iconBtnDanger} title="Supprimer la clé">
                        <Trash2 className="size-4" />
                      </button>
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            )}
          </TableBody>
        </Table>
      )}

      {/* Connection tokens */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium">
            <Ticket className="size-4 text-muted-foreground" /> Jetons de connexion
          </p>
          <p className="text-xs text-muted-foreground">Mots de passe temporaires, de 1 minute à 24 heures, affichés une seule fois.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setNewToken(true)}>
          <Plus /> Nouveau jeton
        </Button>
      </div>
      {tokens && tokens.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Aucun jeton valide.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Créé</TableHead>
              <TableHead>Expire</TableHead>
              <TableHead>Dernière utilisation</TableHead>
              <TableHead>État</TableHead>
              <TableHead className="pr-4">
                <span className="sr-only">Gestion</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!tokens ? (
              <TableSkeleton cols={5} rows={1} />
            ) : (
              <AnimatePresence initial={false}>
                {tokens.map((t) => (
                  <motion.tr key={t.id} layout exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="border-b hover:bg-muted/50">
                    <TableCell className="tabular py-2 pl-4 text-xs">{formatDate(t.created_at)}</TableCell>
                    <TableCell className="tabular py-2 text-xs">{formatDate(t.expires_at)}</TableCell>
                    <TableCell className="tabular py-2 text-xs text-muted-foreground">
                      {t.last_used_at ? formatDate(t.last_used_at) : "jamais"}
                    </TableCell>
                    <TableCell className="py-2">
                      <Chip tone="green">Valide</Chip>
                    </TableCell>
                    <TableCell className="py-1.5 pr-4 text-right">
                      <button onClick={() => setRevoking(t)} className={iconBtnDanger} title="Révoquer le jeton">
                        <Trash2 className="size-4" />
                      </button>
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            )}
          </TableBody>
        </Table>
      )}

      {adding && (
        <AddKeyModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            loadKeys();
          }}
        />
      )}
      {newToken && <NewTokenModal onClose={() => setNewToken(false)} onCreated={loadTokens} />}
      {removing && (
        <ConfirmModal
          title={`Supprimer la clé ${removing.name}`}
          confirmLabel="Supprimer la clé"
          danger
          loading={busy}
          onConfirm={removeKey}
          onClose={() => setRemoving(null)}
        >
          <p>
            La clé <span className="font-mono text-foreground">{removing.fingerprint}</span> ne permettra plus de se
            connecter au proxy SSH. Les sessions ouvertes ne sont pas coupées.
          </p>
        </ConfirmModal>
      )}
      {revoking && (
        <ConfirmModal
          title="Révoquer le jeton"
          confirmLabel="Révoquer le jeton"
          danger
          loading={busy}
          onConfirm={revokeToken}
          onClose={() => setRevoking(null)}
        >
          <p>Le jeton créé le {formatDate(revoking.created_at)} ne permettra plus de se connecter.</p>
        </ConfirmModal>
      )}
    </Card>
  );
}
