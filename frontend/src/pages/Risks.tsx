// Audit > Risques (lot 7): findings of the daily risk scan (old secrets, dormant
// users, unrestricted applications...). Colour carries the severity only.
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { CheckCircle2, EyeOff, Loader2, Radar, ShieldAlert, Undo2 } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type RiskItem, type RiskList, type RiskSeverity, type RiskStatus } from "@/services/types";
import { Chip, type ChipTone, EmptyState, ErrorBox, Field, Modal, PageHeader, SaveButton, Tabs, formatDate } from "@/components/kit";
import { TableSkeleton } from "@/components/auditUi";
import { relativeTime } from "@/components/governanceUi";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const SEVERITY: Record<RiskSeverity, { label: string; tone: ChipTone }> = {
  high: { label: "Élevé", tone: "red" },
  medium: { label: "Moyen", tone: "orange" },
  low: { label: "Faible", tone: "default" },
};

const CATEGORY_LABELS: Record<string, string> = {
  secret_old: "Secret ancien",
  no_rotation: "Sans rotation",
  verify_failed: "Vérification en échec",
  no_secret: "Compte sans secret",
  unmanaged_privileged: "Compte privilégié non géré",
  dormant_user: "Utilisateur inactif",
  access_key: "Clé d'accès",
  ssh_key: "Clé SSH",
  application: "Application",
  policy: "Règle d'accès",
};

const STATUSES: RiskStatus[] = ["open", "ignored", "resolved"];

