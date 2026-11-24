// Notification bell (app header): unread badge polled every 30 s and a popover
// with the most recent in-app notifications.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type CountResponse, type NotificationData } from "@/services/types";
import { LEVEL_INFO, relativeTime } from "@/components/governanceUi";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.span
          key="badge"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={cn(
            "tabular flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-2xs font-semibold leading-none text-danger-foreground",
            className,
          )}
        >
          <motion.span
            key={count}
            initial={{ y: -4, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            {count > 99 ? "99+" : count}
          </motion.span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [unread, reloadCount] = usePolledCount("/api/notifications/unread-count");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const hasUnread = unread > 0 || (items || []).some((n) => !n.read_at);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-8 text-muted-foreground"
          title="Notifications"
          aria-label={`Notifications (${unread} non lue(s))`}
        >
          <Bell className="size-4" />
          <CountBadge count={unread} className="absolute -right-0.5 -top-0.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <h3 className="text-sm font-semibold">
            Notifications
            {unread > 0 && <span className="tabular ml-1.5 font-normal text-muted-foreground">{unread} non lue(s)</span>}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={markAll}
            disabled={!hasUnread}
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          >
            <CheckCheck className="size-3.5" /> Tout marquer comme lu
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {loading && items === null && (
            <div className="space-y-3 p-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2.5">
                  <Skeleton className="mt-1.5 size-2 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && <p className="p-3 text-xs text-danger">{error}</p>}
          {items && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <BellOff className="size-6 text-muted-foreground/60" strokeWidth={1.5} />
              <p className="text-sm text-muted-foreground">Aucune notification pour le moment.</p>
            </div>
          )}
          {items?.map((n) => {
            const lvl = LEVEL_INFO[n.level] || LEVEL_INFO.info;
            const isUnread = !n.read_at;
            return (
              <button
                key={n.id}
                onClick={() => openItem(n)}
                className="relative flex w-full gap-2.5 border-b px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-accent"
              >
                <AnimatePresence initial={false}>
                  {isUnread && (
                    <motion.span
                      key="unread"
                      aria-hidden
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="absolute inset-0 bg-foreground/5"
                    />
                  )}
                </AnimatePresence>
                <span
                  className={cn("relative mt-1.5 size-2 shrink-0 rounded-full", lvl.dot)}
                  title={lvl.label}
                  aria-label={lvl.label}
                />
                <motion.div
                  className="relative min-w-0 flex-1"
                  animate={{ opacity: isUnread ? 1 : 0.65 }}
                  transition={{ duration: 0.2 }}
                >
                  <p className={cn("truncate text-sm", isUnread && "font-semibold")}>{n.title}</p>
                  {n.body && (
                    <p className="line-clamp-2 whitespace-pre-line break-words text-xs text-muted-foreground">
                      {n.body}
                    </p>
                  )}
                  <p className="mt-0.5 text-2xs text-muted-foreground">{relativeTime(n.created_at)}</p>
                </motion.div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
