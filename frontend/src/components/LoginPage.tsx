import { useEffect, useState } from "react";
import { useMsal } from "@azure/msal-react";
import { loginRequest } from "@/services/authConfig";
import { clearSignOutReason, signOutReason } from "@/services/api";
import { Info, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

// Sign-in screen. Always rendered in the dark "Salle de contrôle" palette,
// whatever theme the browser or the stored preference asks for.
export default function LoginPage() {
  const { instance } = useMsal();
  // Shown once after a forced sign-out (this browser was disconnected)
  const [reason] = useState(signOutReason);
  useEffect(() => clearSignOutReason(), []);

  const handleLogin = () => {
    instance.loginRedirect(loginRequest);
  };

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

            <div className="space-y-3">
              {reason && (
                <div role="status" className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2.5 text-sm">
                  <Info className="mt-0.5 size-4 shrink-0 text-info" />
                  <span>{reason}</span>
                </div>
              )}
              <Button onClick={handleLogin} size="lg" className="w-full px-4">
                <MicrosoftMark />
                Se connecter avec Microsoft
              </Button>
              <p className="text-xs text-muted-foreground">
                Authentification par Microsoft Entra ID. Chaque session ouverte est enregistrée.
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

/** Microsoft four-square mark, monochrome so it follows the button colour. */
function MicrosoftMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="currentColor">
      <rect x="0" y="0" width="7.5" height="7.5" />
      <rect x="8.5" y="0" width="7.5" height="7.5" opacity="0.8" />
      <rect x="0" y="8.5" width="7.5" height="7.5" opacity="0.8" />
      <rect x="8.5" y="8.5" width="7.5" height="7.5" opacity="0.6" />
    </svg>
  );
}
