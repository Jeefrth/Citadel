// Settings > Audit: where new session recordings are written (local disk, S3, Azure Blob).
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, PlugZap } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type RecordingStorageData,
  type RecordingStorageIn,
  type RecordingStorageType,
  type StorageTestResult,
} from "@/services/types";
import { ErrorBox, Field, Notice, SaveButton, Toggle, btnSecondary, inputCls, type NoticeData } from "@/components/ui";
import { STORAGE_LABELS } from "@/components/auditUi";

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
      <div className="bg-card border rounded-lg p-6">
        {loading ? <Loader2 size={20} className="animate-spin text-muted-foreground" /> : <ErrorBox message={error} />}
      </div>
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
    <div className="bg-card border rounded-lg p-6 space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <HardDrive size={18} /> Stockage des enregistrements
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Destination des nouveaux enregistrements de sessions (SSH et RDP), avec empreinte SHA-256. Les anciens
          enregistrements restent lisibles après un changement de stockage.
        </p>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      {data?.last_error && (
        <p className="text-xs text-red-700 bg-red-50 rounded px-2 py-1 break-words">
          Dernière erreur : {data.last_error}
        </p>
      )}

      <Field label="Type de stockage">
        <select
          value={form.type}
          onChange={(e) => set("type", e.target.value as RecordingStorageType)}
          className={inputCls}
        >
          <option value="local">Local (disque du serveur Citadel)</option>
          <option value="s3">S3 compatible (AWS, MinIO, Ceph...)</option>
          <option value="azure">Azure Blob Storage</option>
        </select>
      </Field>

      {form.type === "s3" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Endpoint" hint="Vide pour AWS S3. ex. minio.local:9000">
            <input value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Région">
            <input
              value={form.region}
              onChange={(e) => set("region", e.target.value)}
              placeholder="eu-west-1"
              className={inputCls}
            />
          </Field>
          <Field label="Bucket">
            <input value={form.bucket} onChange={(e) => set("bucket", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Préfixe" hint="Dossier dans le bucket (optionnel)">
            <input
              value={form.prefix}
              onChange={(e) => set("prefix", e.target.value)}
              placeholder="citadel/recordings"
              className={inputCls}
            />
          </Field>
          <Field label="Access key">
            <input
              value={form.access_key}
              onChange={(e) => set("access_key", e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field label="Secret key" hint={secretHint}>
            <input
              type="password"
              value={form.secret}
              onChange={(e) => set("secret", e.target.value)}
              placeholder={keepSecret ? "laisser vide pour conserver" : ""}
              autoComplete="new-password"
              className={inputCls}
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
            <input
              value={form.container_url}
              onChange={(e) => set("container_url", e.target.value)}
              placeholder="https://"
              className={inputCls}
            />
          </Field>
          <Field label="Préfixe" hint="Dossier dans le conteneur (optionnel)">
            <input value={form.prefix} onChange={(e) => set("prefix", e.target.value)} className={inputCls} />
          </Field>
          <Field
            label="Jeton SAS"
            hint={`${secretHint} Droits nécessaires : lecture, écriture, suppression, création.`}
          >
            <input
              type="password"
              value={form.secret}
              onChange={(e) => set("secret", e.target.value)}
              placeholder={keepSecret ? "laisser vide pour conserver" : "sv=...&sig=..."}
              autoComplete="new-password"
              className={inputCls}
            />
          </Field>
        </div>
      )}

      {form.type === "azure" && form.container_url && !form.container_url.startsWith("https://") && (
        <ErrorBox message="L'URL du conteneur doit commencer par https://" />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SaveButton onClick={save} loading={saving} disabled={!dirty || !valid} />
        <button
          onClick={test}
          disabled={testing || dirty}
          className={btnSecondary}
          title={dirty ? "Enregistrez d'abord : le test porte sur la configuration active" : undefined}
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
          Tester le stockage
        </button>
        {dirty && <span className="text-xs text-muted-foreground">Modifications non enregistrées</span>}
      </div>
    </div>
  );
}
