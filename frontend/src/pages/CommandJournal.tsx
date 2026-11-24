// "Journal des commandes": every command typed in a terminal or run through /execute,
// with the governance decision. Admins see everybody, other users only their own.
import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download, Film, Loader2, ScrollText, Search, X } from "lucide-react";
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
import { ErrorBox, Notice, btnSecondary, formatDate, type NoticeData } from "@/components/kit";
import { DECISION_INFO, DecisionChip, SOURCE_LABELS, formatClock } from "@/components/auditUi";

const PAGE_SIZE = 50;
const selectCls =
  "px-2 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring";

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

  const set = (k: keyof Filters) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilters((f) => ({ ...f, [k]: e.target.value }));
  const hasFilters = q !== "" || Object.values(filters).some((v) => v !== "");
  const from = data.total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + data.items.length, data.total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Journal des commandes</h2>
          <p className="text-sm text-muted-foreground">
            {isAdmin
              ? "Commandes saisies dans les terminaux et lancées par exécution, avec la décision des règles."
              : "Vos commandes saisies dans les terminaux et lancées par exécution."}
          </p>
        </div>
        {isAdmin && (
          <button onClick={exportCsv} disabled={exporting} className={btnSecondary}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Exporter en CSV
          </button>
        )}
      </div>

      <div className="bg-card border rounded-lg p-3 space-y-2">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher dans les commandes..."
            className="w-full pl-9 pr-3 py-2 rounded-md border bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <select value={filters.user_id} onChange={set("user_id")} className={selectCls}>
              <option value="">Tous les utilisateurs</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name}
                </option>
              ))}
            </select>
          )}
          <select value={filters.server_id} onChange={set("server_id")} className={selectCls}>
            <option value="">Tous les serveurs</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={filters.decision} onChange={set("decision")} className={selectCls}>
            <option value="">Toutes les décisions</option>
            {COMMAND_DECISIONS.map((d) => (
              <option key={d} value={d}>
                {DECISION_INFO[d].label}
              </option>
            ))}
          </select>
          <select value={filters.source} onChange={set("source")} className={selectCls}>
            <option value="">Toutes les sources</option>
            {(Object.keys(SOURCE_LABELS) as CommandSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Du
            <input type="datetime-local" value={filters.date_from} onChange={set("date_from")} className={selectCls} />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            au
            <input type="datetime-local" value={filters.date_to} onChange={set("date_to")} className={selectCls} />
          </label>
          {hasFilters && (
            <button
              onClick={() => {
                setQ("");
                setFilters(EMPTY);
              }}
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X size={14} /> Effacer les filtres
            </button>
          )}
        </div>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      <div className="bg-card border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th className="p-3 font-medium">Date</th>
              {isAdmin && <th className="p-3 font-medium">Utilisateur</th>}
              <th className="p-3 font-medium">Serveur</th>
              <th className="p-3 font-medium">Commande</th>
              <th className="p-3 font-medium">Source</th>
              <th className="p-3 font-medium">Décision</th>
              <th className="p-3 font-medium">Règle</th>
              <th className="p-3 font-medium">Code</th>
              <th className="p-3 font-medium">IP</th>
              <th className="p-3 font-medium">Enregistrement</th>
            </tr>
          </thead>
          <tbody>
            {loading && data.items.length === 0 && (
              <tr>
                <td colSpan={10} className="p-8 text-center">
                  <Loader2 size={20} className="animate-spin text-muted-foreground inline" />
                </td>
              </tr>
            )}
            {!loading && data.items.length === 0 && (
              <tr>
                <td colSpan={10} className="p-12 text-center text-muted-foreground">
                  <ScrollText size={40} className="mx-auto mb-3" />
                  Aucune commande {hasFilters ? "ne correspond aux filtres" : "journalisée"}.
                </td>
              </tr>
            )}
            {data.items.map((c) => (
              <tr key={c.id} className={`border-b last:border-0 align-top ${loading ? "opacity-60" : ""}`}>
                <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{formatDate(c.created_at)}</td>
                {isAdmin && <td className="p-3 whitespace-nowrap">{c.user_name}</td>}
                <td className="p-3 whitespace-nowrap">
                  {c.account && <span className="font-mono text-xs text-muted-foreground">{c.account}@</span>}
                  {c.server_name}
                </td>
                <td className="p-3 max-w-md">
                  <code className="block font-mono text-xs break-all whitespace-pre-wrap line-clamp-3" title={c.command}>
                    {c.command}
                  </code>
                </td>
                <td className="p-3 text-xs">{SOURCE_LABELS[c.source] || c.source}</td>
                <td className="p-3">
                  <DecisionChip decision={c.decision} />
                </td>
                <td className="p-3 text-xs">{c.rule || "-"}</td>
                <td
                  className={`p-3 text-xs font-mono ${
                    c.exit_code !== null && c.exit_code !== 0 ? "text-red-700" : "text-muted-foreground"
                  }`}
                >
                  {c.exit_code ?? "-"}
                </td>
                <td className="p-3 text-xs font-mono text-muted-foreground">{c.ip_address || "-"}</td>
                <td className="p-3 text-xs whitespace-nowrap">
                  {c.session_id ? (
                    <Link
                      to={`/sessions?session=${encodeURIComponent(c.session_id)}${
                        c.offset_ms != null ? `&t=${c.offset_ms}` : ""
                      }`}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      title={c.offset_ms != null ? `Position ${formatClock(c.offset_ms)}` : undefined}
                    >
                      <Film size={12} /> Voir dans l'enregistrement
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {from} à {to} sur {data.total} commande{data.total !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0 || loading}
            className={btnSecondary}
          >
            <ChevronLeft size={14} /> Précédent
          </button>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= data.total || loading}
            className={btnSecondary}
          >
            Suivant <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
