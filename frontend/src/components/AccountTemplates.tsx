// Account templates and push (lot 7): describe a system account once, then create
// it on a selection of servers as a job (followed in Tâches).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Send, Trash2, UserPlus } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type AccountTemplateData,
  type AccountTemplateInput,
  type JobData,
  type JobSelector,
  type TemplateOsScope,
  type TemplateSecretType,
  type TemplateSudo,
} from "@/services/types";
import { Chip, ConfirmModal, EmptyState, ErrorBox, Field, Modal, SaveButton, Toggle } from "@/components/kit";
import { TableSkeleton } from "@/components/auditUi";
import { RowAction } from "@/components/AccountsSection";
import { TargetFields, TargetPreviewPanel, useTargetPreview } from "@/components/NewJobDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const OS_LABELS: Record<TemplateOsScope, string> = { any: "Linux et Windows", linux: "Linux", windows: "Windows" };
const SECRET_LABELS: Record<TemplateSecretType, string> = {
  password: "Mot de passe",
  ssh_key: "Clé SSH",
  cert: "Certificat éphémère",
};
const SUDO_LABELS: Record<TemplateSudo, string> = {
  none: "Pas de sudo",
  password: "sudo avec mot de passe",
  nopasswd: "sudo sans mot de passe",
};

const EMPTY: AccountTemplateInput = {
  name: "",
  description: null,
  username: "",
  os_scope: "linux",
  secret_type: "password",
  password_length: 24,
  privileged: false,
  sudo: "none",
  groups: [],
  rotation_enabled: false,
  rotation_interval_days: 30,
};

