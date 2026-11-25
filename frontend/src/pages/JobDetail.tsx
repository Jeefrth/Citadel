// Job detail: per-target result, Ansible log, cancel while running. Polls every 2 s while active.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, ChevronRight, CircleStop, ListChecks, Loader2 } from "lucide-react";
import { ApiError, api } from "@/services/api";
import { errorMessage, type AccountTemplateData, type JobDetail as JobDetailData, type JobTarget, type PlaybookData } from "@/services/types";
import { Chip, ConfirmModal, EmptyState, ErrorBox, PageHeader, formatDate } from "@/components/kit";
import { JOB_KIND, JobStatusChip, TargetStatusChip, durationBetween, isJobActive, targetsSummary } from "@/components/opsUi";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [playbook, setPlaybook] = useState<PlaybookData | null>(null);
  const [template, setTemplate] = useState<AccountTemplateData | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      setJob(await api.get<JobDetailData>(`/api/jobs/${jobId}`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(errorMessage(e));
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  const active = !!job && isJobActive(job.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [active, load]);

  // Playbook name, owner name (admins see everyone's jobs)
  useEffect(() => {
    if (!job?.playbook_id || playbook) return;
    api
      .get<PlaybookData[]>("/api/playbooks")
      .then((list) => setPlaybook(list.find((p) => p.id === job.playbook_id) || null))
      .catch(() => {});
  }, [job?.playbook_id, playbook]);
  // Account push: the template, when the user may read templates ("secrets")
  const templateId = job?.kind === "push" ? String(job.extra_vars?.template_id ?? "") : "";
  useEffect(() => {
    if (!templateId || template) return;
    api
      .get<AccountTemplateData[]>("/api/account-templates")
      .then((list) => setTemplate(list.find((t) => t.id === templateId) || null))
      .catch(() => {});
  }, [templateId, template]);
  const owner = job?.user_name || null;
  const kindInfo = job ? JOB_KIND[job.kind] : null;

  const cancel = async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      setJob(await api.post<JobDetailData>(`/api/jobs/${jobId}/cancel`, {}));
      toast.success("Tâche annulée");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  };

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const back = (
    <Button variant="ghost" size="sm" onClick={() => navigate("/jobs")} className="-ml-2 mb-2 text-muted-foreground">
      <ArrowLeft /> Tâches
    </Button>
  );

  if (notFound) {
    return (
      <div>
        {back}
        <EmptyState
          icon={ListChecks}
          title="Tâche introuvable"
          action={
            <Button variant="outline" onClick={() => navigate("/jobs")}>
              Revenir aux tâches
            </Button>
          }
        >
          Elle a peut-être été lancée par un autre utilisateur : seuls les administrateurs et les auditeurs voient toutes les tâches.
        </EmptyState>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="space-y-6">
        {back}
        <ErrorBox message={error} />
        <div className="space-y-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div>
      {back}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {job.name}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={job.status}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.18 }}
                className="flex"
              >
                <JobStatusChip status={job.status} />
              </motion.span>
            </AnimatePresence>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1">
              {kindInfo && <kindInfo.icon className="size-3.5" />}
              {job.kind === "playbook" ? `Playbook ${playbook?.name ?? ""}` : kindInfo?.label ?? job.kind}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular">Lancée le {formatDate(job.created_at)}</span>
            {owner && (
              <>
                <span aria-hidden>·</span>
                <span>par {owner}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span className="tabular">{durationBetween(job.started_at, job.finished_at)}</span>
            <span aria-hidden>·</span>
            <span className="tabular">{targetsSummary(job)}</span>
          </span>
        }
        actions={
          active ? (
            <Button variant="destructive" onClick={() => setConfirmCancel(true)} disabled={cancelling}>
              {cancelling ? <Loader2 className="animate-spin" /> : <CircleStop />}
              Annuler la tâche
            </Button>
          ) : null
        }
      />

      <div className="space-y-6">
        <ErrorBox message={error} />

        {job.kind === "command" && job.command && (
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-4 py-3 font-mono text-xs">{job.command}</pre>
        )}
        <p className="tabular -mt-3 text-xs text-muted-foreground">
          Parallélisme {job.parallelism} · délai {job.timeout} s
          {job.kind === "push" && (
            <>
              {" "}
              · modèle{" "}
              {template ? (
                <>
                  {template.name} (compte <span className="font-mono">{template.username}</span>)
                </>
              ) : (
                <span className="font-mono">{templateId.slice(0, 8) || "-"}</span>
              )}
              {job.extra_vars?.update_existing ? " · comptes déjà gérés mis à jour" : " · comptes déjà gérés ignorés"}
            </>
          )}
          {job.selector?.account && (
            <>
              {" "}
              · compte <span className="font-mono">{job.selector.account}</span>
            </>
          )}
        </p>

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-sm font-medium">Serveurs</h2>
            <span className="tabular text-xs text-muted-foreground">
              {job.target_count} cible{job.target_count > 1 ? "s" : ""}
            </span>
          </div>
          {job.targets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Aucune cible.</p>
          ) : (
            <ul className="divide-y">
              {job.targets.map((t) => (
                <TargetRow key={t.id} target={t} open={expanded.has(t.id)} onToggle={() => toggle(t.id)} />
              ))}
            </ul>
          )}
        </section>

        {job.kind === "playbook" && <AnsibleLog output={job.output} live={active} />}
      </div>

      {confirmCancel && (
        <ConfirmModal
          title="Annuler la tâche"
          confirmLabel="Annuler la tâche"
          danger
          loading={cancelling}
          onClose={() => setConfirmCancel(false)}
          onConfirm={cancel}
        >
          <p>Les serveurs pas encore traités sont abandonnés. Une commande déjà lancée sur un serveur peut aller à son terme.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

function TargetRow({ target: t, open, onToggle }: { target: JobTarget; open: boolean; onToggle: () => void }) {
  const hasOutput = !!(t.stdout || t.stderr);
  const expandable = hasOutput || !!t.message;
  return (
    <motion.li layout="position" transition={{ duration: 0.2 }}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!expandable}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-3 px-4 text-left text-sm transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !expandable && "opacity-0",
          )}
        />
        <span className="w-48 truncate font-medium">{t.server_name}</span>
        <span className="w-28 truncate font-mono text-xs text-muted-foreground">{t.account ?? ""}</span>
        <span className="w-24">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={t.status}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.18 }}
              className="inline-flex"
            >
              <TargetStatusChip status={t.status} />
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="w-20 font-mono text-xs">
          {t.exit_code !== null && (
            <span className={t.exit_code === 0 ? "text-muted-foreground" : "text-danger"}>code {t.exit_code}</span>
          )}
        </span>
        <span className="tabular w-20 text-xs text-muted-foreground">
          {t.started_at ? durationBetween(t.started_at, t.finished_at) : ""}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-right text-xs",
            t.status === "failed" ? "text-danger" : t.status === "skipped" ? "text-live" : "text-muted-foreground",
          )}
        >
          {t.message}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && expandable && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t bg-muted/20 px-4 py-3 pl-11">
              {t.message && (
                <p
                  className={cn(
                    "rounded-md border px-3 py-2 text-xs",
                    t.status === "failed"
                      ? "border-danger/25 bg-danger/10 text-danger"
                      : t.status === "skipped"
                        ? "border-live/25 bg-live/10 text-live"
                        : "text-muted-foreground",
                  )}
                >
                  {t.message}
                </p>
              )}
              {t.stdout && <OutputBlock label="Sortie standard" text={t.stdout} />}
              {t.stderr && <OutputBlock label="Sortie d'erreur" text={t.stderr} danger />}
              {!hasOutput && !t.message && <p className="text-xs text-muted-foreground">Aucune sortie.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function OutputBlock({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
  return (
    <div className="space-y-1">
      <p className={cn("text-xs", danger ? "text-danger" : "text-muted-foreground")}>{label}</p>
      <pre
        className={cn(
          "max-h-72 overflow-auto whitespace-pre rounded-md border bg-background px-3 py-2 font-mono text-xs",
          danger && "border-danger/25",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

/** Ansible log: follows the end while the job runs, unless the reader scrolled up. */
function AnsibleLog({ output, live }: { output: string | null; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [output, live]);
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Journal Ansible</h2>
        {live && (
          <Chip tone="amber">
            <Loader2 className="size-3 animate-spin" /> en cours
          </Chip>
        )}
      </div>
      {output ? (
        <pre
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="max-h-[28rem] overflow-auto whitespace-pre px-4 py-3 font-mono text-xs leading-5"
        >
          {output}
        </pre>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">{live ? "En attente de la sortie d'Ansible." : "Aucune sortie."}</p>
      )}
    </section>
  );
}
