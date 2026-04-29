import { useMsal } from "@azure/msal-react";
import { loginRequest } from "@/services/authConfig";
import { Server } from "lucide-react";

export default function LoginPage() {
  const { instance } = useMsal();

  const handleLogin = () => {
    instance.loginRedirect(loginRequest);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-8">
        <div className="flex items-center justify-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <Server size={28} className="text-primary" />
          </div>
          <div className="text-left">
            <h1 className="text-3xl font-bold">srv_gest</h1>
            <p className="text-muted-foreground">
              Gestion centralisée de serveurs
            </p>
          </div>
        </div>

        <div className="bg-card border rounded-lg p-8 shadow-sm max-w-sm mx-auto">
          <p className="text-sm text-muted-foreground mb-6">
            Connectez-vous avec votre compte Microsoft pour accéder à
            l'application.
          </p>
          <button
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-md font-medium hover:bg-primary/90 transition-colors"
          >
            Se connecter avec Microsoft
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          Authentification via Microsoft Entra ID
        </p>
      </div>
    </div>
  );
}
