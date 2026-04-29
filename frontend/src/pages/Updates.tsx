import { useEffect, useState } from "react";
import { api } from "@/services/api";
import {
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Download,
  Loader2,
  Server,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from "lucide-react";

interface ServerData {
  id: string;
  name: string;
  hostname: string;
  ip_address: string;
  os_type: "linux" | "windows";
  credential_id: string | null;
}

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

  useEffect(() => {
    Promise.all([
      api.get<ServerData[]>("/api/servers/"),
      api.get<UpdateJob[]>("/api/servers/updates/jobs").catch(() => []),
    ])
      .then(([srvs, jbs]) => {
        setServers(srvs.filter((s) => s.credential_id));
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
    if (!confirm(`Appliquer toutes les mises à jour sur ${srv.name} ?`)) return;
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

  const severityColor: Record<string, string> = {
    critical: "text-red-600 bg-red-50",
    important: "text-orange-600 bg-orange-50",
    moderate: "text-amber-600 bg-amber-50",
    low: "text-blue-600 bg-blue-50",
    unknown: "text-gray-600 bg-gray-50",
  };

  const totalUpdates = Object.values(scans).reduce((sum, s) => sum + s.total_updates, 0);
  const totalSecurity = Object.values(scans).reduce((sum, s) => sum + s.security_updates, 0);
  const scannedCount = Object.keys(scans).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Mises à jour</h2>
        <button
          onClick={handleScanAll}
          disabled={scanningId !== null}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw size={16} className={scanningId ? "animate-spin" : ""} />
          Scanner tous les serveurs
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-card border rounded-lg p-4 flex items-center gap-3">
          <Server size={20} className="text-blue-500" />
          <div>
            <p className="text-xl font-bold">{scannedCount}/{servers.length}</p>
            <p className="text-xs text-muted-foreground">Serveurs scannés</p>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4 flex items-center gap-3">
          <Download size={20} className="text-amber-500" />
          <div>
            <p className="text-xl font-bold">{totalUpdates}</p>
            <p className="text-xs text-muted-foreground">MAJ disponibles</p>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4 flex items-center gap-3">
          <ShieldAlert size={20} className="text-red-500" />
          <div>
            <p className="text-xl font-bold">{totalSecurity}</p>
            <p className="text-xs text-muted-foreground">MAJ sécurité</p>
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4 flex items-center gap-3">
          {totalUpdates === 0 && scannedCount > 0 ? (
            <ShieldCheck size={20} className="text-green-500" />
          ) : (
            <Shield size={20} className="text-gray-400" />
          )}
          <div>
            <p className="text-xl font-bold">
              {scannedCount === 0
                ? "—"
                : totalUpdates === 0
                  ? "OK"
                  : `${Math.round(((servers.length - Object.values(scans).filter((s) => s.total_updates > 0).length) / servers.length) * 100)}%`}
            </p>
            <p className="text-xs text-muted-foreground">Conformité</p>
          </div>
        </div>
      </div>

      {loading && <p className="text-muted-foreground">Chargement...</p>}

      {!loading && servers.length === 0 && (
        <div className="bg-card border rounded-lg p-12 text-center">
          <RefreshCw size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            Aucun serveur avec credential configuré.
          </p>
        </div>
      )}

      {/* Server list with scan results */}
      {servers.length > 0 && (
        <div className="space-y-3">
          {servers.map((srv) => {
            const scan = scans[srv.id];
            const isExpanded = expandedId === srv.id;

            return (
              <div key={srv.id} className="bg-card border rounded-lg overflow-hidden">
                <div className="flex items-center gap-4 p-4">
                  <Server
                    size={18}
                    className={srv.os_type === "linux" ? "text-green-500" : "text-blue-500"}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{srv.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {srv.ip_address} — {srv.os_type}
                    </p>
                  </div>

                  {/* Scan result summary */}
                  {scan && !scan.error && (
                    <div className="flex items-center gap-3 text-sm">
                      {scan.total_updates === 0 ? (
                        <span className="flex items-center gap-1 text-green-600">
                          <ShieldCheck size={16} /> À jour
                        </span>
                      ) : (
                        <>
                          <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 text-xs">
                            {scan.total_updates} MAJ
                          </span>
                          {scan.security_updates > 0 && (
                            <span className="px-2 py-0.5 rounded bg-red-50 text-red-700 text-xs">
                              {scan.security_updates} sécurité
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {scan?.error && (
                    <span className="flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle size={14} /> Erreur
                    </span>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleScan(srv)}
                      disabled={scanningId === srv.id}
                      className="p-2 rounded hover:bg-accent text-muted-foreground"
                      title="Scanner"
                    >
                      {scanningId === srv.id ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <RefreshCw size={16} />
                      )}
                    </button>
                    {scan && scan.total_updates > 0 && (
                      <button
                        onClick={() => handleApply(srv)}
                        disabled={applyingId === srv.id}
                        className="p-2 rounded hover:bg-accent text-primary"
                        title="Appliquer les MAJ"
                      >
                        {applyingId === srv.id ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Download size={16} />
                        )}
                      </button>
                    )}
                    {scan && scan.packages.length > 0 && (
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : srv.id)}
                        className="p-2 rounded hover:bg-accent text-muted-foreground"
                      >
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* Package list */}
                {isExpanded && scan && scan.packages.length > 0 && (
                  <div className="border-t">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted/50">
                          <th className="text-left p-2 font-medium">Package</th>
                          <th className="text-left p-2 font-medium">Installé</th>
                          <th className="text-left p-2 font-medium">Disponible</th>
                          <th className="text-left p-2 font-medium">Sévérité</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scan.packages.map((pkg, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-2 font-mono">{pkg.name}</td>
                            <td className="p-2 text-muted-foreground font-mono">
                              {pkg.current_version}
                            </td>
                            <td className="p-2 font-mono">{pkg.new_version}</td>
                            <td className="p-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-xs ${
                                  severityColor[pkg.severity] || severityColor.unknown
                                }`}
                              >
                                {pkg.severity}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Error detail */}
                {scan?.error && (
                  <div className="border-t p-3 bg-red-50 text-xs text-red-700">
                    {scan.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent jobs */}
      {jobs.length > 0 && (
        <div className="mt-8">
          <h3 className="font-semibold mb-3">Historique des mises à jour</h3>
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">Date</th>
                  <th className="text-left p-3 font-medium">Statut</th>
                  <th className="text-left p-3 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 10).map((job) => (
                  <tr key={job.id} className="border-b">
                    <td className="p-3 text-xs text-muted-foreground">
                      {new Date(job.created_at).toLocaleString("fr-FR")}
                    </td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          job.status === "completed"
                            ? "bg-green-50 text-green-700"
                            : job.status === "failed"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="p-3 text-xs">{job.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
