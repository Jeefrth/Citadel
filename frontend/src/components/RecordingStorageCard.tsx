// Settings > Audit: where new session recordings are written (local disk, S3, Azure Blob).
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";
import {
  errorMessage,
  type RecordingStorageData,
  type RecordingStorageIn,
  type RecordingStorageType,
  type StorageTestResult,
} from "@/services/types";
import { ErrorBox, Field, Notice, SaveButton, Toggle, type NoticeData } from "@/components/kit";
import { ErrorLine, RowsSkeleton, STORAGE_LABELS, SettingsCard, StatusDot, Tip } from "@/components/auditUi";

const CARD_TITLE = "Stockage des enregistrements";
const CARD_DESCRIPTION =
  "Destination des nouveaux enregistrements de sessions SSH et RDP, avec empreinte SHA-256. Les anciens enregistrements restent lisibles après un changement de stockage.";

interface Form {
  type: RecordingStorageType;
  endpoint: string;
  bucket: string;
  region: string;
  access_key: string;
  secure: boolean;
  prefix: string;
  container_url: string;
  secret: string;
}

function toForm(d: RecordingStorageData): Form {
  const c = d.config || {};
  return {
    type: d.type,
    endpoint: c.endpoint || "",
    bucket: c.bucket || "",
    region: c.region || "",
    access_key: c.access_key || "",
    secure: c.secure ?? true,
    prefix: c.prefix || "",
    container_url: c.container_url || "",
    secret: "",
  };
}

