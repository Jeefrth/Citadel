// Full-page screen when the current organisation's address allow-list refuses this
// browser (403 "Adresse IP non autorisée par cette organisation"). /api/me/orgs works
// without an organisation and without the allow-list, to offer the other organisations.
import { useEffect, useState } from "react";
import { Building2, LogOut, ShieldX } from "lucide-react";
import { api } from "@/services/api";
import { getOrgSlug, switchOrg } from "@/services/org";
import { logout } from "@/services/session";
import { errorMessage } from "@/services/types";
import { ErrorBox } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface MyOrgsInfo {
  client_ip: string | null;
  orgs: { id: string; name: string; slug: string; is_default: boolean }[];
}

export default function IpBlockedScreen() {
  const [info, setInfo] = useState<MyOrgsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MyOrgsInfo>("/api/me/orgs")
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const current = getOrgSlug();
  // No stored slug: the refused organisation is the default one (first membership)
  // Without a stored slug the backend used the first organisation of the list (same order)
  const refused = current ?? info?.orgs[0]?.slug;
  const others = (info?.orgs ?? []).filter((o) => o.slug !== refused);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-lg space-y-5 rounded-lg p-6 shadow-none">
        <div className="space-y-2">
          <ShieldX className="size-6 text-danger" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight">Accès refusé depuis cette adresse</h1>
          <p className="text-sm text-muted-foreground">
            Cette organisation n'autorise l'accès à Citadel que depuis certaines adresses IP. Connectez-vous depuis un
            réseau autorisé (bureau, VPN) ou contactez l'administrateur de l'organisation.
          </p>
        </div>

        <ErrorBox message={error} />

        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          Votre adresse :{" "}
          {info ? (
            <code className="font-mono text-xs">{info.client_ip || "inconnue"}</code>
          ) : (
            !error && <Skeleton className="inline-block h-3.5 w-28 align-middle" />
          )}
        </div>

        {others.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Vos autres organisations</p>
            <div className="space-y-2">
              {others.map((o) => (
                <Button key={o.id} variant="outline" className="w-full justify-start" onClick={() => switchOrg(o.slug)}>
                  <Building2 /> {o.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end border-t pt-4">
          <Button variant="outline" onClick={() => void logout()}>
            <LogOut /> Se déconnecter
          </Button>
        </div>
      </Card>
    </div>
  );
}
