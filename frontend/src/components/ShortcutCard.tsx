// Mon compte > search shortcut: presets or a recorded key combination, per browser.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Keyboard, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_SHORTCUT, PRESETS, formatShortcut, fromEvent, sameShortcut, useShortcut, type Shortcut,
} from "@/services/shortcut";

export default function ShortcutCard() {
  const [shortcut, setShortcut] = useShortcut();
  const [recording, setRecording] = useState(false);
  const preset = PRESETS.find((p) => sameShortcut(p.value, shortcut));

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const s: Shortcut | null = fromEvent(e);
      if (!s) {
        if (/^[a-z0-9]$/i.test(e.key)) toast.error("Ajoutez une touche de modification (Cmd, Ctrl ou Alt) à une lettre ou un chiffre.");
        return; // lone modifier: wait for the full combination
      }
      setShortcut(s);
      setRecording(false);
      toast.success(`Recherche : ${formatShortcut(s)}`);
    };
    window.addEventListener("keydown", onKey, true); // capture: before the palette listener
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, setShortcut]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-1 p-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Keyboard className="size-4" /> Raccourci de recherche
        </CardTitle>
        <CardDescription className="text-xs">
          Ouvre la recherche (serveurs, clusters, pages, actions). Enregistré dans ce navigateur seulement.
        </CardDescription>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-3 border-t p-4">
        <kbd className="rounded border bg-muted px-2 py-1 font-mono text-sm">{formatShortcut(shortcut)}</kbd>
        <Select
          value={preset?.id ?? "custom"}
          onValueChange={(id) => {
            const p = PRESETS.find((x) => x.id === id);
            if (p) {
              setShortcut(p.value);
              toast.success(`Recherche : ${formatShortcut(p.value)}`);
            }
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
            {!preset && <SelectItem value="custom">Personnalisé : {formatShortcut(shortcut)}</SelectItem>}
          </SelectContent>
        </Select>
        <Button variant={recording ? "default" : "outline"} size="sm" onClick={() => setRecording((r) => !r)}>
          {recording ? "Appuyez sur la combinaison (Échap pour annuler)" : "Enregistrer une combinaison"}
        </Button>
        {!sameShortcut(shortcut, DEFAULT_SHORTCUT) && (
          <Button variant="ghost" size="sm" onClick={() => setShortcut(null)}>
            <RotateCcw /> Par défaut
          </Button>
        )}
      </div>
    </Card>
  );
}
