// Jobs (lot 5, E2/E3): commands and playbooks run on several servers.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileCode2, ListChecks, Play, Terminal as TerminalIcon } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type JobData, type PlaybookData, type UserData } from "@/services/types";
import { Chip, EmptyState, ErrorBox, PageHeader, Tabs, formatDate } from "@/components/kit";
import { TableSkeleton } from "@/components/auditUi";
import { JobStatusChip, durationBetween, isJobActive, targetsSummary } from "@/components/opsUi";
import NewJobDialog from "@/components/NewJobDialog";
import PlaybooksPanel from "@/components/PlaybooksPanel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Tab = "jobs" | "playbooks";

export default function Jobs() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "playbooks" ? "playbooks" : "jobs";
  const { user, isAdmin } = useCurrentUser();
  const canLaunch = !!user && user.role !== "viewer";

  const [jobs, setJobs] = useState<JobData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbooks, setPlaybooks] = useState<PlaybookData[] | null>(null);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await api.get<JobData[]>("/api/jobs?limit=100"));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setJobs((j) => j ?? []);
    }
  }, []);

  const loadPlaybooks = useCallback(() => {
    api
      .get<PlaybookData[]>("/api/playbooks")
      .then(setPlaybooks)
      .catch(() => setPlaybooks([]));
  }, []);

  useEffect(() => {
    loadJobs();
    loadPlaybooks();
  }, [loadJobs, loadPlaybooks]);

  // Admins see everyone's jobs: map user ids to names
  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<UserData[]>("/api/admin/users")
      .then((list) => setUsers(Object.fromEntries(list.map((u) => [u.id, u.display_name || u.email]))))
      .catch(() => {});
  }, [isAdmin]);

  // Poll while something runs
  const anyActive = !!jobs?.some((j) => isJobActive(j.status));
  useEffect(() => {
    if (!anyActive || tab !== "jobs") return;
    const t = setInterval(loadJobs, 2000);
    return () => clearInterval(t);
  }, [anyActive, tab, loadJobs]);

  const playbookName = useMemo(
    () => Object.fromEntries((playbooks || []).map((p) => [p.id, p.name])),
    [playbooks],
  );

  return (
    <div>
      <PageHeader
        title="Tâches"
        description="Lancez une commande ou un playbook Ansible sur plusieurs serveurs à la fois et suivez le résultat serveur par serveur."
        actions={
          canLaunch && tab === "jobs" ? (
            <Button onClick={() => setCreating(true)}>
              <Play /> Nouvelle tâche
            </Button>
          ) : null
        }
      />
      <Tabs
        tabs={[
          { id: "jobs", label: "Tâches", icon: ListChecks },
          { id: "playbooks", label: "Playbooks", icon: FileCode2 },
        ]}
        active={tab}
        onChange={(t) => setParams(t === "jobs" ? {} : { tab: t }, { replace: true })}
      />

      {tab === "jobs" ? (
        <>
          <ErrorBox message={error} />
          {jobs && jobs.length === 0 && !error ? (
            <EmptyState
              icon={ListChecks}
              title="Aucune tâche"
              action={
                canLaunch ? (
                  <Button variant="outline" onClick={() => setCreating(true)}>
                    <Play /> Nouvelle tâche
                  </Button>
                ) : undefined
              }
            >
              {canLaunch
                ? "Lancez une commande ou un playbook sur un groupe de serveurs pour commencer."
                : "Les tâches sont lancées par les opérateurs et les administrateurs."}
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Statut</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Nom</TableHead>
                    <TableHead>Cibles</TableHead>
                    {isAdmin && <TableHead>Lancée par</TableHead>}
                    <TableHead>Lancée le</TableHead>
                    <TableHead className="pr-4 text-right">Durée</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!jobs ? (
                    <TableSkeleton cols={isAdmin ? 7 : 6} />
                  ) : (
                    jobs.map((j) => (
                      <TableRow
                        key={j.id}
                        tabIndex={0}
                        onClick={() => navigate(`/jobs/${j.id}`)}
                        onKeyDown={(e) => e.key === "Enter" && navigate(`/jobs/${j.id}`)}
                        className="h-11 cursor-pointer outline-none focus-visible:bg-muted/50"
                      >
                        <TableCell className="pl-4">
                          <JobStatusChip status={j.status} />
                        </TableCell>
                        <TableCell>
                          <Chip>
                            {j.kind === "command" ? <TerminalIcon className="size-3" /> : <FileCode2 className="size-3" />}
                            {j.kind === "command" ? "Commande" : "Playbook"}
                          </Chip>
                        </TableCell>
                        <TableCell className="max-w-sm">
                          <p className="truncate font-medium">{j.name}</p>
                          {j.kind === "command" && j.command && j.command !== j.name && (
                            <p className="truncate font-mono text-xs text-muted-foreground">{j.command}</p>
                          )}
                          {j.kind === "playbook" && j.playbook_id && playbookName[j.playbook_id] && (
                            <p className="truncate text-xs text-muted-foreground">{playbookName[j.playbook_id]}</p>
                          )}
                        </TableCell>
                        <TableCell className="tabular text-xs">{targetsSummary(j)}</TableCell>
                        {isAdmin && (
                          <TableCell className="text-xs text-muted-foreground">{users[j.user_id] || "-"}</TableCell>
                        )}
                        <TableCell className="tabular text-xs text-muted-foreground">{formatDate(j.created_at)}</TableCell>
                        <TableCell className="tabular pr-4 text-right text-xs text-muted-foreground">
                          {durationBetween(j.started_at, j.finished_at)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : (
        <PlaybooksPanel playbooks={playbooks} isAdmin={isAdmin} onChanged={loadPlaybooks} />
      )}

      {creating && (
        <NewJobDialog
          playbooks={playbooks || []}
          onClose={() => setCreating(false)}
          onCreated={(job) => {
            setCreating(false);
            navigate(`/jobs/${job.id}`);
          }}
        />
      )}
    </div>
  );
}
