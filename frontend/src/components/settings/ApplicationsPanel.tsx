// Paramètres > Applications (lot 7): keys for scripts and services that read a
// secret (GET /api/app/v1/secret), scoped to servers, accounts and source IPs.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { AppWindow, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type ApplicationCreated, type ApplicationData, type ApplicationInput } from "@/services/types";
import { Chip, ConfirmModal, EmptyState, ErrorBox, Field, Modal, SaveButton, Toggle, formatDate } from "@/components/kit";
import { SettingsCard, TableSkeleton } from "@/components/auditUi";
import { RowAction } from "@/components/AccountsSection";
import { TargetFields } from "@/components/NewJobDialog";
import { CopyLine, OnceWarning, SecretField } from "@/components/secretOnce";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function splitList(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function curlExample(server = "web-01", account = "deploy"): string {
  const base = typeof window !== "undefined" ? window.location.origin : "https://citadel";
  return `curl -s -H "Authorization: Bearer $CITADEL_APP_KEY" "${base}/api/app/v1/secret?server=${encodeURIComponent(server)}&account=${encodeURIComponent(account)}"`;
}

function appState(a: ApplicationData): { label: string; tone: "green" | "default" | "amber" } {
  if (!a.is_active) return { label: "Désactivée", tone: "default" };
  if (a.expires_at && new Date(a.expires_at).getTime() < Date.now()) return { label: "Expirée", tone: "amber" };
  return { label: "Active", tone: "green" };
}

function AppModal({
  app,
  onClose,
  onSaved,
}: {
  app: ApplicationData | null;
  onClose: () => void;
  onSaved: (created: ApplicationCreated | null) => void;
}) {
  const [name, setName] = useState(app?.name ?? "");
  const [description, setDescription] = useState(app?.description ?? "");
  const [active, setActive] = useState(app?.is_active ?? true);
  const [days, setDays] = useState("365");
  const [ips, setIps] = useState((app?.allowed_ips || []).join(", "));
  const [serverIds, setServerIds] = useState<string[]>(app?.server_ids || []);
  const [nodeIds, setNodeIds] = useState<string[]>(app?.node_ids || []);
  const [labels, setLabels] = useState<string[]>(app?.labels || []);
  const [accounts, setAccounts] = useState((app?.accounts || []).join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountList = splitList(accounts);
  const valid = name.trim() && accountList.length > 0 && serverIds.length + nodeIds.length + labels.length > 0;

  const save = async () => {
    setLoading(true);
    setError(null);
    const body: ApplicationInput = {
      name: name.trim(),
      description: description.trim() || null,
      is_active: active,
      expires_in_days: days === "never" ? null : parseInt(days),
      allowed_ips: splitList(ips),
      server_ids: serverIds,
      node_ids: nodeIds,
      labels,
      accounts: accountList,
    };
    try {
      if (app) {
        await api.patch(`/api/applications/${app.id}`, body);
        toast.success(`Application ${body.name} enregistrée`);
        onSaved(null);
      } else {
        onSaved(await api.post<ApplicationCreated>("/api/applications", body));
      }
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title={app ? `Modifier ${app.name}` : "Nouvelle application"}
      size="3xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {app ? "Enregistrer l'application" : "Créer l'application"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="deploiement-ci" autoFocus />
        </Field>
        {app ? (
          <Field label="Expiration" hint="Fixée à la création. Pour la changer, recréez l'application.">
            <Input readOnly value={app.expires_at ? formatDate(app.expires_at) : "jamais"} className="tabular" />
          </Field>
        ) : (
          <Field label="Expiration de la clé">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 jours</SelectItem>
                <SelectItem value="90">90 jours</SelectItem>
                <SelectItem value="180">180 jours</SelectItem>
                <SelectItem value="365">1 an (recommandé)</SelectItem>
                <SelectItem value="730">2 ans</SelectItem>
                <SelectItem value="never">Jamais (déconseillé)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Comptes" hint="Noms de comptes lisibles, séparés par des virgules. * : tous les comptes des serveurs choisis.">
          <Input value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder="deploy, backup" className="font-mono" />
        </Field>
        <Field label="Adresses IP autorisées" hint="Adresses ou plages CIDR. Vide : toutes (signalé comme risque).">
          <Input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="10.0.4.0/24, 192.0.2.10" className="font-mono" />
        </Field>
      </div>
      <TargetFields
        serverIds={serverIds}
        nodeIds={nodeIds}
        labels={labels}
        onServerIds={setServerIds}
        onNodeIds={setNodeIds}
        onLabels={setLabels}
      />
      <Toggle checked={active} onChange={setActive} label="Application active" />
    </Modal>
  );
}

function KeyOnceModal({ app, onClose }: { app: ApplicationCreated; onClose: () => void }) {
  return (
    <Modal title={`Clé de l'application ${app.name}`} size="2xl" onClose={onClose} footer={<Button onClick={onClose}>J'ai copié la clé</Button>}>
      <OnceWarning title="Copiez cette clé maintenant.">
        Elle ne sera plus jamais affichée : Citadel n'en conserve qu'une empreinte. Rangez-la dans la configuration
        secrète de l'application, jamais dans un dépôt de code.
      </OnceWarning>
      <SecretField value={app.key} label="Copier la clé" />
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">Exemple (la clé dans la variable CITADEL_APP_KEY)</p>
        <CopyLine value={curlExample()} label="Copier l'exemple" />
      </div>
      <p className="text-xs text-muted-foreground">Expiration : {app.expires_at ? formatDate(app.expires_at) : "jamais"}</p>
    </Modal>
  );
}

export default function ApplicationsPanel() {
  const [apps, setApps] = useState<ApplicationData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApplicationData | null | undefined>(undefined);
  const [shown, setShown] = useState<ApplicationCreated | null>(null);
  const [rotating, setRotating] = useState<ApplicationData | null>(null);
  const [removing, setRemoving] = useState<ApplicationData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<ApplicationData[]>("/api/applications")
      .then((a) => {
        setApps(a);
        setError(null);
      })
      .catch((e) => {
        setApps((a) => a ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rotate = async () => {
    if (!rotating) return;
    setBusy(true);
    try {
      setShown(await api.post<ApplicationCreated>(`/api/applications/${rotating.id}/rotate-key`, {}));
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRotating(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/api/applications/${removing.id}`);
      toast.success(`Application ${removing.name} supprimée`);
      setApps((a) => (a || []).filter((x) => x.id !== removing.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const example = useMemo(() => curlExample(), []);

  return (
    <>
      <SettingsCard
        icon={AppWindow}
        title="Applications"
        description="Clés pour les scripts et services qui lisent un secret géré par Citadel, limitées à des serveurs, des comptes et des adresses IP. Chaque lecture et chaque refus sont journalisés (app.secret_read)."
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus /> Nouvelle application
          </Button>
        }
        className="[&>div:last-child]:p-0"
      >
        <div className="space-y-1.5 border-b px-5 py-4">
          <p className="text-sm text-muted-foreground">Lecture d'un secret (réponse JSON : adresse, port, compte, mot de passe ou clé privée)</p>
          <CopyLine value={example} label="Copier l'exemple" />
        </div>
        {error && (
          <div className="px-5 pt-4">
            <ErrorBox message={error} />
          </div>
        )}
        {apps && apps.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={AppWindow}
              title="Aucune application"
              action={
                <Button variant="outline" onClick={() => setEditing(null)}>
                  <Plus /> Créer une application
                </Button>
              }
            >
              Créez une application pour qu'un script récupère un secret sans compte utilisateur.
            </EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Nom</TableHead>
                <TableHead>Clé</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Comptes</TableHead>
                <TableHead>IP autorisées</TableHead>
                <TableHead>Expire</TableHead>
                <TableHead>Dernière utilisation</TableHead>
                <TableHead className="pr-5">
                  <span className="sr-only">Gestion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!apps ? (
                <TableSkeleton cols={8} rows={2} />
              ) : (
                <AnimatePresence initial={false}>
                  {apps.map((a) => {
                    const st = appState(a);
                    return (
                      <motion.tr key={a.id} layout exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="border-b hover:bg-muted/50">
                        <TableCell className="py-2 pl-5">
                          <p className="font-medium">{a.name}</p>
                          {a.description && <p className="truncate text-xs text-muted-foreground">{a.description}</p>}
                        </TableCell>
                        <TableCell className="py-2 font-mono text-xs text-muted-foreground">cap_{a.key_prefix}_...</TableCell>
                        <TableCell className="py-2">
                          <Chip tone={st.tone}>{st.label}</Chip>
                        </TableCell>
                        <TableCell className="py-2 font-mono text-xs">{a.accounts.join(", ")}</TableCell>
                        <TableCell className="py-2 font-mono text-xs">
                          {a.allowed_ips.length > 0 ? a.allowed_ips.join(", ") : <Chip tone="orange">Toutes</Chip>}
                        </TableCell>
                        <TableCell className="tabular py-2 text-xs text-muted-foreground">
                          {a.expires_at ? formatDate(a.expires_at) : "jamais"}
                        </TableCell>
                        <TableCell className="tabular py-2 text-xs text-muted-foreground">
                          {a.last_used_at ? (
                            <>
                              {formatDate(a.last_used_at)}
                              {a.last_used_ip && <span className="block font-mono">{a.last_used_ip}</span>}
                            </>
                          ) : (
                            "jamais"
                          )}
                        </TableCell>
                        <TableCell className="py-1.5 pr-5">
                          <div className="flex items-center justify-end gap-1">
                            <RowAction label="Modifier" onClick={() => setEditing(a)}>
                              <Pencil />
                            </RowAction>
                            <RowAction label="Changer la clé" onClick={() => setRotating(a)}>
                              <RefreshCw />
                            </RowAction>
                            <RowAction label="Supprimer" danger onClick={() => setRemoving(a)}>
                              <Trash2 />
                            </RowAction>
                          </div>
                        </TableCell>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        )}
      </SettingsCard>

      {editing !== undefined && (
        <AppModal
          app={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(created) => {
            setEditing(undefined);
            if (created) setShown(created);
            load();
          }}
        />
      )}
      {shown && <KeyOnceModal app={shown} onClose={() => setShown(null)} />}
      {rotating && (
        <ConfirmModal
          title={`Changer la clé de ${rotating.name}`}
          confirmLabel="Changer la clé"
          danger
          loading={busy}
          onConfirm={rotate}
          onClose={() => setRotating(null)}
        >
          <p>
            L'ancienne clé <span className="font-mono text-foreground">cap_{rotating.key_prefix}_...</span> cesse de
            fonctionner immédiatement. La nouvelle sera affichée une seule fois.
          </p>
        </ConfirmModal>
      )}
      {removing && (
        <ConfirmModal
          title={`Supprimer l'application ${removing.name}`}
          confirmLabel="Supprimer l'application"
          danger
          loading={busy}
          onConfirm={remove}
          onClose={() => setRemoving(null)}
        >
          <p>Sa clé cesse de fonctionner immédiatement. Les lectures passées restent dans le journal d'audit.</p>
        </ConfirmModal>
      )}
    </>
  );
}
