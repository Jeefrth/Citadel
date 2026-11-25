// Invitations waiting for the signed-in person's consent (/api/me/invitations).
// Used in Mon compte and on the no-organisation screen; works without any organisation.
import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Loader2, X } from "lucide-react";
import { api } from "@/services/api";
import { roleLabel } from "@/services/org";
import { updateCurrentUser } from "@/services/useCurrentUser";
import { errorMessage, type MyInvitation, type MyInvitationAnswer } from "@/services/types";
import { formatDate } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function useMyInvitations() {
  const [invitations, setInvitations] = useState<MyInvitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInvitations(await api.get<MyInvitation[]>("/api/me/invitations"));
    } catch (e) {
      setInvitations((prev) => prev ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Accept or decline; resolves with the answer, or null on error (shown in `error`). */
  const answer = async (inv: MyInvitation, accept: boolean): Promise<MyInvitationAnswer | null> => {
    setBusy(inv.id);
    setError(null);
    try {
      const res = await api.post<MyInvitationAnswer>(
        `/api/me/invitations/${inv.id}/${accept ? "accept" : "decline"}`,
        {},
      );
      const next = (invitations || []).filter((i) => i.id !== inv.id);
      setInvitations(next);
      updateCurrentUser({ pending_invitations: next.length });
      return res;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  return { invitations, error, busy, answer, reload: load };
}

/** Rows: organisation, role, date, Accepter / Refuser. */
export function InvitationRows({
  invitations,
  busy,
  onAnswer,
}: {
  invitations: MyInvitation[] | null;
  busy: string | null;
  onAnswer: (inv: MyInvitation, accept: boolean) => void;
}) {
  if (invitations === null) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  return (
    <ul className="divide-y">
      {invitations.map((inv) => (
        <li key={inv.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
          <Building2 className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{inv.org.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {roleLabel(inv.role)}, invitation du {formatDate(inv.created_at, false)}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onAnswer(inv, false)}>
              <X /> Refuser
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => onAnswer(inv, true)}>
              {busy === inv.id ? <Loader2 className="animate-spin" /> : <Check />}
              Accepter
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
