// "Rapports" (lot 6): users, servers and accounts over a period, printable (PDF via
// the browser) or as CSV. Each consultation is audited server side (report.view),
// so a report is generated on demand, never on every filter change.
import { useState } from "react";
import { createPortal } from "react-dom";
import { Navigate } from "react-router-dom";
import { Download, FileBarChart, Loader2, Play, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, fetchBlob, saveBlob } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type ReportData, type ReportKind, type ReportValue } from "@/services/types";
import { EmptyState, ErrorBox, Field, PageHeader, formatDate } from "@/components/kit";
import { TableSkeleton } from "@/components/auditUi";

interface Column {
  key: string;
  label: string;
  kind?: "number" | "bool" | "date" | "mono";
  /** Value labels for enumerations. */
  values?: Record<string, string>;
  /** Highlight a non-zero count or a failure on screen (colour = state). */
  alert?: (v: ReportValue) => boolean;
}

const ROLE_LABELS: Record<string, string> = { admin: "Administrateur", operator: "Opérateur", viewer: "Lecteur" };
const OS_LABELS: Record<string, string> = { linux: "Linux", windows: "Windows" };
const STATUS_LABELS: Record<string, string> = { online: "En ligne", offline: "Hors ligne", unknown: "Inconnu" };
const CHECK_LABELS: Record<string, string> = {
  ok: "Réussie",
  success: "Réussie",
  failed: "Échec",
  error: "Erreur",
  unknown: "Non vérifié",
};
const positive = (v: ReportValue) => typeof v === "number" && v > 0;
const failed = (v: ReportValue) => v === "failed" || v === "error";

const REPORTS: Record<ReportKind, { label: string; description: string; usesPeriod: boolean; columns: Column[] }> = {
  users: {
    label: "Utilisateurs",
    description: "Rôle, dernière connexion, connexions, sessions, commandes et appareils actifs de chaque utilisateur.",
    usesPeriod: true,
    columns: [
      { key: "user", label: "Utilisateur" },
      { key: "email", label: "E-mail" },
      { key: "role", label: "Rôle", values: ROLE_LABELS },
      { key: "active", label: "Actif", kind: "bool" },
      { key: "last_login", label: "Dernière connexion", kind: "date" },
      { key: "logins", label: "Connexions", kind: "number" },
      { key: "logins_denied", label: "Connexions refusées", kind: "number", alert: positive },
      { key: "sessions", label: "Sessions", kind: "number" },
      { key: "commands", label: "Commandes", kind: "number" },
      { key: "commands_blocked", label: "Commandes bloquées", kind: "number", alert: positive },
      { key: "devices", label: "Appareils actifs", kind: "number" },
    ],
  },
  servers: {
    label: "Serveurs",
    description: "Sessions, utilisateurs distincts, commandes, transferts de fichiers et comptes de chaque serveur.",
    usesPeriod: true,
    columns: [
      { key: "server", label: "Serveur", kind: "mono" },
      { key: "ip", label: "IP", kind: "mono" },
      { key: "os", label: "Système", values: OS_LABELS },
      { key: "status", label: "État", values: STATUS_LABELS },
      { key: "sessions", label: "Sessions", kind: "number" },
      { key: "users", label: "Utilisateurs", kind: "number" },
      { key: "commands", label: "Commandes", kind: "number" },
      { key: "commands_blocked", label: "Commandes bloquées", kind: "number", alert: positive },
      { key: "file_transfers", label: "Transferts de fichiers", kind: "number" },
      { key: "accounts", label: "Comptes", kind: "number" },
    ],
  },
  accounts: {
    label: "Comptes",
    description: "Secret, rotation, âge du secret et dernière vérification de chaque compte, à la date du jour.",
    usesPeriod: false,
    columns: [
      { key: "server", label: "Serveur", kind: "mono" },
      { key: "account", label: "Compte", kind: "mono" },
      { key: "privileged", label: "Privilégié", kind: "bool" },
      { key: "default", label: "Par défaut", kind: "bool" },
      { key: "active", label: "Actif", kind: "bool" },
      { key: "secret", label: "Secret" },
      { key: "rotation", label: "Rotation", kind: "bool" },
      { key: "rotation_days", label: "Rotation (jours)", kind: "number" },
      { key: "last_rotation", label: "Dernière rotation", kind: "date" },
      { key: "last_rotation_status", label: "Résultat de la rotation", values: CHECK_LABELS, alert: failed },
      { key: "secret_age_days", label: "Âge du secret (jours)", kind: "number" },
      { key: "verify_status", label: "Vérification", values: CHECK_LABELS, alert: failed },
      { key: "last_verified", label: "Dernière vérification", kind: "date" },
    ],
  },
};

const KINDS = Object.keys(REPORTS) as ReportKind[];

function cellText(col: Column, v: ReportValue): string {
  if (v === null || v === undefined || v === "") return "-";
  if (col.kind === "bool" || typeof v === "boolean") return v ? "oui" : "non";
  if (col.kind === "date") return formatDate(String(v));
  if (col.values) return col.values[String(v)] ?? String(v);
  return String(v);
}

/** yyyy-mm-dd in local time, for <input type="date">. */
function dayValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: dayValue(from), to: dayValue(to) };
}

