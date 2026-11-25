// Paramètres > Sauvegardes (lot 7): encrypted export of every managed account
// (passphrase never stored in clear by the UI), on demand or scheduled.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Archive, CalendarClock, KeyRound, Loader2, Play, Save, Terminal } from "lucide-react";
import { api, postBlob, saveBlob } from "@/services/api";
import { errorMessage, type BackupDestination, type BackupEntry, type BackupState, type BackupStatus } from "@/services/types";
import { Chip, type ChipTone, ErrorBox, Field, Modal, SaveButton, formatDate } from "@/components/kit";
import { SettingsCard, TableSkeleton } from "@/components/auditUi";
import { formatSize } from "@/components/opsUi";
import { CopyLine, OnceWarning } from "@/components/secretOnce";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const MIN_PASSPHRASE = 16;

const STATUS: Record<BackupStatus, { label: string; tone: ChipTone }> = {
  success: { label: "Réussie", tone: "green" },
  partial: { label: "Partielle", tone: "orange" },
  failed: { label: "Échec", tone: "red" },
  running: { label: "En cours", tone: "amber" },
};

const DEST_LABELS: Record<string, string> = {
  download: "Téléchargement",
  storage: "Stockage",
  email: "E-mail",
};

const TRIGGER_LABELS: Record<string, string> = { manual: "Manuelle", scheduled: "Planifiée" };

function parseList(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function splitEmails(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function PassphraseModal({ replacing, onClose, onSaved }: { replacing: boolean; onClose: () => void; onSaved: () => void }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = pass.length > 0 && pass.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== pass;

  const save = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.put("/api/admin/backups/passphrase", { passphrase: pass });
      toast.success("Phrase de passe enregistrée");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title={replacing ? "Changer la phrase de passe" : "Définir la phrase de passe"}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={pass.length < MIN_PASSPHRASE || pass !== confirm}>
            Enregistrer la phrase de passe
          </SaveButton>
        </>
      }
    >
      <OnceWarning title="Sans cette phrase de passe, les sauvegardes sont illisibles.">
        Citadel ne peut pas la retrouver ni la réinitialiser. Notez-la maintenant et gardez-la hors de Citadel (coffre
        papier, gestionnaire de mots de passe distinct). Les sauvegardes déjà faites restent chiffrées avec l'ancienne
        phrase.
      </OnceWarning>
      <ErrorBox message={error} />
      <Field label="Phrase de passe" hint={`${MIN_PASSPHRASE} caractères au moins. Une phrase de plusieurs mots est plus simple à retenir.`}>
        <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" autoFocus />
      </Field>
      {tooShort && <p className="-mt-2 text-xs text-danger">Encore {MIN_PASSPHRASE - pass.length} caractère(s).</p>}
      <Field label="Confirmation">
        <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
      {mismatch && <p className="-mt-2 text-xs text-danger">Les deux saisies diffèrent.</p>}
    </Modal>
  );
}

