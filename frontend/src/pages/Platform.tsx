// Platform console (SaaS phase 2, platform admins): activity per organisation without
// entering each one, and the platform's own journal.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDownUp, Building2, LayoutDashboard, RefreshCw, ScrollText } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { switchOrg } from "@/services/org";
import { errorMessage } from "@/services/types";
import { Chip, EmptyState, ErrorBox, PageHeader, Tabs, formatDate } from "@/components/kit";
import { StatusDot, TableSkeleton, Tip } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface OrgOverview {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  is_default: boolean;
  members: number;
  pending_invitations: number;
  servers: number;
  clusters: number;
  sessions_30d: number;
  last_session_at: string | null;
  live_sessions: number;
  recordings_bytes: number;
  last_activity_at: string | null;
}

interface Overview {
  organisations: OrgOverview[];
  totals: {
    organisations: number;
    active_organisations: number;
    people: number;
    signed_in_sessions: number;
    live_sessions: number;
    servers: number;
    sessions_30d: number;
  };
}

interface PlatformAuditItem {
  id: string;
  timestamp: string;
  action: string;
  status: string | null;
  user: string | null;
  organisation: string | null;
  ip_address: string | null;
  result: string | null;
}

interface PlatformAuditPage {
  total: number;
  items: PlatformAuditItem[];
}

