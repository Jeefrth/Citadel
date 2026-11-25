// Permissions (lot 7): an admin has them all; operators and viewers get the
// ones granted by their custom role. Single place to test them in the UI.
import type { UserData } from "@/services/types";

export type Perm = "audit" | "sessions" | "servers" | "secrets" | "policies" | "playbooks";
export const ALL_PERMS: Perm[] = ["audit", "sessions", "servers", "secrets", "policies", "playbooks"];

/** What a screen requires: a permission, any of several, or the admin role. */
export type Requirement = Perm | Perm[] | "admin";

export function isAdminUser(user: Pick<UserData, "role"> | null | undefined): boolean {
  return user?.role === "admin";
}

export function hasPerm(user: Pick<UserData, "role" | "permissions"> | null | undefined, perm: Perm): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return (user.permissions || []).includes(perm);
}

/** True when the user meets the requirement (no requirement: everyone). */
export function meets(
  user: Pick<UserData, "role" | "permissions"> | null | undefined,
  req: Requirement | undefined,
): boolean {
  if (!req) return true;
  if (req === "admin") return isAdminUser(user);
  if (Array.isArray(req)) return req.some((p) => hasPerm(user, p));
  return hasPerm(user, req);
}
