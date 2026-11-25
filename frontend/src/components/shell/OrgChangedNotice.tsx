// Blocking notice shown when another tab switched organisation. Until this tab is
// reloaded it keeps sending its own (old) organisation, never the new one.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { onOrgChangedElsewhere, orgChangedElsewhere } from "@/services/org";
import { Button } from "@/components/ui/button";

export default function OrgChangedNotice() {
  const [changed, setChanged] = useState(orgChangedElsewhere());

  useEffect(() => onOrgChangedElsewhere(setChanged), []);

  if (!changed) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="org-changed-title"
        aria-describedby="org-changed-text"
        className="w-full max-w-md space-y-4 rounded-lg border bg-card p-5 shadow-sm"
      >
        <div className="space-y-1">
          <h2 id="org-changed-title" className="text-base font-semibold">
            L'organisation a changé dans un autre onglet
          </h2>
          <p id="org-changed-text" className="text-sm text-muted-foreground">
            Cet onglet reste sur l'ancienne organisation tant qu'il n'est pas rechargé. Rechargez-le pour continuer dans
            l'organisation choisie.
          </p>
        </div>
        <div className="flex justify-end">
          <Button autoFocus onClick={() => window.location.assign("/")}>
            <RefreshCw /> Recharger
          </Button>
        </div>
      </div>
    </div>
  );
}