const ACTION_LABELS: Record<string, string> = {
  "org.create": "Organisation créée",
  "org.update": "Organisation modifiée",
  "org.delete": "Organisation supprimée",
  "org.invite": "Invitation envoyée",
  "org.member.add": "Membre ajouté",
  "org.member.update": "Membre modifié",
  "org.member.remove": "Membre retiré",
  "org.invitation.cancel": "Invitation annulée",
  "org.invitation.accept": "Invitation acceptée",
  "org.invitation.decline": "Invitation refusée",
  "idp.create": "Fournisseur de connexion ajouté",
  "idp.update": "Fournisseur de connexion modifié",
  "idp.delete": "Fournisseur de connexion supprimé",
  "idp.domains.approve": "Domaines de SSO validés",
  "ip_allowlist.bypass": "Accès hors liste d'adresses (administrateur plateforme)",
  "identity.link": "Moyen de connexion lié",
  "identity.unlink": "Moyen de connexion retiré",
  "settings.update": "Paramètre plateforme modifié",
  "settings.reset": "Paramètre plateforme réinitialisé",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Sizes in binary units, French abbreviations. */
function formatSize(bytes: number): string {
  if (!bytes) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

const RTF = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

/** "il y a 3 heures", "hier"... with the exact date in a tooltip. */
function RelativeDate({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-muted-foreground">Jamais</span>;
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [diff, "second"]
      : abs < 3600
        ? [diff / 60, "minute"]
        : abs < 86400
          ? [diff / 3600, "hour"]
          : abs < 86400 * 30
            ? [diff / 86400, "day"]
            : abs < 86400 * 365
              ? [diff / (86400 * 30), "month"]
              : [diff / (86400 * 365), "year"];
  return (
    <Tip content={formatDate(iso)}>
      <span className="cursor-default">{abs < 60 ? "à l'instant" : RTF.format(Math.round(value), unit)}</span>
    </Tip>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="tabular text-xl font-semibold">{value}</div>
      <div className="truncate text-xs text-muted-foreground" title={hint}>
        {label}
      </div>
    </div>
  );
}

type SortKey = "activity" | "name" | "sessions" | "storage";

function OverviewTab() {
  const { user } = useCurrentUser();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("activity");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<Overview>("/api/platform/overview"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const list = [...(data?.organisations ?? [])];
    const t = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
    const activity = (o: OrgOverview) => Math.max(t(o.last_activity_at), t(o.last_session_at));
    list.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "fr");
      if (sort === "sessions") return b.sessions_30d - a.sessions_30d || activity(b) - activity(a);
      if (sort === "storage") return b.recordings_bytes - a.recordings_bytes;
      return b.live_sessions - a.live_sessions || activity(b) - activity(a);
    });
    return list;
  }, [data, sort]);

  const t = data?.totals;
  const sortHead = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => setSort(key)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          sort === key ? "font-medium text-foreground" : "",
        )}
        aria-pressed={sort === key}
      >
        {label}
        <ArrowDownUp className={cn("size-3", sort === key ? "opacity-100" : "opacity-40")} />
      </button>
    </TableHead>
  );

  return (
    <div className="space-y-4">
      <ErrorBox message={error} />

      <Card className="grid grid-cols-2 divide-x divide-y rounded-lg shadow-none sm:grid-cols-4 sm:divide-y-0 lg:grid-cols-7">
        {t ? (
          <>
            <Stat label="Organisations" value={t.organisations} />
            <Stat label="Actives" value={t.active_organisations} />
            <Stat label="Personnes" value={t.people} hint="Comptes actifs sur la plateforme" />
            <Stat label="Sessions ouvertes" value={t.signed_in_sessions} hint="Sessions Citadel en cours (navigateurs connectés)" />
            <Stat label="En direct" value={t.live_sessions} hint="Terminaux et bureaux à distance ouverts en ce moment" />
            <Stat label="Serveurs" value={t.servers} />
            <Stat label="Sessions sur 30 jours" value={t.sessions_30d} />
          </>
        ) : (
          Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="space-y-1.5 px-4 py-3">
              <div className="h-6 w-10 animate-pulse rounded bg-muted" />
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </div>
          ))
        )}
      </Card>

      <Card className="overflow-hidden rounded-lg shadow-none">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Building2 className="size-4 text-muted-foreground" /> Activité par organisation
          </h3>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn(loading && "animate-spin")} /> Actualiser
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {sortHead("name", "Organisation", "pl-5")}
              <TableHead className="text-right">Membres</TableHead>
              <TableHead className="text-right">Serveurs</TableHead>
              {sortHead("sessions", "Sessions 30 j", "text-right")}
              <TableHead className="text-right">En direct</TableHead>
              {sortHead("storage", "Enregistrements", "text-right")}
              {sortHead("activity", "Dernière activité")}
              <TableHead className="pr-5">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data ? (
              <TableSkeleton cols={8} rows={3} />
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  Aucune organisation.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((o) => {
                const lastActivity =
                  [o.last_activity_at, o.last_session_at]
                    .filter((x): x is string => !!x)
                    .sort()
                    .pop() ?? null;
                return (
                  <TableRow key={o.id} className={cn(!o.is_active && "text-muted-foreground")}>
                    <TableCell className="pl-5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{o.name}</span>
                        {o.is_default && <Chip>Par défaut</Chip>}
                        {!o.is_active && <Chip tone="red">Désactivée</Chip>}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{o.slug}</div>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {o.members}
                      {o.pending_invitations > 0 && (
                        <div className="text-xs text-muted-foreground">+{o.pending_invitations} invitée{o.pending_invitations > 1 ? "s" : ""}</div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {o.servers}
                      {o.clusters > 0 && (
                        <div className="text-xs text-muted-foreground">
                          {o.clusters} cluster{o.clusters > 1 ? "s" : ""}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">{o.sessions_30d}</TableCell>
                    <TableCell className="tabular text-right">
                      {o.live_sessions > 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-live">
                          <StatusDot tone="live" pulse /> {o.live_sessions}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular whitespace-nowrap text-right">{formatSize(o.recordings_bytes)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <RelativeDate iso={lastActivity} />
                    </TableCell>
                    <TableCell className="pr-5 text-right">
                      {o.is_active && o.id !== user?.org?.id && (
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => switchOrg(o.slug)}>
                          Ouvrir
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

const PAGE_SIZE = 50;

function JournalTab() {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<PlatformAuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .get<PlatformAuditPage>(`/api/platform/audit?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [page]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Cycle de vie des organisations, fournisseurs de connexion, paramètres plateforme et accès des administrateurs de
        la plateforme hors liste d'adresses.
      </p>
      <ErrorBox message={error} />
      <Card className="overflow-hidden rounded-lg shadow-none">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Date</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Par</TableHead>
              <TableHead>Organisation</TableHead>
              <TableHead>IP</TableHead>
              <TableHead className="pr-5">Détail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className={cn(loading && data && "opacity-60")}>
            {!data && loading ? (
              <TableSkeleton cols={6} rows={6} />
            ) : (data?.items.length ?? 0) === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  Aucune entrée dans le journal de la plateforme.
                </TableCell>
              </TableRow>
            ) : (
              data!.items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="tabular whitespace-nowrap pl-5 text-muted-foreground">{formatDate(a.timestamp)}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {a.status && a.status !== "success" && <StatusDot tone="danger" label={a.status} />}
                      <span title={a.action} className={cn(!ACTION_LABELS[a.action] && "font-mono text-xs")}>
                        {actionLabel(a.action)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{a.user || <span className="text-muted-foreground">Système</span>}</TableCell>
                  <TableCell className="whitespace-nowrap">{a.organisation || <span className="text-muted-foreground">Plateforme</span>}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{a.ip_address || "-"}</TableCell>
                  <TableCell className="max-w-80 truncate pr-5 text-muted-foreground" title={a.result || undefined}>
                    {a.result || "-"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 border-t px-5 py-2.5 text-sm">
            <span className="tabular text-muted-foreground">
              {page * PAGE_SIZE + 1} à {Math.min(total, (page + 1) * PAGE_SIZE)} sur {total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
                Précédent
              </Button>
              <Button size="sm" variant="outline" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>
                Suivant
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

type PlatformTab = "overview" | "journal";

export default function Platform() {
  const { isPlatformAdmin, loading } = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const tab: PlatformTab = params.get("tab") === "journal" ? "journal" : "overview";

  if (!loading && !isPlatformAdmin) {
    return (
      <div>
        <PageHeader title="Plateforme" />
        <EmptyState icon={LayoutDashboard} title="Réservé aux administrateurs de la plateforme">
          Cette console donne l'activité de toutes les organisations et le journal de la plateforme.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Plateforme"
        description="Activité de chaque organisation sans y entrer, et journal des opérations de la plateforme."
      />
      <Tabs
        tabs={[
          { id: "overview" as const, icon: LayoutDashboard, label: "Vue d'ensemble" },
          { id: "journal" as const, icon: ScrollText, label: "Journal" },
        ]}
        active={tab}
        onChange={(t) => setParams(t === "overview" ? {} : { tab: t }, { replace: true })}
      />
      {tab === "overview" ? <OverviewTab /> : <JournalTab />}
    </div>
  );
}
