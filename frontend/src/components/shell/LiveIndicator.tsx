import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { api } from "@/services/api";
import { cn } from "@/lib/utils";

const POLL_MS = 10_000;

/**
 * The one loud element of the interface: an amber pulse when sessions are open
 * right now, quiet otherwise. Admins only (the endpoint is admin-only).
 */
export default function LiveIndicator() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .get<unknown[]>("/api/live-sessions")
        .then((r) => !stop && setCount(r.length))
        .catch(() => !stop && setCount(null));
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);

  if (count === null) return null;
  const live = count > 0;

  return (
    <Link
      to="/live"
      className={cn(
        "group flex h-8 items-center gap-2 rounded-full border px-3 text-sm transition-colors",
        live
          ? "border-live/40 bg-live/10 text-live hover:bg-live/15"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-label={live ? `${count} session(s) en direct` : "Aucune session en direct"}
    >
      <span className="relative flex size-2.5 items-center justify-center">
        {live && (
          <motion.span
            className="absolute inset-0 rounded-full bg-live"
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className={cn("relative size-2 rounded-full", live ? "bg-live" : "bg-muted-foreground/40")} />
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={count}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="tabular font-medium"
        >
          {live ? `${count} en direct` : "Aucune session"}
        </motion.span>
      </AnimatePresence>
    </Link>
  );
}
