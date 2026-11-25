import { useEffect, useState } from "react";
import { api } from "@/services/api";
import type { UserData } from "@/services/types";
import { hasPerm, meets, type Perm, type Requirement } from "@/services/permissions";
import { isNoOrgError } from "@/services/org";

// Module-level cache: /api/auth/me is fetched once per page load.
let cached: UserData | null = null;
let pending: Promise<UserData> | null = null;
/** /api/auth/me answered "Aucune organisation pour ce compte". */
let cachedNoOrg = false;
const listeners = new Set<(u: UserData) => void>();

/** Update fields of the cached user (e.g. pending_invitations) for every mounted hook. */
export function updateCurrentUser(patch: Partial<UserData>): void {
  if (!cached) return;
  cached = { ...cached, ...patch };
  const next = cached;
  listeners.forEach((l) => l(next));
}

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
        if (isNoOrgError(e)) cachedNoOrg = true;
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
  /** The person belongs to no organisation: the app shows the no-organisation screen. */
  noOrg: boolean;
  /** hasPerm(user, perm): admin, or a custom role granting it. */
  can: (perm: Perm) => boolean;
  /** Requirement check (permission, any of several, or "admin"). */
  allows: (req: Requirement | undefined) => boolean;
}

export function useCurrentUser(): CurrentUser {
  const [user, setUser] = useState<UserData | null>(cached);
  const [loading, setLoading] = useState(!cached && !cachedNoOrg);
  const [noOrg, setNoOrg] = useState(cachedNoOrg);

  useEffect(() => {
    listeners.add(setUser);
    return () => {
      listeners.delete(setUser);
    };
  }, []);

  useEffect(() => {
    if (cached || cachedNoOrg) return;
    let alive = true;
    loadCurrentUser()
      .then((u) => alive && setUser(u))
      .catch((e) => {
        if (alive && isNoOrgError(e)) setNoOrg(true);
      })
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
    noOrg,
    can: (perm) => hasPerm(user, perm),
    allows: (req) => meets(user, req),
  };
}
