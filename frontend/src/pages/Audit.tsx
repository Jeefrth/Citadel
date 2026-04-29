import { Shield } from "lucide-react";

export default function Audit() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Audit Logs</h2>
      <div className="bg-card border rounded-lg p-12 text-center">
        <Shield size={48} className="mx-auto text-muted-foreground mb-4" />
        <p className="text-muted-foreground">
          Les logs d'audit seront affichés ici une fois que des actions auront
          été enregistrées.
        </p>
      </div>
    </div>
  );
}