function RunModal({ defaultRecipients, onClose, onDone }: { defaultRecipients: string[]; onClose: () => void; onDone: () => void }) {
  const [dests, setDests] = useState<BackupDestination[]>(["download"]);
  const [recipients, setRecipients] = useState(defaultRecipients.join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (d: BackupDestination) => setDests((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]));

  const run = async () => {
    setLoading(true);
    setError(null);
    const body = { destinations: dests, recipients: dests.includes("email") ? splitEmails(recipients) : [] };
    try {
      if (dests.includes("download")) {
        const blob = await postBlob("/api/admin/backups/run", body);
        saveBlob(blob, `citadel-comptes-${stamp()}.cab`);
        toast.success("Sauvegarde téléchargée");
      } else {
        const r = await api.post<BackupEntry>("/api/admin/backups/run", body);
        if (r.status === "partial") toast.warning(r.message || "Sauvegarde partielle");
        else toast.success("Sauvegarde envoyée");
      }
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Sauvegarder maintenant"
      size="md"
      onClose={loading ? () => {} : onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <SaveButton onClick={run} loading={loading} disabled={dests.length === 0}>
            Sauvegarder
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-sm text-muted-foreground">
        L'archive contient tous les secrets des comptes gérés, chiffrés avec la phrase de passe. Son téléchargement est
        journalisé.
      </p>
      <div className="space-y-2">
        {(["download", "storage", "email"] as BackupDestination[]).map((d) => (
          <label key={d} className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox checked={dests.includes(d)} onCheckedChange={() => toggle(d)} className="mt-0.5" />
            <span>
              {DEST_LABELS[d]}
              <span className="block text-xs text-muted-foreground">
                {d === "download"
                  ? "Le fichier .cab est enregistré par ce navigateur."
                  : d === "storage"
                    ? "Copie dans le stockage des enregistrements (local, S3 ou Azure)."
                    : "Envoi en pièce jointe aux destinataires ci-dessous."}
              </span>
            </span>
          </label>
        ))}
      </div>
      {dests.includes("email") && (
        <Field label="Destinataires" hint="Séparés par des virgules. Vide : ceux des canaux e-mail.">
          <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="secops@exemple.ch" className="font-mono text-xs" />
        </Field>
      )}
    </Modal>
  );
}

export default function BackupsPanel({
  settings,
  onSettingsSaved,
}: {
  settings: Record<string, { value: string } | undefined>;
  onSettingsSaved: () => void;
}) {
  const [state, setState] = useState<BackupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passModal, setPassModal] = useState(false);
  const [running, setRunning] = useState(false);

  const savedInterval = settings.backup_interval_days?.value ?? "0";
  const savedDests = parseList(settings.backup_destinations?.value);
  const savedRecipients = parseList(settings.backup_email_recipients?.value);
  const [interval, setIntervalDays] = useState(savedInterval);
  const [dests, setDests] = useState<string[]>(savedDests);
  const [recipients, setRecipients] = useState(savedRecipients.join(", "));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setIntervalDays(savedInterval);
    setDests(parseList(settings.backup_destinations?.value));
    setRecipients(parseList(settings.backup_email_recipients?.value).join(", "));
  }, [settings.backup_interval_days?.value, settings.backup_destinations?.value, settings.backup_email_recipients?.value]);

  const load = useCallback(() => {
    api
      .get<BackupState>("/api/admin/backups")
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const scheduleDirty =
    interval !== savedInterval ||
    JSON.stringify([...dests].sort()) !== JSON.stringify([...savedDests].sort()) ||
    JSON.stringify(splitEmails(recipients)) !== JSON.stringify(savedRecipients);

  const saveSchedule = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const days = Math.max(0, parseInt(interval) || 0);
      await api.put("/api/admin/settings/backup_interval_days", { value: String(days) });
      await api.put("/api/admin/settings/backup_destinations", { value: JSON.stringify(dests) });
      await api.put("/api/admin/settings/backup_email_recipients", { value: JSON.stringify(splitEmails(recipients)) });
      toast.success("Planification enregistrée");
      onSettingsSaved();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleDest = (d: string) => setDests((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]));
  const hasPass = !!state?.has_passphrase;

  return (
    <>
      <ErrorBox message={error} />
      <SettingsCard
        icon={KeyRound}
        title="Phrase de passe"
        description="Chiffre chaque sauvegarde des comptes. Elle n'est ni affichée ni récupérable."
        status={state ? <Chip tone={hasPass ? "green" : "amber"}>{hasPass ? "Définie" : "Non définie"}</Chip> : undefined}
        actions={
          <Button variant={hasPass ? "outline" : "default"} onClick={() => setPassModal(true)} disabled={!state}>
            <KeyRound /> {hasPass ? "Changer la phrase de passe" : "Définir la phrase de passe"}
          </Button>
        }
      />

      <SettingsCard
        icon={Archive}
        title="Sauvegarde à la demande"
        description="Exporte tous les comptes gérés et leurs secrets dans une archive chiffrée."
        actions={
          <Button onClick={() => setRunning(true)} disabled={!hasPass}>
            <Play /> Sauvegarder maintenant
          </Button>
        }
      >
        <div className="space-y-2">
          {!hasPass && state && <p className="text-sm text-live">Définissez d'abord une phrase de passe.</p>}
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Terminal className="size-3.5" /> Déchiffrer une archive (depuis le conteneur backend, la phrase de passe est demandée)
          </p>
          <CopyLine value="python -m app.cli backup-decrypt fichier.cab -o comptes.json" label="Copier la commande" />
          <p className="text-xs text-muted-foreground">
            Le fichier obtenu contient les secrets en clair : supprimez-le dès qu'il n'est plus utile.
          </p>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={CalendarClock}
        title="Sauvegarde planifiée"
        description="Tous les N jours, vers le stockage des enregistrements et / ou par e-mail. 0 : seulement à la demande."
        actions={
          scheduleDirty ? (
            <Button onClick={saveSchedule} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Enregistrer la planification
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-4">
          <ErrorBox message={saveError} />
          <div className="flex flex-wrap items-end gap-6">
            <Field label="Intervalle (jours)">
              <Input type="number" min={0} value={interval} onChange={(e) => setIntervalDays(e.target.value)} className="tabular h-8 w-24 text-right" />
            </Field>
            <div className="flex items-center gap-4 pb-1.5">
              {["storage", "email"].map((d) => (
                <label key={d} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={dests.includes(d)} onCheckedChange={() => toggleDest(d)} />
                  {DEST_LABELS[d]}
                </label>
              ))}
            </div>
          </div>
          {dests.includes("email") && (
            <Field label="Destinataires" hint="Séparés par des virgules. Vide : ceux des canaux e-mail.">
              <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="secops@exemple.ch" className="font-mono text-xs" />
            </Field>
          )}
          {interval !== "0" && !hasPass && state && (
            <p className="text-sm text-live">Aucune sauvegarde planifiée ne partira sans phrase de passe.</p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="Historique" description="Les 50 dernières sauvegardes. Un échec de sauvegarde planifiée est notifié." className="[&>div:last-child]:p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Date</TableHead>
              <TableHead>Déclenchement</TableHead>
              <TableHead>Destinations</TableHead>
              <TableHead>Résultat</TableHead>
              <TableHead className="text-right">Comptes</TableHead>
              <TableHead className="text-right">Taille</TableHead>
              <TableHead className="pr-5">Empreinte</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!state ? (
              <TableSkeleton cols={7} rows={3} />
            ) : state.history.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  Aucune sauvegarde pour l'instant.
                </TableCell>
              </TableRow>
            ) : (
              state.history.map((b) => {
                const st = STATUS[b.status] || { label: b.status, tone: "default" as ChipTone };
                return (
                  <TableRow key={b.id}>
                    <TableCell className="tabular whitespace-nowrap py-2 pl-5 text-xs">{formatDate(b.created_at)}</TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">{TRIGGER_LABELS[b.trigger] || b.trigger}</TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {(b.destinations || []).map((d) => DEST_LABELS[d] || d).join(", ") || "-"}
                    </TableCell>
                    <TableCell className="py-2">
                      <Chip tone={st.tone} title={b.message || undefined}>
                        {st.label}
                      </Chip>
                      {b.message && b.status !== "success" && <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">{b.message}</p>}
                    </TableCell>
                    <TableCell className="tabular py-2 text-right text-xs">{b.accounts ?? "-"}</TableCell>
                    <TableCell className="tabular py-2 text-right text-xs text-muted-foreground">{formatSize(b.size_bytes)}</TableCell>
                    <TableCell className="py-2 pr-5 font-mono text-xs text-muted-foreground" title={[b.sha256, b.storage_key].filter(Boolean).join("\n")}>
                      {b.sha256 ? `${b.sha256.slice(0, 12)}...` : "-"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </SettingsCard>

      {passModal && (
        <PassphraseModal
          replacing={hasPass}
          onClose={() => setPassModal(false)}
          onSaved={() => {
            setPassModal(false);
            load();
          }}
        />
      )}
      {running && (
        <RunModal
          defaultRecipients={savedRecipients}
          onClose={() => setRunning(false)}
          onDone={() => {
            setRunning(false);
            load();
          }}
        />
      )}
    </>
  );
}
