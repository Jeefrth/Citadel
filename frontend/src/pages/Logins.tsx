// "Connexions" (lot 6): sign-in journal and devices of every user (admins).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, History, Laptop, Loader2, LogIn, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, fetchBlob, handleDeviceRevoked, saveBlob } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import {
  errorMessage,
  type DeviceData,
  type LoginEventPage,
  type LoginMethod,
  type LoginResult,
  type UserData,
} from "@/services/types";
import { ConfirmModal, EmptyState, ErrorBox, Notice, PageHeader, Tabs, type NoticeData } from "@/components/kit";
import {
  DevicesTable,
  LOGIN_METHOD_LABELS,
  LOGIN_RESULT_INFO,
  LoginEventsTable,
  RevokeDeviceText,
} from "@/components/identityUi";

const PAGE_SIZE = 50;
/** Radix Select has no empty value: "all" stands for "no filter". */
const ALL = "all";

type Tab = "events" | "devices";

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

export default function Logins() {
  const { isAdmin, can, loading: userLoading } = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "devices" ? "devices" : "events";
  const [users, setUsers] = useState<UserData[]>([]);

  useEffect(() => {
    if (isAdmin) api.get<UserData[]>("/api/users/").then(setUsers).catch(() => {});
  }, [isAdmin]);

  if (userLoading) return null;
  if (!can("audit")) return <Navigate to="/account" replace />;

  return (
    <div>
      <PageHeader
        title="Connexions"
        description="Qui s'est connecté à Citadel, quand, d'où et avec quel appareil. Déconnectez un appareil à distance."
      />
      <Tabs<Tab>
        tabs={[
          { id: "events", label: "Journal des connexions", icon: History },
          { id: "devices", label: "Appareils", icon: Laptop },
        ]}
        active={tab}
        onChange={(t) => setParams(t === "events" ? {} : { tab: t }, { replace: true })}
      />
      {tab === "events" ? <LoginEventsPanel users={users} /> : <DevicesPanel users={users} />}
    </div>
  );
}

// ── Sign-in journal ──────────────────────────────────────

interface Filters {
  user_id: string;
  result: string;
  method: string;
  date_from: string; // datetime-local value
  date_to: string;
}

const EMPTY: Filters = { user_id: "", result: "", method: "", date_from: "", date_to: "" };

function LoginEventsPanel({ users }: { users: UserData[] }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<LoginEventPage>({ total: 0, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [exporting, setExporting] = useState(false);

  /** Shared by the list and the CSV export. */
  const filterQuery = useMemo(() => {
    const qs = new URLSearchParams();
    if (filters.user_id) qs.set("user_id", filters.user_id);
    if (filters.result) qs.set("result", filters.result);
    if (filters.method) qs.set("method", filters.method);
    if (filters.date_from) qs.set("date_from", new Date(filters.date_from).toISOString());
    if (filters.date_to) qs.set("date_to", new Date(filters.date_to).toISOString());
    return qs;
  }, [filters]);

  // Back to the first page whenever the filters change
  useEffect(() => setOffset(0), [filterQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(filterQuery);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));
      setData(await api.get<LoginEventPage>(`/api/login-events?${qs}`));
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
      const blob = await fetchBlob(`/api/login-events/export.csv?${filterQuery}`);
      saveBlob(blob, `citadel-connexions-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      setNotice({ ok: false, text: `Export impossible : ${errorMessage(e)}` });
    } finally {
      setExporting(false);
    }
  };

  const set = (k: keyof Filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const hasFilters = Object.values(filters).some((v) => v !== "");
  const from = data.total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + data.items.length, data.total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={filters.user_id}
          onChange={set("user_id")}
          allLabel="Tous les utilisateurs"
          options={users.map((u) => ({ value: u.id, label: u.display_name }))}
        />
        <FilterSelect
          value={filters.result}
          onChange={set("result")}
          allLabel="Tous les résultats"
          options={(Object.keys(LOGIN_RESULT_INFO) as LoginResult[]).map((r) => ({
            value: r,
            label: LOGIN_RESULT_INFO[r].label,
          }))}
        />
        <FilterSelect
          value={filters.method}
          onChange={set("method")}
          allLabel="Toutes les méthodes"
          options={(Object.keys(LOGIN_METHOD_LABELS) as LoginMethod[]).map((m) => ({
            value: m,
            label: LOGIN_METHOD_LABELS[m],
          }))}
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
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setFilters(EMPTY)}>
            <X /> Effacer les filtres
          </Button>
        )}
        <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv} disabled={exporting}>
          {exporting ? <Loader2 className="animate-spin" /> : <Download />}
          Exporter en CSV
        </Button>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      {!loading && data.items.length === 0 ? (
        <EmptyState icon={LogIn} title={hasFilters ? "Aucune connexion ne correspond aux filtres" : "Aucune connexion enregistrée"}>
          {hasFilters
            ? "Élargissez la période ou effacez les filtres."
            : "Chaque connexion à Citadel, réussie ou refusée, apparaîtra ici."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <LoginEventsTable items={data.items} loading={loading} showUser />
        </div>
      )}

      <div className="flex items-center justify-between text-sm">
        <span className="tabular text-muted-foreground">
          {from} à {to} sur {data.total} connexion{data.total !== 1 ? "s" : ""}
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

// ── Devices ──────────────────────────────────────────────

function DevicesPanel({ users }: { users: UserData[] }) {
  const canRevoke = useCurrentUser().can("sessions");
  const [userId, setUserId] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [devices, setDevices] = useState<DeviceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceData | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ active_only: String(activeOnly) });
      if (userId) qs.set("user_id", userId);
      setDevices(await api.get<DeviceData[]>(`/api/devices?${qs}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [activeOnly, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async () => {
    const d = revoking;
    if (!d) return;
    setRevokeLoading(true);
    try {
      await api.post(`/api/devices/${d.id}/revoke`, {});
      if (d.current) {
        handleDeviceRevoked();
        return;
      }
      toast.success(`${d.label} déconnecté`);
      if (activeOnly) setDevices((list) => list.filter((x) => x.id !== d.id));
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRevokeLoading(false);
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          value={userId}
          onChange={setUserId}
          allLabel="Tous les utilisateurs"
          options={users.map((u) => ({ value: u.id, label: u.display_name }))}
        />
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={!activeOnly} onCheckedChange={(v) => setActiveOnly(v !== true)} />
          Afficher aussi les appareils déconnectés
        </label>
      </div>

      <ErrorBox message={error} />

      {!loading && devices.length === 0 ? (
        <EmptyState icon={Laptop} title={activeOnly ? "Aucun appareil actif" : "Aucun appareil"}>
          Les navigateurs et clés API apparaissent ici dès leur premier appel à Citadel.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <DevicesTable devices={devices} loading={loading} showUser onRevoke={canRevoke ? setRevoking : undefined} />
        </div>
      )}
      {devices.length >= 500 && (
        <p className="text-xs text-muted-foreground">Seuls les 500 appareils les plus récents sont affichés.</p>
      )}

      {revoking && (
        <ConfirmModal
          title={`Déconnecter ${revoking.label}`}
          confirmLabel="Déconnecter"
          danger
          loading={revokeLoading}
          onConfirm={revoke}
          onClose={() => setRevoking(null)}
        >
          <RevokeDeviceText device={revoking} own={false} />
        </ConfirmModal>
      )}
    </div>
  );
}