function ReportTable({ report, print = false }: { report: ReportData; print?: boolean }) {
  const columns = REPORTS[report.kind]?.columns ?? Object.keys(report.rows[0] || {}).map((key) => ({ key, label: key }));
  return (
    <Table className={cn(print && "text-xs")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((c, i) => (
            <TableHead
              key={c.key}
              className={cn(
                "whitespace-nowrap",
                c.kind === "number" && "text-right",
                i === 0 && "pl-4",
                i === columns.length - 1 && "pr-4",
                print && "h-7 px-1.5 text-foreground",
              )}
            >
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.rows.map((row, r) => (
          <TableRow key={r} className={cn(print && "break-inside-avoid hover:bg-transparent")}>
            {columns.map((c, i) => {
              const v = row[c.key] ?? null;
              return (
                <TableCell
                  key={c.key}
                  className={cn(
                    "whitespace-nowrap py-2",
                    c.kind === "number" && "tabular text-right",
                    (c.kind === "mono" || (c.kind === undefined && c.key === "email")) && "font-mono text-xs",
                    c.kind === "date" && "tabular text-muted-foreground",
                    i === 0 && "pl-4",
                    i === columns.length - 1 && "pr-4",
                    !print && c.alert?.(v) && "font-medium text-danger",
                    print && "px-1.5 py-1",
                  )}
                >
                  {cellText(c, v)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReportHeading({ report, usesPeriod }: { report: ReportData; usesPeriod: boolean }) {
  return (
    <div className="space-y-0.5">
      <h2 className="text-xl font-semibold tracking-tight">{report.title}</h2>
      <p className="text-sm text-muted-foreground">
        {usesPeriod ? (
          <>
            Du <span className="tabular">{formatDate(report.from, false)}</span> au{" "}
            <span className="tabular">{formatDate(report.to, false)}</span>.{" "}
          </>
        ) : null}
        Généré le <span className="tabular">{formatDate(report.generated_at)}</span> par {report.generated_by}.{" "}
        <span className="tabular">{report.rows.length}</span> ligne{report.rows.length !== 1 ? "s" : ""}.
      </p>
    </div>
  );
}

export default function Reports() {
  const { can, loading: userLoading } = useCurrentUser();
  const isAdmin = can("audit");
  const [kind, setKind] = useState<ReportKind>("users");
  const [range, setRange] = useState(defaultRange);
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = REPORTS[kind];

  const query = (format: "json" | "csv") => {
    const qs = new URLSearchParams();
    if (def.usesPeriod) {
      if (range.from) qs.set("date_from", new Date(`${range.from}T00:00:00`).toISOString());
      if (range.to) qs.set("date_to", new Date(`${range.to}T23:59:59.999`).toISOString());
    }
    if (format === "csv") qs.set("format", "csv");
    return qs;
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.get<ReportData>(`/api/reports/${kind}?${query("json")}`));
    } catch (e) {
      setReport(null);
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      const blob = await fetchBlob(`/api/reports/${kind}?${query("csv")}`);
      saveBlob(blob, `citadel-rapport-${kind}-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      setError(`Export impossible : ${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  };

  if (userLoading) return null;
  if (!isAdmin) return <Navigate to="/" replace />;

  const shown = report && report.kind === kind ? report : null;
  const invalidRange = def.usesPeriod && !!range.from && !!range.to && range.from > range.to;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rapports"
        description="Synthèse des utilisateurs, des serveurs et des comptes sur une période, à imprimer en PDF ou à exporter en CSV."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting || invalidRange}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              Exporter en CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!shown}>
              <Printer /> Imprimer / PDF
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div className="w-48">
          <Field label="Rapport">
            <Select value={kind} onValueChange={(v) => setKind(v as ReportKind)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {REPORTS[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {def.usesPeriod && (
          <>
            <Field label="Du">
              <Input
                type="date"
                value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="tabular w-auto"
              />
            </Field>
            <Field label="Au">
              <Input
                type="date"
                value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="tabular w-auto"
              />
            </Field>
          </>
        )}
        <Button onClick={generate} disabled={loading || invalidRange}>
          {loading ? <Loader2 className="animate-spin" /> : <Play />}
          Générer le rapport
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          {def.description}
          {def.usesPeriod ? " Période par défaut : les 30 derniers jours." : ""} Chaque consultation est tracée dans le
          journal d'audit.
        </p>
      </div>

      <ErrorBox message={invalidRange ? "La date de début doit précéder la date de fin." : error} />

      {loading && !shown ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableBody>
              <TableSkeleton cols={Math.min(def.columns.length, 8)} rows={6} />
            </TableBody>
          </Table>
        </div>
      ) : !shown ? (
        <EmptyState icon={FileBarChart} title="Aucun rapport généré">
          Choisissez un rapport{def.usesPeriod ? " et une période" : ""}, puis générez-le.
        </EmptyState>
      ) : (
        <>
          <ReportHeading report={shown} usesPeriod={def.usesPeriod} />
          {shown.rows.length === 0 ? (
            <EmptyState icon={FileBarChart} title="Rapport vide">
              Aucune donnée sur cette période.
            </EmptyState>
          ) : (
            <div className={cn("overflow-hidden rounded-lg border bg-card", loading && "opacity-60")}>
              <ReportTable report={shown} />
            </div>
          )}
          {/* Print-only copy, outside the app shell (see .citadel-print in index.css) */}
          {createPortal(
            <div className="citadel-print">
              <ReportHeading report={shown} usesPeriod={def.usesPeriod} />
              <div className="mt-4">
                <ReportTable report={shown} print />
              </div>
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
