import { useEffect, useState } from "react";
import { api } from "@/services/api";
import type { UserData } from "@/services/types";
import { hasPerm, meets, type Perm, type Requirement } from "@/services/permissions";

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

export interface CurrentUser {
  user: UserData | null;
  isAdmin: boolean;
  /** Platform super-admin (organisations page); independent from the role in the current org. */
  isPlatformAdmin: boolean;
  loading: boolean;
  /** hasPerm(user, perm): admin, or a custom role granting it. */
  can: (perm: Perm) => boolean;
  /** Requirement check (permission, any of several, or "admin"). */
  allows: (req: Requirement | undefined) => boolean;
}

export function useCurrentUser(): CurrentUser {
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

  return {
    user,
    isAdmin: user?.role === "admin",
    isPlatformAdmin: !!user?.is_platform_admin,
    loading,
    can: (perm) => hasPerm(user, perm),
    allows: (req) => meets(user, req),
  };
}
