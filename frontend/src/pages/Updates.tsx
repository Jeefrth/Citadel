import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { api } from "@/services/api";
import { hasAction, type ServerData } from "@/services/types";
import { Chip, ConfirmModal, EmptyState, PageHeader, type ChipTone } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

interface PackageUpdate {
  name: string;
  current_version: string;
  new_version: string;
  severity: string;
  size: string;
}

interface ScanResult {
  server_id: string;
  os_type: string;
  package_manager: string;
  total_updates: number;
  security_updates: number;
  packages: PackageUpdate[];
  error: string | null;
}

interface UpdateJob {
  id: string;
  server_id: string;
  type: string;
  status: string;
  packages_updated?: number;
  output: string | null;
  created_at: string;
  completed_at: string | null;
}

export default function Updates() {
  const [servers, setServers] = useState<ServerData[]>([]);
  const [scans, setScans] = useState<Record<string, ScanResult>>({});
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<UpdateJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmApply, setConfirmApply] = useState<ServerData | null>(null);
  const serverNames = useMemo(() => new Map(servers.map((s) => [s.id, s.name])), [servers]);

  useEffect(() => {
    Promise.all([
      api.get<ServerData[]>("/api/servers/"),
      api.get<UpdateJob[]>("/api/servers/updates/jobs").catch(() => []),
    ])
      .then(([srvs, jbs]) => {
        // Scans and updates run with the server's default account
        setServers(srvs.filter((s) => s.default_account));
        setJobs(jbs);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleScan = async (srv: ServerData) => {
    setScanningId(srv.id);
    try {
      const result = await api.get<ScanResult>(`/api/servers/${srv.id}/updates`);
      setScans((prev) => ({ ...prev, [srv.id]: result }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error";
      setScans((prev) => ({
        ...prev,
        [srv.id]: {
          server_id: srv.id, os_type: srv.os_type,
          package_manager: "unknown", total_updates: 0,
          security_updates: 0, packages: [], error: msg,
        },
      }));
    } finally {
      setScanningId(null);
    }
  };

  const handleScanAll = async () => {
    for (const srv of servers) {
      await handleScan(srv);
    }
  };

  const handleApply = async (srv: ServerData) => {
    setApplyingId(srv.id);
    try {
      await api.post(`/api/servers/${srv.id}/updates/apply`, { packages: null });
      // Re-scan after apply
      await handleScan(srv);
    } catch {
      // Error handled in scan
    } finally {
      setApplyingId(null);
    }
  };

  const totalUpdates = Object.values(scans).reduce((sum, s) => sum + s.total_updates, 0);
  const totalSecurity = Object.values(scans).reduce((sum, s) => sum + s.security_updates, 0);
  const scannedCount = Object.keys(scans).length;
  const compliance =
    scannedCount === 0
      ? null
      : totalUpdates === 0
        ? "100 %"
        : `${Math.round(((servers.length - Object.values(scans).filter((s) => s.total_updates > 0).length) / servers.length) * 100)} %`;

  return (
    <div>
      <PageHeader
        title="Mises à jour"
        description="Scannez les paquets en attente et appliquez les correctifs avec le compte par défaut de chaque serveur."
        actions={
          <Button onClick={handleScanAll} disabled={scanningId !== null || servers.length === 0}>
            <RefreshCw className={scanningId ? "animate-spin" : ""} />
            Scanner tous les serveurs
          </Button>
        }
      />

      {/* Status strip */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm">
        <StripItem label="Serveurs scannés" value={`${scannedCount}/${servers.length}`} />
        <StripItem
          label="Mises à jour disponibles"
          value={totalUpdates}
          tone={totalUpdates > 0 ? "text-live" : undefined}
        />
        <StripItem
          label="Correctifs de sécurité"
          value={totalSecurity}
          tone={totalSecurity > 0 ? "text-danger" : undefined}
          icon={totalSecurity > 0 ? ShieldAlert : undefined}
        />
        <StripItem
          label="Conformité"
          value={compliance ?? "-"}
          tone={compliance === "100 %" ? "text-success" : undefined}
          icon={compliance === "100 %" ? ShieldCheck : undefined}
        />
      </div>

      {loading && (
        <div className="space-y-2 rounded-lg border p-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      )}

      {!loading && servers.length === 0 && (
        <EmptyState icon={Server} title="Aucun serveur à scanner">
          Les scans utilisent le compte par défaut du serveur. Définissez-en un depuis la fiche du serveur.
        </EmptyState>
      )}

      {!loading && servers.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead>Serveur</TableHead>
                <TableHead>Adresse</TableHead>
                <TableHead>Gestionnaire</TableHead>
                <TableHead>État</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((srv) => {
                const scan = scans[srv.id];
                const isExpanded = expandedId === srv.id;
                const canExpand = !!scan && (scan.packages.length > 0 || !!scan.error);
                return (
                  <Fragment key={srv.id}>
                    <TableRow className="h-11">
                      <TableCell className="pl-3">
                        {canExpand && (
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : srv.id)}
                            className="flex text-muted-foreground hover:text-foreground"
                            aria-label={isExpanded ? "Masquer le détail" : "Afficher le détail"}
                          >
                            <motion.span animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.15 }}>
                              <ChevronRight className="size-4" />
                            </motion.span>
                          </button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Link to={`/servers/${srv.id}`} className="font-medium hover:underline">
                          {srv.name}
                        </Link>
                        {srv.node_path && <p className="text-xs text-muted-foreground">{srv.node_path}</p>}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{srv.ip_address}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{srv.os_type}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {scan && !scan.error ? scan.package_manager : "-"}
                      </TableCell>
                      <TableCell>
                        {!scan && <span className="text-xs text-muted-foreground">Non scanné</span>}
                        {scan && !scan.error && (
                          <div className="flex flex-wrap items-center gap-1">
                            {scan.total_updates === 0 ? (
                              <Chip tone="green">
                                <ShieldCheck className="size-3" /> À jour
                              </Chip>
                            ) : (
                              <>
                                <Chip tone="amber">
                                  <span className="tabular">{scan.total_updates}</span> en attente
                                </Chip>
                                {scan.security_updates > 0 && (
                                  <Chip tone="red">
                                    <ShieldAlert className="size-3" />
                                    <span className="tabular">{scan.security_updates}</span> sécurité
                                  </Chip>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {scan?.error && (
                          <Chip tone="red">
                            <AlertTriangle className="size-3" /> Échec du scan
                          </Chip>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <IconAction
                            label="Scanner"
                            onClick={() => handleScan(srv)}
                            disabled={scanningId === srv.id}
                          >
                            {scanningId === srv.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                          </IconAction>
                          {scan && scan.total_updates > 0 && hasAction(srv, "execute") && (
                            <IconAction
                              label="Appliquer les mises à jour"
                              onClick={() => setConfirmApply(srv)}
                              disabled={applyingId === srv.id}
                            >
                              {applyingId === srv.id ? <Loader2 className="animate-spin" /> : <Download />}
                            </IconAction>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && scan && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="bg-muted/30 p-0">
                          {scan.error ? (
                            <p className="px-4 py-3 font-mono text-xs text-danger">{scan.error}</p>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                  <TableHead className="h-8 pl-12">Paquet</TableHead>
                                  <TableHead className="h-8">Installé</TableHead>
                                  <TableHead className="h-8">Disponible</TableHead>
                                  <TableHead className="h-8">Sévérité</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {scan.packages.map((pkg, i) => (
                                  <TableRow key={i} className="h-9">
                                    <TableCell className="pl-12 font-mono text-xs">{pkg.name}</TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                      {pkg.current_version}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">{pkg.new_version}</TableCell>
                                    <TableCell>
                                      <Chip tone={SEVERITY_TONE[pkg.severity] || "default"}>{pkg.severity}</Chip>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Recent jobs */}
      {jobs.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Historique des mises à jour</h2>
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Serveur</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.slice(0, 10).map((job) => (
                  <TableRow key={job.id} className="h-10">
                    <TableCell className="tabular text-xs text-muted-foreground">
                      {new Date(job.created_at).toLocaleString("fr-FR")}
                    </TableCell>
                    <TableCell className="text-sm">{serverNames.get(job.server_id) || "-"}</TableCell>
                    <TableCell>
                      <Chip tone={job.status === "completed" ? "green" : job.status === "failed" ? "red" : "amber"}>
                        {job.status}
                      </Chip>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.type}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {confirmApply && (
        <ConfirmModal
          title={`Appliquer les mises à jour sur ${confirmApply.name}`}
          confirmLabel="Appliquer"
          onClose={() => setConfirmApply(null)}
          onConfirm={() => {
            const srv = confirmApply;
            setConfirmApply(null);
            handleApply(srv);
          }}
        >
          <p>
            Toutes les mises à jour disponibles seront installées sur <strong>{confirmApply.name}</strong>, puis le
            serveur sera scanné à nouveau.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

const SEVERITY_TONE: Record<string, ChipTone> = {
  critical: "red",
  important: "orange",
  moderate: "amber",
  low: "blue",
  unknown: "default",
};

function StripItem({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  tone?: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("tabular flex items-center gap-1 font-semibold", tone)}>
        {Icon && <Icon className="size-3.5 self-center" />}
        {value}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
