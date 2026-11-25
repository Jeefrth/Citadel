// Full-page screen for a person who belongs to no organisation: pending invitations
// (accept, then reload in that organisation) or a hint to ask for one, and sign-out.
import { useMsal } from "@azure/msal-react";
import { toast } from "sonner";
import { LogOut, MailQuestion } from "lucide-react";
import { switchOrg } from "@/services/org";
import type { MyInvitation } from "@/services/types";
import { InvitationRows, useMyInvitations } from "@/components/MyInvitations";
import { ErrorBox } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

export default function NoOrgScreen() {
  const { instance } = useMsal();
  const { invitations, error, busy, answer } = useMyInvitations();

  const onAnswer = async (inv: MyInvitation, accept: boolean) => {
    const res = await answer(inv, accept);
    if (!res) return;
    if (res.accepted) switchOrg(res.org.slug);
    else toast.success(`Invitation de ${res.org.name} refusée`);
  };

  const signOut = () => (DEV_MODE ? window.location.reload() : instance.logoutRedirect());

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-lg space-y-5 rounded-lg p-6 shadow-none">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Vous n'appartenez à aucune organisation</h1>
          <p className="text-sm text-muted-foreground">
            Votre compte est bien connecté, mais aucune organisation ne vous donne encore accès à Citadel.
          </p>
        </div>

        <ErrorBox message={error} />

        {invitations !== null && invitations.length === 0 ? (
          <div className="flex items-start gap-3 rounded-md border bg-muted/40 px-3 py-3 text-sm">
            <MailQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              Aucune invitation en attente. Demandez à un administrateur de votre organisation de vous inviter avec
              votre adresse e-mail, puis revenez sur cette page.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">Invitations en attente</p>
            <InvitationRows invitations={invitations} busy={busy} onAnswer={onAnswer} />
          </div>
        )}

        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" onClick={signOut}>
            <LogOut /> Se déconnecter
          </Button>
        </div>
      </Card>
    </div>
  );
}
