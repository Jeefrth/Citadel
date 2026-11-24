import { Shield } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/kit";

export default function Audit() {
  return (
    <div>
      <PageHeader title="Journal d'audit" description="Actions effectuées dans Citadel, par qui et quand." />
      <EmptyState icon={Shield} title="Aucune entrée d'audit">
        Les actions apparaîtront ici dès qu'elles auront été enregistrées.
      </EmptyState>
    </div>
  );
}
