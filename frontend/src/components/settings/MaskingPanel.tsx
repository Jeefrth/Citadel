// Paramètres > Masquage (lot 7): regular expressions applied to everything a
// server prints in a terminal, before the user, the live monitor and the recording.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { EyeOff, FlaskConical, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type MaskingPreset, type MaskingRule, type MaskingTestResult } from "@/services/types";
import { ErrorBox, Field } from "@/components/kit";
import { SettingsCard } from "@/components/auditUi";
import { RowAction } from "@/components/AccountsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export const MASKING_KEY = "data_masking_rules";

function parseRules(raw: string | undefined): MaskingRule[] {
  try {
    const v = JSON.parse(raw || "[]");
    if (!Array.isArray(v)) return [];
    return v.map((r) => ({
      name: String(r?.name ?? ""),
      pattern: String(r?.pattern ?? ""),
      replacement: String(r?.replacement ?? "********"),
      enabled: r?.enabled !== false,
    }));
  } catch {
    return [];
  }
}

const SAMPLE = `password=Sup3rS3cret!
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc
carte 4111 1111 1111 1111
AKIAIOSFODNN7EXAMPLE`;

export default function MaskingPanel({ value, onSaved }: { value: string | undefined; onSaved: () => void }) {
  const [rules, setRules] = useState<MaskingRule[]>(() => parseRules(value));
  const [presets, setPresets] = useState<Record<string, MaskingPreset>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(SAMPLE);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<MaskingTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => setRules(parseRules(value)), [value]);
  useEffect(() => {
    api.get<Record<string, MaskingPreset>>("/api/admin/masking/presets").then(setPresets).catch(() => {});
  }, []);

  const dirty = JSON.stringify(rules) !== JSON.stringify(parseRules(value));
  const update = (i: number, patch: Partial<MaskingRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRules((rs) => rs.filter((_, j) => j !== i));
  const addRule = (r?: MaskingPreset) =>
    setRules((rs) => [...rs, { name: r?.name ?? "", pattern: r?.pattern ?? "", replacement: r?.replacement ?? "********", enabled: true }]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/admin/settings/${MASKING_KEY}`, { value: JSON.stringify(rules) });
      toast.success("Règles de masquage enregistrées");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      setTest(await api.post<MaskingTestResult>("/api/admin/masking/test", { rules, sample }));
    } catch (e) {
      setTest(null);
      setTestError(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const presetEntries = Object.entries(presets);
  const used = new Set(rules.map((r) => r.pattern));

  return (
    <>
      <SettingsCard
        icon={EyeOff}
        title="Règles de masquage"
        description="Expressions régulières (syntaxe Python) remplacées dans la sortie des terminaux, web et proxy SSH, avant l'affichage, l'observation et l'enregistrement. Les commandes tapées sont masquées de la même façon dans le journal. 50 règles au plus."
        actions={
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Enregistrer les règles
          </Button>
        }
      >
        <div className="space-y-3">
          <ErrorBox message={error} />
          {rules.length === 0 && <p className="text-sm text-muted-foreground">Aucune règle : rien n'est masqué.</p>}
          <AnimatePresence initial={false}>
            {rules.map((r, i) => (
              <motion.div
                key={i}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 items-end gap-2 rounded-md border p-3 md:grid-cols-[1fr_2fr_1fr_auto]">
                  <Field label="Nom">
                    <Input value={r.name} onChange={(e) => update(i, { name: e.target.value })} className="h-8" />
                  </Field>
                  <Field label="Motif">
                    <Input value={r.pattern} onChange={(e) => update(i, { pattern: e.target.value })} className="h-8 font-mono text-xs" spellCheck={false} />
                  </Field>
                  <Field label="Remplacement">
                    <Input value={r.replacement} onChange={(e) => update(i, { replacement: e.target.value })} className="h-8 font-mono text-xs" spellCheck={false} />
                  </Field>
                  <div className="flex h-8 items-center gap-1">
                    <Switch checked={r.enabled} onCheckedChange={(v) => update(i, { enabled: v })} aria-label={r.enabled ? "Désactiver la règle" : "Activer la règle"} />
                    <RowAction label="Retirer la règle" danger onClick={() => remove(i)}>
                      <Trash2 />
                    </RowAction>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => addRule()}>
              <Plus /> Ajouter une règle
            </Button>
            {presetEntries.length > 0 && <span className="text-xs text-muted-foreground">Modèles :</span>}
            {presetEntries.map(([key, p]) => (
              <Button key={key} variant="outline" size="sm" onClick={() => addRule(p)} disabled={used.has(p.pattern)} title={p.pattern}>
                <Plus /> {p.name}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Dans le remplacement, <span className="font-mono">\1</span> reprend le premier groupe capturé. La recherche se
            fait par paquet de sortie : une valeur coupée entre deux paquets peut passer. C'est une réduction de
            l'exposition, pas une prévention de fuite.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={FlaskConical}
        title="Essayer les règles"
        description="Applique les règles affichées ci-dessus, même non enregistrées, à un texte d'exemple."
        actions={
          <Button variant="outline" onClick={runTest} disabled={testing || !sample}>
            {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            Essayer
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Texte">
            <Textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={6} spellCheck={false} className="font-mono text-xs" />
          </Field>
          <Field
            label={
              <>
                Résultat
                {test && (
                  <span className="tabular ml-2 font-normal text-muted-foreground">
                    {test.hits} remplacement{test.hits > 1 ? "s" : ""}
                  </span>
                )}
              </>
            }
          >
            {testError ? (
              <ErrorBox message={testError} />
            ) : (
              <pre className="min-h-[8.5rem] whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs">
                {test ? test.result : <span className="text-muted-foreground">Cliquez sur « Essayer ».</span>}
              </pre>
            )}
          </Field>
        </div>
      </SettingsCard>
    </>
  );
}