function SeverityChip({ severity }: { severity: RiskSeverity }) {
  const s = SEVERITY[severity] || { label: severity, tone: "default" as ChipTone };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

function IgnoreModal({ risk, onClose, onDone }: { risk: RiskItem; onClose: () => void; onDone: (r: RiskItem) => void }) {
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ignore = async () => {
    setLoading(true);
    setError(null);
    try {
      onDone(await api.post<RiskItem>(`/api/risks/${risk.id}/ignore`, { ignored: true, reason: reason.trim() }));
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Ignorer le risque"
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={ignore} loading={loading} disabled={!reason.trim()}>
            Ignorer le risque
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-sm">{risk.title}</p>
      <Field label="Raison" hint="Obligatoire et journalisée. Le risque ne sera plus signalé tant qu'il reste ignoré.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus placeholder="Compte de secours, secret conservé hors ligne." />
      </Field>
    </Modal>
  );
}

export default function Risks() {
  const { can, isAdmin, loading: userLoading } = useCurrentUser();
  const allowed = can("audit");
  const [params, setParams] = useSearchParams();
  const status: RiskStatus = STATUSES.find((s) => s === params.get("status")) ?? "open";
  const [data, setData] = useState<RiskList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ignoring, setIgnoring] = useState<RiskItem | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<RiskList>(`/api/risks?status=${status}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  if (userLoading) return null;
  if (!allowed) return <Navigate to="/" replace />;

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.post<{ open: number; new: number; resolved: number }>("/api/risks/scan", {});
      toast.success(
        `Analyse terminée : ${r.open} risque${r.open > 1 ? "s" : ""} ouvert${r.open > 1 ? "s" : ""}, ${r.resolved} résolu${r.resolved > 1 ? "s" : ""}`,
      );
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const unignore = async (r: RiskItem) => {
    setRestoring(r.id);
    try {
      await api.post(`/api/risks/${r.id}/ignore`, { ignored: false, reason: null });
      toast.success("Le risque est de nouveau suivi");
      setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== r.id) } : d));
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRestoring(null);
    }
  };

  const counts = data?.counts || {};
  const items = data?.items || [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Risques"
        description="Points faibles détectés chaque jour : secrets anciens ou en échec, comptes inactifs, clés inutilisées, règles trop larges. Un risque corrigé disparaît à l'analyse suivante."
        actions={
          <Button onClick={scan} disabled={scanning}>
            {scanning ? <Loader2 className="animate-spin" /> : <Radar />}
            Analyser maintenant
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {status === "open" &&
          (["high", "medium", "low"] as RiskSeverity[]).map((sev) => (
            <span key={sev} className="flex items-center gap-2">
              <SeverityChip severity={sev} />
              <span className="tabular font-medium">{counts[sev] ?? 0}</span>
            </span>
          ))}
        <span className="text-xs text-muted-foreground">
          Dernière analyse : {data?.last_scan ? `${formatDate(data.last_scan)} (${relativeTime(data.last_scan)})` : "jamais"}
        </span>
      </div>

      <Tabs<RiskStatus>
        tabs={[
          { id: "open", label: "Ouverts", icon: ShieldAlert },
          { id: "ignored", label: "Ignorés", icon: EyeOff },
          { id: "resolved", label: "Résolus", icon: CheckCircle2 },
        ]}
        active={status}
        onChange={(s) => setParams(s === "open" ? {} : { status: s }, { replace: true })}
      />

      <ErrorBox message={error} />

      {!loading && items.length === 0 && !error ? (
        <EmptyState
          icon={status === "open" ? CheckCircle2 : ShieldAlert}
          title={status === "open" ? "Aucun risque ouvert" : status === "ignored" ? "Aucun risque ignoré" : "Aucun risque résolu"}
          action={
            status === "open" ? (
              <Button variant="outline" onClick={scan} disabled={scanning}>
                <Radar /> Analyser maintenant
              </Button>
            ) : undefined
          }
        >
          {status === "open" ? "Lancez une analyse pour vérifier l'état actuel." : undefined}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Gravité</TableHead>
                <TableHead>Catégorie</TableHead>
                <TableHead>Risque</TableHead>
                <TableHead>{status === "resolved" ? "Résolu le" : "Détecté le"}</TableHead>
                <TableHead>{status === "ignored" ? "Ignoré par" : "Vu la dernière fois"}</TableHead>
                <TableHead className="pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={loading && items.length > 0 ? "opacity-60" : undefined}>
              {loading && items.length === 0 ? (
                <TableSkeleton cols={6} />
              ) : (
                <AnimatePresence initial={false}>
                  {items.map((r) => (
                    <motion.tr key={r.id} layout exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="border-b hover:bg-muted/50">
                      <TableCell className="py-2 pl-4">
                        <SeverityChip severity={r.severity} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                        {CATEGORY_LABELS[r.category] || r.category}
                      </TableCell>
                      <TableCell className="max-w-xl py-2">
                        <p className="font-medium">{r.title}</p>
                        {r.detail && <p className="text-xs text-muted-foreground">{r.detail}</p>}
                        {r.ignored && r.ignored_reason && (
                          <p className="text-xs text-muted-foreground">Raison : {r.ignored_reason}</p>
                        )}
                      </TableCell>
                      <TableCell className="tabular whitespace-nowrap py-2 text-xs text-muted-foreground">
                        {formatDate(status === "resolved" ? r.resolved_at : r.first_seen)}
                      </TableCell>
                      <TableCell className="tabular whitespace-nowrap py-2 text-xs text-muted-foreground">
                        {status === "ignored" ? r.ignored_by || "-" : formatDate(r.last_seen)}
                      </TableCell>
                      <TableCell className="py-1.5 pr-4">
                        <div className="flex items-center justify-end gap-2">
                          {r.link && (
                            <Button asChild size="sm" variant="outline">
                              <Link to={r.link}>Ouvrir</Link>
                            </Button>
                          )}
                          {isAdmin && status === "open" && (
                            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setIgnoring(r)}>
                              <EyeOff /> Ignorer
                            </Button>
                          )}
                          {isAdmin && status === "ignored" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground"
                              onClick={() => unignore(r)}
                              disabled={restoring === r.id}
                            >
                              {restoring === r.id ? <Loader2 className="animate-spin" /> : <Undo2 />}
                              Ne plus ignorer
                            </Button>
                          )}
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
      {!isAdmin && status !== "resolved" && (
        <p className="text-xs text-muted-foreground">Seul un administrateur peut ignorer un risque.</p>
      )}

      {ignoring && (
        <IgnoreModal
          risk={ignoring}
          onClose={() => setIgnoring(null)}
          onDone={() => {
            setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== ignoring.id) } : d));
            toast.success("Risque ignoré");
            setIgnoring(null);
            load();
          }}
        />
      )}
    </div>
  );
}