function TemplateModal({
  template,
  onClose,
  onSaved,
}: {
  template: AccountTemplateData | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<AccountTemplateInput>(() => (template ? { ...template } : { ...EMPTY }));
  const [groupsText, setGroupsText] = useState((template?.groups || []).join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof AccountTemplateInput>(k: K, v: AccountTemplateInput[K]) => setF((x) => ({ ...x, [k]: v }));

  const windowsOnly = f.os_scope === "windows";
  const setOs = (v: TemplateOsScope) =>
    setF((x) => ({
      ...x,
      os_scope: v,
      // Windows: password only, no sudo (the backend refuses otherwise)
      ...(v === "windows" ? { secret_type: "password" as const, sudo: "none" as const } : {}),
    }));

  const save = async () => {
    setLoading(true);
    setError(null);
    const body: AccountTemplateInput = {
      ...f,
      name: f.name.trim(),
      username: f.username.trim(),
      description: f.description?.trim() || null,
      groups: groupsText
        .split(/[,\n]/)
        .map((g) => g.trim())
        .filter(Boolean),
    };
    try {
      if (template) await api.patch(`/api/account-templates/${template.id}`, body);
      else await api.post("/api/account-templates", body);
      toast.success(template ? "Modèle enregistré" : "Modèle créé");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title={template ? `Modifier le modèle ${template.name}` : "Nouveau modèle de compte"}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!f.name.trim() || !f.username.trim()}>
            {template ? "Enregistrer le modèle" : "Créer le modèle"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nom du modèle">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Compte d'exploitation" autoFocus />
        </Field>
        <Field label="Nom du compte" hint="Minuscules, chiffres, _ et - pour Linux. Comptes système refusés.">
          <Input value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="svc-exploit" className="font-mono" />
        </Field>
      </div>
      <Field label="Description">
        <Input value={f.description || ""} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Systèmes">
          <Select value={f.os_scope} onValueChange={(v) => setOs(v as TemplateOsScope)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(OS_LABELS) as TemplateOsScope[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {OS_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Secret" hint={windowsOnly ? "Sous Windows, mot de passe seulement." : undefined}>
          <Select value={f.secret_type} onValueChange={(v) => set("secret_type", v as TemplateSecretType)} disabled={windowsOnly}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SECRET_LABELS) as TemplateSecretType[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SECRET_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Longueur du mot de passe" hint="De 16 à 64 caractères.">
          <Input
            type="number"
            min={16}
            max={64}
            value={f.password_length}
            onChange={(e) => set("password_length", Math.min(64, Math.max(16, parseInt(e.target.value) || 16)))}
            disabled={f.secret_type !== "password"}
            className="tabular font-mono"
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="sudo (Linux)" hint="Règle dans /etc/sudoers.d, vérifiée par visudo.">
          <Select value={f.sudo} onValueChange={(v) => set("sudo", v as TemplateSudo)} disabled={windowsOnly}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SUDO_LABELS) as TemplateSudo[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SUDO_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Groupes" hint="Séparés par des virgules (ex. docker, Remote Desktop Users).">
          <Input value={groupsText} onChange={(e) => setGroupsText(e.target.value)} placeholder="adm, docker" className="font-mono" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Toggle checked={f.privileged} onChange={(v) => set("privileged", v)} label="Compte à privilèges" />
        <Toggle
          checked={f.rotation_enabled}
          onChange={(v) => set("rotation_enabled", v)}
          disabled={f.secret_type !== "password"}
          label="Rotation automatique"
        />
        {f.rotation_enabled && f.secret_type === "password" && (
          <label className="flex items-center gap-2 text-sm">
            tous les
            <Input
              type="number"
              min={1}
              max={365}
              value={f.rotation_interval_days}
              onChange={(e) => set("rotation_interval_days", Math.min(365, Math.max(1, parseInt(e.target.value) || 1)))}
              className="tabular h-8 w-20 font-mono"
            />
            jours
          </label>
        )}
      </div>
    </Modal>
  );
}

function PushDialog({ template, onClose }: { template: AccountTemplateData; onClose: () => void }) {
  const navigate = useNavigate();
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [parallelism, setParallelism] = useState(5);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selector: JobSelector = useMemo(
    () => ({ server_ids: serverIds, node_ids: nodeIds, labels, account: null }),
    [serverIds, nodeIds, labels],
  );
  const { hasSelection, preview, previewing, previewError } = useTargetPreview(selector);
  const allowed = preview?.filter((p) => p.allowed) || [];
  const excluded = preview?.filter((p) => !p.allowed) || [];

  const push = async () => {
    setLaunching(true);
    setError(null);
    try {
      const job = await api.post<JobData>(`/api/account-templates/${template.id}/push`, {
        selector,
        update_existing: updateExisting,
        parallelism,
      });
      navigate(`/jobs/${job.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setLaunching(false);
    }
  };

  return (
    <Modal
      title={`Pousser le compte ${template.username}`}
      description="Le compte est créé sur chaque serveur avec son compte par défaut (droits root ou administrateur requis), puis Citadel vérifie la connexion avant de l'enregistrer. Le secret n'est jamais affiché."
      size="3xl"
      onClose={launching ? () => {} : onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={launching}>
            Annuler
          </Button>
          <Button onClick={push} disabled={!hasSelection || allowed.length === 0 || launching}>
            {launching ? <Loader2 className="animate-spin" /> : <Send />}
            {allowed.length > 0 ? `Pousser sur ${allowed.length} serveur${allowed.length > 1 ? "s" : ""}` : "Pousser"}
          </Button>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-sm text-muted-foreground">
        Modèle <span className="font-medium text-foreground">{template.name}</span> : {OS_LABELS[template.os_scope]},{" "}
        {SECRET_LABELS[template.secret_type].toLowerCase()}
        {template.sudo !== "none" && `, ${SUDO_LABELS[template.sudo]}`}
        {template.groups.length > 0 && (
          <>
            , groupes <span className="font-mono">{template.groups.join(", ")}</span>
          </>
        )}
        .
      </p>
      <TargetFields
        serverIds={serverIds}
        nodeIds={nodeIds}
        labels={labels}
        onServerIds={setServerIds}
        onNodeIds={setNodeIds}
        onLabels={setLabels}
      />
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <Checkbox checked={updateExisting} onCheckedChange={(v) => setUpdateExisting(v === true)} className="mt-0.5" />
          <span>
            Mettre à jour les comptes déjà gérés
            <span className="block text-xs text-muted-foreground">
              Sinon, un serveur où Citadel gère déjà ce compte est ignoré. Avec cette option, un nouveau secret est posé.
            </span>
          </span>
        </label>
        <Field label="Parallélisme" hint="Serveurs traités en même temps (1 à 20).">
          <Input
            type="number"
            min={1}
            max={20}
            value={parallelism}
            onChange={(e) => setParallelism(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
            className="tabular w-24 font-mono"
          />
        </Field>
      </div>
      <TargetPreviewPanel
        hasSelection={hasSelection}
        loading={previewing}
        error={previewError}
        allowed={allowed}
        excluded={excluded}
      />
    </Modal>
  );
}

export default function AccountTemplatesPanel() {
  const [templates, setTemplates] = useState<AccountTemplateData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountTemplateData | null | undefined>(undefined);
  const [pushing, setPushing] = useState<AccountTemplateData | null>(null);
  const [removing, setRemoving] = useState<AccountTemplateData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<AccountTemplateData[]>("/api/account-templates")
      .then((t) => {
        setTemplates(t);
        setError(null);
      })
      .catch((e) => {
        setTemplates((t) => t ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/api/account-templates/${removing.id}`);
      toast.success(`Modèle ${removing.name} supprimé`);
      setTemplates((t) => (t || []).filter((x) => x.id !== removing.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Un modèle décrit un compte système. « Pousser » le crée sur une sélection de serveurs, en tâche suivie dans
          Tâches. Les comptes déjà poussés restent si le modèle est supprimé.
        </p>
        <Button onClick={() => setEditing(null)}>
          <Plus /> Nouveau modèle
        </Button>
      </div>
      <ErrorBox message={error} />

      {templates && templates.length === 0 && !error ? (
        <EmptyState
          icon={UserPlus}
          title="Aucun modèle de compte"
          action={
            <Button variant="outline" onClick={() => setEditing(null)}>
              <Plus /> Créer un modèle
            </Button>
          }
        >
          Créez un modèle pour déployer le même compte sur plusieurs serveurs.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Modèle</TableHead>
                <TableHead>Compte</TableHead>
                <TableHead>Systèmes</TableHead>
                <TableHead>Secret</TableHead>
                <TableHead>Droits</TableHead>
                <TableHead>Rotation</TableHead>
                <TableHead className="pr-4">
                  <span className="sr-only">Gestion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!templates ? (
                <TableSkeleton cols={7} rows={3} />
              ) : (
                <AnimatePresence initial={false}>
                  {templates.map((t) => (
                    <motion.tr key={t.id} layout exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="h-11 border-b hover:bg-muted/50">
                      <TableCell className="pl-4">
                        <p className="font-medium">{t.name}</p>
                        {t.description && <p className="truncate text-xs text-muted-foreground">{t.description}</p>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{t.username}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{OS_LABELS[t.os_scope]}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {SECRET_LABELS[t.secret_type]}
                        {t.secret_type === "password" && <span className="tabular"> ({t.password_length})</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {t.privileged && <Chip tone="amber">Privilégié</Chip>}
                          {t.sudo !== "none" && <Chip>{t.sudo === "nopasswd" ? "sudo sans mot de passe" : "sudo"}</Chip>}
                          {t.groups.map((g) => (
                            <Chip key={g}>
                              <span className="font-mono">{g}</span>
                            </Chip>
                          ))}
                          {!t.privileged && t.sudo === "none" && t.groups.length === 0 && (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-xs text-muted-foreground">
                        {t.rotation_enabled ? `tous les ${t.rotation_interval_days} j` : "non"}
                      </TableCell>
                      <TableCell className="py-1.5 pr-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => setPushing(t)}>
                            <Send /> Pousser
                          </Button>
                          <RowAction label="Modifier" onClick={() => setEditing(t)}>
                            <Pencil />
                          </RowAction>
                          <RowAction label="Supprimer" danger onClick={() => setRemoving(t)}>
                            <Trash2 />
                          </RowAction>
                        </div>
                      </TableCell>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {editing !== undefined && (
        <TemplateModal
          template={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
      {pushing && <PushDialog template={pushing} onClose={() => setPushing(null)} />}
      {removing && (
        <ConfirmModal
          title={`Supprimer le modèle ${removing.name}`}
          confirmLabel="Supprimer le modèle"
          danger
          loading={busy}
          onConfirm={remove}
          onClose={() => setRemoving(null)}
        >
          <p>Les comptes déjà poussés sur les serveurs sont conservés et restent gérés par Citadel.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
