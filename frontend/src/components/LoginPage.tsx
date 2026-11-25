import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowRight, Info, Loader2, ShieldCheck } from "lucide-react";
import { clearSignOutReason, signOutReason } from "@/services/api";
import { apiConfig } from "@/services/authConfig";
import { signInUrl } from "@/services/session";
import type { AuthProvider } from "@/services/types";
import { ProviderIcon } from "@/components/providerUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

/** Public endpoints: plain fetch, no session involved. */
async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiConfig.baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return res.json() as Promise<T>;
}

/** Read ?auth_error= once and remove it from the address bar; the rest is the return path. */
function takeAuthParams(): { authError: string | null; returnTo: string } {
  const url = new URL(window.location.href);
  const authError = url.searchParams.get("auth_error");
  if (authError !== null) {
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return { authError, returnTo: `${url.pathname}${url.search}` || "/" };
}

// Sign-in screen. Always rendered in the dark "Salle de contrôle" palette,
// whatever theme the browser or the stored preference asks for.
export default function LoginPage() {
  // Shown once after a forced sign-out (this browser was disconnected)
  const [reason] = useState(signOutReason);
  useEffect(() => clearSignOutReason(), []);
  const [{ authError, returnTo }] = useState(takeAuthParams);

  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [providersError, setProvidersError] = useState(false);
  const [company, setCompany] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [found, setFound] = useState<AuthProvider[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    publicJson<AuthProvider[]>("/api/auth/providers")
      .then(setProviders)
      .catch(() => {
        setProviders([]);
        setProvidersError(true);
      });
  }, []);

  const go = (p: AuthProvider, hint?: string) => {
    setLeaving(p.id);
    window.location.assign(signInUrl(p.id, returnTo, hint));
  };

  const discover = async (e: FormEvent) => {
    e.preventDefault();
    const value = company.trim();
    if (!value) return;
    setDiscovering(true);
    setDiscoverError(null);
    setFound(null);
    try {
      const list = await publicJson<AuthProvider[]>("/api/auth/discover", {
        method: "POST",
        body: JSON.stringify({ value }),
      });
      const hint = value.includes("@") ? value : undefined;
      if (list.length === 1) {
        go(list[0], hint);
        return;
      }
      if (list.length === 0) setDiscoverError("Aucun SSO d'entreprise trouvé pour cette adresse ou cette organisation.");
      else setFound(list);
    } catch {
      setDiscoverError("Recherche impossible pour le moment. Réessayez dans un instant.");
    } finally {
      setDiscovering(false);
    }
  };

  const hint = company.trim().includes("@") ? company.trim() : undefined;

  return (
    <div className="dark">
      <main className="flex min-h-screen flex-col bg-background px-4 text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm space-y-8">
            <div className="space-y-4">
              <div className="flex size-10 items-center justify-center rounded-lg border bg-card">
                <ShieldCheck className="size-5 text-foreground" strokeWidth={1.75} />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight">Citadel</h1>
                <p className="text-base text-muted-foreground">
                  Le bastion d'accès de l'équipe infra : sessions SSH et RDP tracées, règles d'accès et validations
                  au même endroit.
                </p>
              </div>
            </div>

            <div className="space-y-5">
              {reason && (
                <div role="status" className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2.5 text-sm">
                  <Info className="mt-0.5 size-4 shrink-0 text-info" />
                  <span>{reason}</span>
                </div>
              )}
              {authError && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                  <span className="min-w-0 break-words">Connexion impossible : {authError}</span>
                </div>
              )}

              {/* Platform providers */}
              {providers === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                providers.length > 0 && (
                  <div className="space-y-2">
                    {providers.map((p) => (
                      <Button
                        key={p.id}
                        size="lg"
                        className="w-full justify-start px-4"
                        disabled={leaving !== null}
                        onClick={() => go(p)}
                      >
                        {leaving === p.id ? <Loader2 className="animate-spin" /> : <ProviderIcon kind={p.kind} />}
                        Se connecter avec {p.name}
                      </Button>
                    ))}
                  </div>
                )
              )}
              {providersError && (
                <p className="text-xs text-muted-foreground">
                  La liste des fournisseurs n'a pas pu être chargée. Le SSO de votre entreprise reste disponible.
                </p>
              )}

              {/* Company SSO */}
              <form onSubmit={discover} className="space-y-2">
                {providers !== null && providers.length > 0 && (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    ou
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <Label htmlFor="company-sso" className="text-sm font-medium">
                  SSO de mon entreprise
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="company-sso"
                    value={company}
                    onChange={(e) => {
                      setCompany(e.target.value);
                      setFound(null);
                      setDiscoverError(null);
                    }}
                    placeholder="Adresse e-mail ou identifiant d'organisation"
                    autoComplete="email"
                    className="h-10"
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    size="icon"
                    className="size-10 shrink-0"
                    disabled={!company.trim() || discovering || leaving !== null}
                    aria-label="Continuer"
                  >
                    {discovering ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                  </Button>
                </div>
                {discoverError && <p className="text-sm text-danger">{discoverError}</p>}
                {found && found.length > 1 && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">Plusieurs fournisseurs correspondent. Choisissez le vôtre :</p>
                    {found.map((p) => (
                      <Button
                        key={p.id}
                        variant="outline"
                        className="w-full justify-start"
                        disabled={leaving !== null}
                        onClick={() => go(p, hint)}
                        type="button"
                      >
                        {leaving === p.id ? <Loader2 className="animate-spin" /> : <ProviderIcon kind={p.kind} />}
                        {p.name}
                      </Button>
                    ))}
                  </div>
                )}
              </form>

              <p className="text-xs text-muted-foreground">
                Chaque session ouverte est enregistrée. Un compte n'est ouvert que sur invitation ou par le SSO de votre
                organisation.
              </p>
            </div>
          </div>
        </div>
        <footer className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          Accès réservé aux comptes autorisés
        </footer>
      </main>
    </div>
  );
}
