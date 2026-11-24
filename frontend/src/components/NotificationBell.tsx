// Notification bell (sidebar header): unread badge polled every 30 s and a panel
// with the most recent in-app notifications.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type CountResponse, type NotificationData } from "@/services/types";
import { LEVEL_INFO, relativeTime } from "@/components/governanceUi";

export const POLL_MS = 30_000;
/** Window event other screens dispatch to refresh the badges right away. */
export const GOVERNANCE_REFRESH_EVENT = "citadel:governance-refresh";

export function refreshGovernanceBadges() {
  window.dispatchEvent(new Event(GOVERNANCE_REFRESH_EVENT));
}

/** Polls a {count} endpoint every 30 s (and on refresh events). */
export function usePolledCount(path: string): [number, () => void] {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    api
      .get<CountResponse>(path)
      .then((r) => setCount(r.count))
      .catch(() => {});
  }, [path]);
  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    window.addEventListener(GOVERNANCE_REFRESH_EVENT, load);
    return () => {
      window.clearInterval(t);
      window.removeEventListener(GOVERNANCE_REFRESH_EVENT, load);
    };
  }, [load]);
  return [count, load];
}

export function CountBadge({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`min-w-[1.25rem] h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-semibold flex items-center justify-center ${className}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [unread, reloadCount] = usePolledCount("/api/notifications/unread-count");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.get<NotificationData[]>("/api/notifications?limit=30"));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadList();
  }, [open, loadList]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openItem = async (n: NotificationData) => {
    if (!n.read_at) {
      setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) ?? null);
      try {
        await api.post(`/api/notifications/${n.id}/read`, {});
      } catch {
        // not blocking
      }
      reloadCount();
    }
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  };

  const markAll = async () => {
    try {
      await api.post("/api/notifications/read-all", {});
      const now = new Date().toISOString();
      setItems((prev) => prev?.map((x) => (x.read_at ? x : { ...x, read_at: now })) ?? null);
      reloadCount();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 rounded-md hover:bg-accent text-muted-foreground"
        title="Notifications"
        aria-label={`Notifications (${unread} non lue(s))`}
      >
        <Bell size={18} />
        <CountBadge count={unread} className="absolute -top-1 -right-1" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-[22rem] max-w-[calc(100vw-2rem)] bg-card border rounded-lg shadow-lg flex flex-col max-h-[70vh]">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <h3 className="text-sm font-semibold">Notifications</h3>
            <button
              onClick={markAll}
              disabled={unread === 0 && !(items || []).some((n) => !n.read_at)}
              className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-40 disabled:no-underline"
            >
              <CheckCheck size={13} /> Tout marquer comme lu
            </button>
          </div>
          <div className="overflow-auto">
            {loading && items === null && (
              <div className="flex justify-center p-6">
                <Loader2 size={18} className="animate-spin text-muted-foreground" />
              </div>
            )}
            {error && <p className="p-3 text-xs text-red-700">{error}</p>}
            {items && items.length === 0 && (
              <p className="p-6 text-center text-sm text-muted-foreground">Aucune notification.</p>
            )}
            {items?.map((n) => {
              const lvl = LEVEL_INFO[n.level] || LEVEL_INFO.info;
              return (
                <button
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={`w-full text-left px-3 py-2.5 border-b last:border-0 flex gap-2.5 hover:bg-accent ${
                    n.read_at ? "opacity-70" : "bg-primary/5"
                  }`}
                >
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${lvl.dot}`} title={lvl.label} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm truncate ${n.read_at ? "" : "font-semibold"}`}>{n.title}</p>
                    {n.body && (
                      <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-line break-words">
                        {n.body}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-0.5">{relativeTime(n.created_at)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