export default function RecordingStorageCard() {
  const [data, setData] = useState<RecordingStorageData | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<RecordingStorageData>("/api/admin/recording-storage");
      setData(d);
      setForm(toForm(d));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !form) {
    return (
      <SettingsCard icon={HardDrive} title={CARD_TITLE} description={CARD_DESCRIPTION}>
        {loading ? <RowsSkeleton rows={2} /> : <ErrorBox message={error} />}
      </SettingsCard>
    );
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = !data || JSON.stringify({ ...toForm(data) }) !== JSON.stringify({ ...form, secret: "" }) || form.secret !== "";
  // A secret is needed for S3 / Azure unless one is already stored for the active backend of that type
  const keepSecret = !!data && data.type === form.type && data.has_secret;
  const needsSecret = form.type !== "local" && !keepSecret && !form.secret;
  const valid =
    form.type === "local" ||
    (form.type === "s3" && form.bucket.trim() !== "" && form.access_key.trim() !== "" && !needsSecret) ||
    (form.type === "azure" && form.container_url.trim().startsWith("https://") && !needsSecret);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    const body: RecordingStorageIn =
      form.type === "s3"
        ? {
            type: "s3",
            config: {
              endpoint: form.endpoint.trim() || undefined,
              bucket: form.bucket.trim(),
              region: form.region.trim() || undefined,
              access_key: form.access_key.trim(),
              secure: form.secure,
              prefix: form.prefix.trim() || undefined,
            },
          }
        : form.type === "azure"
          ? { type: "azure", config: { container_url: form.container_url.trim(), prefix: form.prefix.trim() || undefined } }
          : { type: "local", config: {} };
    if (form.secret) body.secret = form.secret;
    try {
      const d = await api.put<RecordingStorageData>("/api/admin/recording-storage", body);
      setData(d);
      setForm(toForm(d));
      setNotice({ ok: true, text: `Stockage ${STORAGE_LABELS[d.type]} enregistré. Lancez un test pour le valider.` });
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setNotice(null);
    try {
      const r = await api.post<StorageTestResult>("/api/admin/recording-storage/test", {});
      setNotice({ ok: r.ok, text: `${STORAGE_LABELS[r.type] || r.type} : ${r.message}` });
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const secretHint = keepSecret ? "Laisser vide pour conserver la valeur enregistrée." : "Obligatoire.";

  return (
    <SettingsCard
      status={<StatusDot tone={data?.last_error ? "danger" : "success"} label={data?.last_error ? "En erreur" : "Opérationnel"} />}
      title={CARD_TITLE}
      description={CARD_DESCRIPTION}
    >
    <div className="space-y-4">
      <Notice notice={notice} onClose={() => setNotice(null)} />
      {data?.last_error && <ErrorLine>Dernière erreur : <span className="font-mono">{data.last_error}</span></ErrorLine>}

      <Field label="Type de stockage">
        <Select value={form.type} onValueChange={(v) => set("type", v as RecordingStorageType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local (disque du serveur Citadel)</SelectItem>
            <SelectItem value="s3">Compatible S3 (AWS, MinIO, Ceph...)</SelectItem>
            <SelectItem value="azure">Azure Blob Storage</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {form.type === "s3" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Endpoint" hint="Vide pour AWS S3. ex. minio.local:9000">
            <Input value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} className="font-mono" />
          </Field>
          <Field label="Région">
            <Input
              value={form.region}
              onChange={(e) => set("region", e.target.value)}
              placeholder="eu-west-1"
              className="font-mono"
            />
          </Field>
          <Field label="Bucket">
            <Input value={form.bucket} onChange={(e) => set("bucket", e.target.value)} className="font-mono" />
          </Field>
          <Field label="Préfixe" hint="Dossier dans le bucket (optionnel)">
            <Input
              value={form.prefix}
              onChange={(e) => set("prefix", e.target.value)}
              placeholder="citadel/recordings"
              className="font-mono"
            />
          </Field>
          <Field label="Access key">
            <Input
              value={form.access_key}
              onChange={(e) => set("access_key", e.target.value)}
              autoComplete="off"
              className="font-mono"
            />
          </Field>
          <Field label="Secret key" hint={secretHint}>
            <Input
              type="password"
              value={form.secret}
              onChange={(e) => set("secret", e.target.value)}
              placeholder={keepSecret ? "laisser vide pour conserver" : ""}
              autoComplete="new-password"
              className="font-mono"
            />
          </Field>
          <div className="md:col-span-2">
            <Toggle checked={form.secure} onChange={(v) => set("secure", v)} label="Connexion HTTPS (TLS)" />
          </div>
        </div>
      )}

      {form.type === "azure" && (
        <div className="space-y-3">
          <Field label="URL du conteneur" hint="https://<compte>.blob.core.windows.net/<conteneur>">
            <Input
              value={form.container_url}
              onChange={(e) => set("container_url", e.target.value)}
              placeholder="https://"
              className="font-mono"
            />
          </Field>
          <Field label="Préfixe" hint="Dossier dans le conteneur (optionnel)">
            <Input value={form.prefix} onChange={(e) => set("prefix", e.target.value)} className="font-mono" />
          </Field>
          <Field
            label="Jeton SAS"
            hint={`${secretHint} Droits nécessaires : lecture, écriture, suppression, création.`}
          >
            <Input
              type="password"
              value={form.secret}
              onChange={(e) => set("secret", e.target.value)}
              placeholder={keepSecret ? "laisser vide pour conserver" : "sv=...&sig=..."}
              autoComplete="new-password"
              className="font-mono"
            />
          </Field>
        </div>
      )}

      {form.type === "azure" && form.container_url && !form.container_url.startsWith("https://") && (
        <ErrorBox message="L'URL du conteneur doit commencer par https://" />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SaveButton onClick={save} loading={saving} disabled={!dirty || !valid} />
        <Tip content={dirty ? "Enregistrez d'abord : le test porte sur la configuration active" : undefined}>
          <span>
            <Button variant="outline" onClick={test} disabled={testing || dirty}>
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Tester le stockage
            </Button>
          </span>
        </Tip>
        {dirty && <span className="text-xs text-live">Modifications non enregistrées</span>}
      </div>
    </div>
    </SettingsCard>
  );
}
