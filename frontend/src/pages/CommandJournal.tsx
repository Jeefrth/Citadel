// "Journal des commandes": every command typed in a terminal or run through /execute,
// with the governance decision. Admins see everybody, other users only their own.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Film, Loader2, ScrollText, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, fetchBlob, saveBlob } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  COMMAND_DECISIONS,
  errorMessage,
  type CommandLogPage,
  type CommandSource,
  type ServerData,
  type UserData,
} from "@/services/types";
import { EmptyState, ErrorBox, Notice, PageHeader, formatDate, type NoticeData } from "@/components/kit";
import { DECISION_INFO, DecisionChip, SOURCE_LABELS, TableSkeleton, Tip, formatClock } from "@/components/auditUi";

const PAGE_SIZE = 50;
/** Radix Select has no empty value: "all" stands for "no filter". */
const ALL = "all";
/** Commands longer than this are truncated, the full text is in a tooltip. */
const LONG_COMMAND = 70;

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger className={cn("h-8 w-auto min-w-40 gap-2", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface Filters {
  user_id: string;
  server_id: string;
  decision: string;
  source: string;
  date_from: string; // datetime-local value
  date_to: string;
}

const EMPTY: Filters = { user_id: "", server_id: "", decision: "", source: "", date_from: "", date_to: "" };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function CommandJournal() {
  const { isAdmin } = useCurrentUser();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 350);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<CommandLogPage>({ total: 0, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [exporting, setExporting] = useState(false);
  const [users, setUsers] = useState<UserData[]>([]);
  const [servers, setServers] = useState<ServerData[]>([]);

  useEffect(() => {
    api.get<ServerData[]>("/api/servers/").then(setServers).catch(() => {});
  }, []);
  useEffect(() => {
    if (isAdmin) api.get<UserData[]>("/api/users/").then(setUsers).catch(() => {});
  }, [isAdmin]);

  /** Shared by the search and the CSV export. */
  const filterQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (dq) qs.set("q", dq);
    if (isAdmin && filters.user_id) qs.set("user_id", filters.user_id);
    if (filters.server_id) qs.set("server_id", filters.server_id);
    if (filters.decision) qs.set("decision", filters.decision);
    if (filters.source) qs.set("source", filters.source);
    if (filters.date_from) qs.set("date_from", new Date(filters.date_from).toISOString());
    if (filters.date_to) qs.set("date_to", new Date(filters.date_to).toISOString());
    return qs;
  }, [dq, filters, isAdmin]);

  // Back to the first page whenever the filters change
  useEffect(() => setOffset(0), [filterQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(filterQuery);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));
      setData(await api.get<CommandLogPage>(`/api/command-logs?${qs}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [filterQuery, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await fetchBlob(`/api/command-logs/export.csv?${filterQuery}`);
      saveBlob(blob, `citadel-commandes-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      setNotice({ ok: false, text: `Export impossible : ${errorMessage(e)}` });
    } finally {
      setExporting(false);
    }
  };

  const set = (k: keyof Filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const hasFilters = q !== "" || Object.values(filters).some((v) => v !== "");
  const from = data.total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + data.items.length, data.total);

  const cols = isAdmin ? 10 : 9;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Journal des commandes"
        description={
          isAdmin
            ? "Commandes saisies dans les terminaux et lancées par exécution, avec la décision des règles."
            : "Vos commandes saisies dans les terminaux et lancées par exécution."
        }
        actions={
          isAdmin && (
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              Exporter en CSV
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher dans les commandes..."
            className="h-8 pl-8 font-mono"
          />
        </div>
        {isAdmin && (
          <FilterSelect
            value={filters.user_id}
            onChange={set("user_id")}
            allLabel="Tous les utilisateurs"
            options={users.map((u) => ({ value: u.id, label: u.display_name }))}
          />
        )}
        <FilterSelect
          value={filters.server_id}
          onChange={set("server_id")}
          allLabel="Tous les serveurs"
          options={servers.map((sv) => ({ value: sv.id, label: sv.name }))}
        />
        <FilterSelect
          value={filters.decision}
          onChange={set("decision")}
          allLabel="Toutes les décisions"
          options={COMMAND_DECISIONS.map((d) => ({ value: d, label: DECISION_INFO[d].label }))}
        />
        <FilterSelect
          value={filters.source}
          onChange={set("source")}
          allLabel="Toutes les sources"
          options={(Object.keys(SOURCE_LABELS) as CommandSource[]).map((x) => ({ value: x, label: SOURCE_LABELS[x] }))}
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Du
          <Input
            type="datetime-local"
            value={filters.date_from}
            onChange={(e) => set("date_from")(e.target.value)}
            className="tabular h-8 w-auto"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          au
          <Input
            type="datetime-local"
            value={filters.date_to}
            onChange={(e) => set("date_to")(e.target.value)}
            className="tabular h-8 w-auto"
          />
        </label>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setQ("");
              setFilters(EMPTY);
            }}
          >
            <X /> Effacer les filtres
          </Button>
        )}
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      {!loading && data.items.length === 0 ? (
        <EmptyState icon={ScrollText} title={hasFilters ? "Aucune commande ne correspond aux filtres" : "Aucune commande journalisée"}>
          {hasFilters
            ? "Élargissez la recherche ou effacez les filtres."
            : "Les commandes saisies dans un terminal ou lancées par exécution apparaîtront ici."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Date</TableHead>
                {isAdmin && <TableHead>Utilisateur</TableHead>}
                <TableHead>Cible</TableHead>
                <TableHead>Commande</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Décision</TableHead>
                <TableHead>Règle</TableHead>
                <TableHead className="text-right">Code</TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="pr-4">Enregistrement</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={cn(loading && "opacity-60")}>
              {loading && data.items.length === 0 ? (
                <TableSkeleton cols={cols} rows={8} />
              ) : (
                data.items.map((c) => {
                  const long = c.command.length > LONG_COMMAND || c.command.includes("\n");
                  const cmd = (
                    <code className="block max-w-[28rem] cursor-default truncate font-mono text-xs">{c.command}</code>
                  );
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="tabular whitespace-nowrap py-2 pl-4 text-muted-foreground">
                        {formatDate(c.created_at)}
                      </TableCell>
                      {isAdmin && <TableCell className="whitespace-nowrap py-2">{c.user_name}</TableCell>}
                      <TableCell className="whitespace-nowrap py-2 font-mono text-xs">
                        {c.account && <span className="text-muted-foreground">{c.account}@</span>}
                        {c.server_name}
                      </TableCell>
                      <TableCell className="py-2">
                        {long ? (
                          <Tip
                            content={<pre className="whitespace-pre-wrap break-all font-mono text-xs">{c.command}</pre>}
                            className="max-w-xl"
                          >
                            {cmd}
                          </Tip>
                        ) : (
                          cmd
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 text-muted-foreground">
                        {SOURCE_LABELS[c.source] || c.source}
                      </TableCell>
                      <TableCell className="py-2">
                        <DecisionChip decision={c.decision} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 text-muted-foreground">{c.rule || "-"}</TableCell>
                      <TableCell
                        className={cn(
                          "tabular py-2 text-right font-mono text-xs",
                          c.exit_code !== null && c.exit_code !== 0 ? "font-medium text-danger" : "text-muted-foreground",
                        )}
                      >
                        {c.exit_code ?? "-"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 font-mono text-xs text-muted-foreground">
                        {c.ip_address || "-"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap py-2 pr-4">
                        {c.session_id ? (
                          <Tip content={c.offset_ms != null ? `Position ${formatClock(c.offset_ms)}` : undefined}>
                            <Link
                              to={`/sessions?session=${encodeURIComponent(c.session_id)}${
                                c.offset_ms != null ? `&t=${c.offset_ms}` : ""
                              }`}
                              className="inline-flex items-center gap-1 text-sm text-foreground underline-offset-4 hover:underline"
                            >
                              <Film className="size-3.5 text-muted-foreground" /> Voir l'enregistrement
                            </Link>
                          </Tip>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm">
        <span className="tabular text-muted-foreground">
          {from} à {to} sur {data.total} commande{data.total !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || loading}
          >
            <ChevronLeft /> Précédent
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= data.total || loading}
          >
            Suivant <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
