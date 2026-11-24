import { useEffect, useState } from "react";
import { api } from "@/services/api";
import type { UserData } from "@/services/types";

// Module-level cache: /api/auth/me is fetched once per page load.
let cached: UserData | null = null;
let pending: Promise<UserData> | null = null;

function loadCurrentUser(): Promise<UserData> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = api
      .get<UserData>("/api/auth/me")
      .then((u) => {
        cached = u;
        return u;
      })
      .catch((e) => {
        pending = null;
        throw e;
      });
  }
  return pending;
}

export function useCurrentUser(): { user: UserData | null; isAdmin: boolean; loading: boolean } {
  const [user, setUser] = useState<UserData | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    loadCurrentUser()
      .then((u) => alive && setUser(u))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return { user, isAdmin: user?.role === "admin", loading };
}
