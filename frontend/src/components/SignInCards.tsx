// Mon compte (SaaS phase 3): sign-in methods linked to the person (link, unlink)
// and open Citadel sessions (end one; ending the current one signs out).
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, LogOut, MonitorSmartphone, Plus, Unlink } from "lucide-react";
import { api } from "@/services/api";
import { linkProvider } from "@/services/reauth";
import { logout } from "@/services/session";
import { errorMessage, type AuthIdentity, type AuthProvider, type AuthSessionData } from "@/services/types";
import { ProviderIcon } from "@/components/providerUi";
import { TableSkeleton, Tip } from "@/components/auditUi";
import { Chip, ConfirmModal, ErrorBox, formatDate, iconBtnDanger } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function SignInMethodsCard() {
  const [identities, setIdentities] = useState<AuthIdentity[] | null>(null);
  const [linkable, setLinkable] = useState<AuthProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<AuthIdentity | null>(null);
  const [unlinkLoading, setUnlinkLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ids, prov] = await Promise.all([
        api.get<AuthIdentity[]>("/api/auth/identities"),
        api.get<AuthProvider[]>("/api/auth/linkable").catch(() => [] as AuthProvider[]),
      ]);
      setIdentities(ids);
      setLinkable(prov);
    } catch (e) {
      setIdentities((prev) => prev ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Called straight from the menu click: the popup opens before any await
  const link = async (p: AuthProvider) => {
    setError(null);
    setLinking(true);
    try {
      const msg = await linkProvider(p.id);
      toast.success(msg === "Compte lié." ? `${p.name} lié à votre compte` : msg);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLinking(false);
    }
  };

  const unlink = async () => {
    const target = unlinking;
    if (!target) return;
    setUnlinkLoading(true);
    setError(null);
    try {
      await api.delete(`/api/auth/identities/${target.id}`);
      setIdentities((prev) => (prev || []).filter((i) => i.id !== target.id));
      toast.success("Moyen de connexion retiré");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUnlinkLoading(false);
      setUnlinking(null);
    }
  };

  const onlyOne = (identities?.length ?? 0) <= 1;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0 border-b p-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4 text-muted-foreground" /> Moyens de connexion
          </CardTitle>
          <CardDescription className="text-xs">
            Comptes avec lesquels vous pouvez vous connecter à Citadel. Liez-en un second pour ne pas perdre l'accès.
          </CardDescription>
        </div>
        {linkable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={linking}>
                {linking ? <Loader2 className="animate-spin" /> : <Plus />}
                Lier un compte
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {linkable.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => link(p)}>
                  <ProviderIcon kind={p.kind} />
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CardHeader>
      {error && (
        <div className="p-4 pb-0">
          <ErrorBox message={error} />
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Fournisseur</TableHead>
            <TableHead>Compte</TableHead>
            <TableHead>Lié le</TableHead>
            <TableHead>Dernière connexion</TableHead>
            <TableHead className="pr-4">
              <span className="sr-only">Gestion</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {identities === null ? (
            <TableSkeleton cols={5} rows={2} />
          ) : identities.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                Aucun moyen de connexion enregistré.
              </TableCell>
            </TableRow>
          ) : (
            identities.map((i) => (
              <TableRow key={i.id}>
                <TableCell className="py-2 pl-4">
                  <span className="flex items-center gap-2">
                    <ProviderIcon kind={i.provider?.kind || "oidc"} className="size-3.5 text-muted-foreground" />
                    {i.provider?.name || "Fournisseur supprimé"}
                  </span>
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-muted-foreground">{i.email || "-"}</TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">
                  {formatDate(i.created_at, false)}
                </TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">
                  {i.last_login_at ? formatDate(i.last_login_at) : "Jamais"}
                </TableCell>
                <TableCell className="py-2 pr-4 text-right">
                  <Tip content={onlyOne ? "Votre seul moyen de connexion ne peut pas être retiré" : "Retirer"}>
                    <span className="inline-flex">
                      <button
                        type="button"
                        className={iconBtnDanger}
                        disabled={onlyOne}
                        onClick={() => setUnlinking(i)}
                        aria-label={`Retirer ${i.provider?.name || "ce moyen de connexion"}`}
                      >
                        <Unlink className="size-4" />
                      </button>
                    </span>
                  </Tip>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {unlinking && (
        <ConfirmModal
          title="Retirer ce moyen de connexion"
          confirmLabel="Retirer"
          danger
          loading={unlinkLoading}
          onConfirm={unlink}
          onClose={() => setUnlinking(null)}
        >
          <p>
            Vous ne pourrez plus vous connecter avec <strong>{unlinking.provider?.name || "ce fournisseur"}</strong>
            {unlinking.email ? (
              <>
                {" "}
                (<strong>{unlinking.email}</strong>)
              </>
            ) : null}
            . Vous pourrez le lier de nouveau plus tard.
          </p>
        </ConfirmModal>
      )}
    </Card>
  );
}

export function SessionsCard() {
  const [sessions, setSessions] = useState<AuthSessionData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<AuthSessionData | null>(null);
  const [endLoading, setEndLoading] = useState(false);

  useEffect(() => {
    api
      .get<AuthSessionData[]>("/api/auth/sessions")
      .then(setSessions)
      .catch((e) => {
        setSessions([]);
        setError(errorMessage(e));
      });
  }, []);

  const end = async () => {
    const target = ending;
    if (!target) return;
    setEndLoading(true);
    setError(null);
    try {
      await api.delete(`/api/auth/sessions/${target.id}`);
      if (target.current) {
        await logout();
        return;
      }
      setSessions((prev) => (prev || []).filter((s) => s.id !== target.id));
      toast.success("Session terminée");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEndLoading(false);
      setEnding(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-1 border-b p-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <MonitorSmartphone className="size-4 text-muted-foreground" /> Sessions
        </CardTitle>
        <CardDescription className="text-xs">
          Sessions Citadel ouvertes avec votre compte. Terminez celles que vous ne reconnaissez pas.
        </CardDescription>
      </CardHeader>
      {error && (
        <div className="p-4 pb-0">
          <ErrorBox message={error} />
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Appareil</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>Ouverte le</TableHead>
            <TableHead>Dernière activité</TableHead>
            <TableHead>Expire le</TableHead>
            <TableHead className="pr-4">
              <span className="sr-only">Gestion</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions === null ? (
            <TableSkeleton cols={6} rows={2} />
          ) : sessions.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                Aucune session ouverte.
              </TableCell>
            </TableRow>
          ) : (
            sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="py-2 pl-4">
                  <span className="flex items-center gap-2">
                    {s.device || "Appareil inconnu"}
                    {s.current && <Chip tone="primary">Cette session</Chip>}
                  </span>
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-muted-foreground">{s.ip_address || "-"}</TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">{formatDate(s.created_at)}</TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">{formatDate(s.last_used_at)}</TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">{formatDate(s.expires_at)}</TableCell>
                <TableCell className="py-2 pr-4 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                    onClick={() => setEnding(s)}
                  >
                    <LogOut className="size-3.5" />
                    {s.current ? "Se déconnecter" : "Terminer"}
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {ending && (
        <ConfirmModal
          title={ending.current ? "Se déconnecter" : "Terminer la session"}
          confirmLabel={ending.current ? "Se déconnecter" : "Terminer"}
          danger
          loading={endLoading}
          onConfirm={end}
          onClose={() => setEnding(null)}
        >
          {ending.current ? (
            <p>Vous terminez la session de ce navigateur et revenez à la page de connexion.</p>
          ) : (
            <p>
              La session <strong>{ending.device || "inconnue"}</strong> devra se reconnecter. Ses jetons en cours sont
              refusés immédiatement.
            </p>
          )}
        </ConfirmModal>
      )}
    </Card>
  );
}
