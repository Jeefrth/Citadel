// "Nouvelle tâche": command or playbook, targets, live preview of the resolved targets.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, FileCode2, Loader2, Play, Terminal as TerminalIcon, XCircle } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type JobDetail,
  type JobKind,
  type JobSelector,
  type NodeData,
  type PlaybookData,
  type ServerData,
  type TargetPreview,
} from "@/services/types";
import { ErrorBox, Field, Modal, MultiSelect, type Option } from "@/components/kit";
import { parseJsonObject } from "@/components/opsUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export default function NewJobDialog({
  playbooks,
  onClose,
  onCreated,
}: {
  playbooks: PlaybookData[];
  onClose: () => void;
  onCreated: (job: JobDetail) => void;
}) {
  const [kind, setKind] = useState<JobKind>("command");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [playbookId, setPlaybookId] = useState("");
  const [extraVars, setExtraVars] = useState("");
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [account, setAccount] = useState("");
  const [parallelism, setParallelism] = useState(10);
  const [timeout, setTimeoutValue] = useState(60);

  const [servers, setServers] = useState<ServerData[]>([]);
  const [nodes, setNodes] = useState<NodeData[]>([]);
  const [labelMap, setLabelMap] = useState<Record<string, string[]>>({});

  const [preview, setPreview] = useState<TargetPreview[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<ServerData[]>("/api/servers/").then(setServers).catch(() => {});
    api.get<NodeData[]>("/api/nodes").then(setNodes).catch(() => {});
    api.get<Record<string, string[]>>("/api/servers/labels/").then(setLabelMap).catch(() => {});
  }, []);

  const serverOptions: Option[] = useMemo(
    () => servers.map((s) => ({ id: s.id, label: s.name, sub: s.ip_address })),
    [servers],
  );
  const nodeOptions: Option[] = useMemo(
    () => nodes.map((n) => ({ id: n.id, label: n.path, sub: `${n.server_count} serveur${n.server_count > 1 ? "s" : ""}` })),
    [nodes],
  );
  // "key" matches any value, "key=value" one value (same syntax as access rules)
  const labelOptions: Option[] = useMemo(() => {
    const out: Option[] = [];
    Object.entries(labelMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([k, values]) => {
        out.push({ id: k, label: k, sub: "toutes les valeurs" });
        values.forEach((v) => out.push({ id: `${k}=${v}`, label: `${k}=${v}` }));
      });
    return out;
  }, [labelMap]);

  const selector: JobSelector = useMemo(
    () => ({ server_ids: serverIds, node_ids: nodeIds, labels, account: account.trim() || null }),
    [serverIds, nodeIds, labels, account],
  );
  const hasSelection = serverIds.length + nodeIds.length + labels.length > 0;

  // Live preview, debounced
  useEffect(() => {
    if (!hasSelection) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let alive = true;
    setPreviewing(true);
    const t = setTimeout(() => {
      api
        .post<TargetPreview[]>("/api/jobs/preview", selector)
        .then((r) => {
          if (!alive) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e) => alive && setPreviewError(errorMessage(e)))
        .finally(() => alive && setPreviewing(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [selector, hasSelection]);

  const playbook = playbooks.find((p) => p.id === playbookId) || null;
  const [vars, varsError] = parseJsonObject(extraVars);
  const allowed = preview?.filter((p) => p.allowed) || [];
  const excluded = preview?.filter((p) => !p.allowed) || [];

  const valid =
    hasSelection &&
    allowed.length > 0 &&
    (kind === "command" ? command.trim() !== "" : !!playbookId && !varsError) &&
    parallelism >= 1 &&
    parallelism <= 50 &&
    timeout >= 5 &&
    timeout <= 7200;

  const launch = async () => {
    setLaunching(true);
    setError(null);
    try {
      const job = await api.post<JobDetail>("/api/jobs", {
        kind,
        name: name.trim() || null,
        command: kind === "command" ? command : null,
        playbook_id: kind === "playbook" ? playbookId : null,
        extra_vars: kind === "playbook" ? vars || {} : {},
        selector,
        parallelism,
        timeout,
      });
      onCreated(job);
    } catch (e) {
      setError(errorMessage(e));
      setLaunching(false);
    }
  };

  return (
    <Modal
      title="Nouvelle tâche"
      description="Choisissez quoi lancer et sur quels serveurs. Les droits et les règles de chaque serveur s'appliquent."
      size="3xl"
      onClose={launching ? () => {} : onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={launching}>
            Annuler
          </Button>
          <Button onClick={launch} disabled={!valid || launching}>
            {launching ? <Loader2 className="animate-spin" /> : <Play />}
            {allowed.length > 0
              ? `Lancer sur ${allowed.length} serveur${allowed.length > 1 ? "s" : ""}`
              : "Lancer la tâche"}
          </Button>
        </>
      }
    >
      <ErrorBox message={error} />

      <div role="radiogroup" aria-label="Type de tâche" className="inline-flex rounded-md border p-0.5">
        {(
          [
            ["command", "Commande", TerminalIcon],
            ["playbook", "Playbook", FileCode2],
          ] as const
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              "relative flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors",
              kind === k ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {kind === k && (
              <motion.span
                layoutId="job-kind"
                className="absolute inset-0 rounded bg-muted"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <Icon className="relative size-3.5" />
            <span className="relative">{label}</span>
          </button>
        ))}
      </div>

      {kind === "command" ? (
        <Field label="Commande" hint="Exécutée sur chaque serveur comme une commande interactive : droit d'exécution et règles de commandes.">
          <Textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="systemctl status nginx --no-pager"
            className="font-mono text-xs"
          />
        </Field>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Playbook">
            <Select value={playbookId} onValueChange={setPlaybookId}>
              <SelectTrigger>
                <SelectValue placeholder="Choisir un playbook" />
              </SelectTrigger>
              <SelectContent>
                {playbooks.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Aucun playbook. Un administrateur doit en créer un.</p>
                )}
                {playbooks.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {playbook?.description && <p className="text-xs text-muted-foreground">{playbook.description}</p>}
          </Field>
          <Field
            label="Variables (JSON)"
            hint={
              playbook && Object.keys(playbook.variables || {}).length > 0 ? (
                <>
                  Remplacent les variables par défaut :{" "}
                  <span className="font-mono">{JSON.stringify(playbook.variables)}</span>
                </>
              ) : (
                "Facultatif. Objet JSON passé en extra vars."
              )
            }
          >
            <Textarea
              value={extraVars}
              onChange={(e) => setExtraVars(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder='{"version": "1.2.3"}'
              className={cn("font-mono text-xs", varsError && "border-danger/50 focus-visible:ring-danger/50")}
            />
            {varsError && <p className="text-xs text-danger">{varsError}</p>}
          </Field>
        </div>
      )}

      <Field label="Nom" hint="Facultatif. Par défaut, la première ligne de la commande ou le nom du playbook.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Redémarrage nginx front" />
      </Field>

      <div className="space-y-2">
        <p className="text-sm font-medium">Cibles</p>
        <p className="text-xs text-muted-foreground">
          Un serveur est retenu s'il correspond à l'un des critères (serveurs, nœuds avec leurs sous-nœuds, étiquettes).
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Serveurs">
            <MultiSelect options={serverOptions} selected={serverIds} onChange={setServerIds} emptyText="Aucun serveur" />
          </Field>
          <Field label="Nœuds">
            <MultiSelect options={nodeOptions} selected={nodeIds} onChange={setNodeIds} emptyText="Aucun nœud" />
          </Field>
          <Field label="Étiquettes">
            <MultiSelect options={labelOptions} selected={labels} onChange={setLabels} emptyText="Aucune étiquette" />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Compte" hint="Vide = compte par défaut de chaque serveur.">
          <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="root" className="font-mono" />
        </Field>
        <Field label="Parallélisme" hint="Serveurs traités en même temps (1 à 50).">
          <Input
            type="number"
            min={1}
            max={50}
            value={parallelism}
            onChange={(e) => setParallelism(parseInt(e.target.value) || 1)}
            className="tabular font-mono"
          />
        </Field>
        <Field
          label="Délai (secondes)"
          hint={kind === "playbook" ? "De 5 à 7200. Au moins 60 s pour un playbook." : "Par serveur, de 5 à 7200."}
        >
          <Input
            type="number"
            min={5}
            max={7200}
            value={timeout}
            onChange={(e) => setTimeoutValue(parseInt(e.target.value) || 5)}
            className="tabular font-mono"
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

function TargetPreviewPanel({
  hasSelection,
  loading,
  error,
  allowed,
  excluded,
}: {
  hasSelection: boolean;
  loading: boolean;
  error: string | null;
  allowed: TargetPreview[];
  excluded: TargetPreview[];
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
        <p className="text-sm font-medium">Aperçu des cibles</p>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {loading && <Loader2 className="size-3.5 animate-spin" />}
          {hasSelection && (
            <span className="tabular">
              {allowed.length} retenu{allowed.length > 1 ? "s" : ""}
              {excluded.length > 0 && `, ${excluded.length} exclu${excluded.length > 1 ? "s" : ""}`}
            </span>
          )}
        </span>
      </div>
      {!hasSelection ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">Choisissez des serveurs, des nœuds ou des étiquettes.</p>
      ) : error ? (
        <div className="p-3">
          <ErrorBox message={error} />
        </div>
      ) : loading && allowed.length + excluded.length === 0 ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : allowed.length + excluded.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">Aucun serveur ne correspond à ces critères.</p>
      ) : (
        <ul className="max-h-56 divide-y overflow-auto text-sm">
          <AnimatePresence initial={false}>
            {[...allowed, ...excluded].map((t) => (
              <motion.li
                key={t.server_id}
                layout="position"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-center gap-2 px-3 py-1.5"
              >
                {t.allowed ? (
                  <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                ) : (
                  <XCircle className="size-3.5 shrink-0 text-danger" />
                )}
                <span className={cn("font-medium", !t.allowed && "text-muted-foreground")}>{t.server_name}</span>
                <span className="font-mono text-xs text-muted-foreground">{t.ip_address}</span>
                <span className="text-xs text-muted-foreground">{t.os_type === "windows" ? "Windows" : "Linux"}</span>
                {!t.allowed && t.reason && <span className="ml-auto text-right text-xs text-danger">{t.reason}</span>}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
