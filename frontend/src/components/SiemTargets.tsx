// Settings > Audit: SIEM export targets (syslog udp/tcp/tls or HTTP; JSON, CEF or HEC).
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Radio, Rewind, Send, SkipForward, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type OperationMessage,
  type SiemFormat,
  type SiemStream,
  type SiemTargetData,
  type SiemTargetIn,
  type SiemTransport,
} from "@/services/types";
import {
  Chip,
  ConfirmModal,
  ErrorBox,
  Field,
  Modal,
  Notice,
  SaveButton,
  Toggle,
  btnPrimary,
  btnSecondary,
  formatDate,
  iconBtn,
  iconBtnDanger,
  inputCls,
  type NoticeData,
} from "@/components/ui";
import { relativeTime } from "@/components/governanceUi";

const TRANSPORT_LABELS: Record<SiemTransport, string> = {
  udp: "Syslog UDP",
  tcp: "Syslog TCP",
  tls: "Syslog TLS",
  http: "HTTP(S)",
};

const FORMAT_LABELS: Record<SiemFormat, string> = {
  json: "JSON",
  cef: "CEF",
  hec: "HEC",
};

const STREAM_LABELS: Record<SiemStream, string> = {
  audit: "Journal d'audit",
  commands: "Journal des commandes",
};

const ALL_STREAMS: SiemStream[] = ["audit", "commands"];

function destination(t: Pick<SiemTargetData, "transport" | "config">): string {
  if (t.transport === "http") return t.config.url || "-";
  return `${t.config.host || "?"}:${t.config.port || (t.transport === "tls" ? 6514 : 514)}`;
}

function TargetModal({
  target,
  onClose,
  onSaved,
}: {
  target: SiemTargetData | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const c0 = target?.config || {};
  const [name, setName] = useState(target?.name || "");
  const [isActive, setIsActive] = useState(target?.is_active ?? true);
  const [transport, setTransport] = useState<SiemTransport>(target?.transport || "tcp");
  const [format, setFormat] = useState<SiemFormat>(target?.format || "json");
  const [host, setHost] = useState(c0.host || "");
  const [port, setPort] = useState<string>(c0.port ? String(c0.port) : "");
  const [url, setUrl] = useState(c0.url || "");
  const [verifyTls, setVerifyTls] = useState(c0.verify_tls ?? true);
  const [sourcetype, setSourcetype] = useState(c0.sourcetype || "");
  const [index, setIndex] = useState(c0.index || "");
  const [bearer, setBearer] = useState(c0.bearer ?? false);
  const [secret, setSecret] = useState("");
  const [streams, setStreams] = useState<SiemStream[]>(target?.streams || ["audit", "commands"]);
  const [startFrom, setStartFrom] = useState<"now" | "beginning">("now");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isHttp = transport === "http";
  const defaultPort = transport === "tls" ? 6514 : 514;
  const portNum = port.trim() === "" ? defaultPort : Number(port);
  const portOk = Number.isInteger(portNum) && portNum > 0 && portNum < 65536;
  const valid =
    name.trim() !== "" &&
    streams.length > 0 &&
    (isHttp ? /^https?:\/\//.test(url.trim()) : host.trim() !== "" && portOk);

  const changeTransport = (t: SiemTransport) => {
    setTransport(t);
    if (t !== "http" && format === "hec") setFormat("cef");
  };

  const toggleStream = (s: SiemStream) =>
    setStreams((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const save = async () => {
    setLoading(true);
    setError(null);
    const config = isHttp
      ? {
          url: url.trim(),
          verify_tls: verifyTls,
          ...(format === "hec"
            ? { sourcetype: sourcetype.trim() || undefined, index: index.trim() || undefined, bearer }
            : {}),
        }
      : { host: host.trim(), port: portNum, ...(transport === "tls" ? { verify_tls: verifyTls } : {}) };
    const body: SiemTargetIn = { name: name.trim(), is_active: isActive, transport, format, config, streams };
    if (isHttp && secret) body.secret = secret;
    try {
      if (target) {
        await api.patch(`/api/siem-targets/${target.id}`, body);
      } else {
        await api.post("/api/siem-targets", { ...body, start_from: startFrom });
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={target ? `Modifier ${target.name}` : "Nouvelle cible SIEM"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid} />
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Nom">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="ex. Sentinel" />
        </Field>
        <div className="flex items-end pb-2">
          <Toggle checked={isActive} onChange={setIsActive} label="Cible active" />
        </div>
        <Field label="Transport">
          <select value={transport} onChange={(e) => changeTransport(e.target.value as SiemTransport)} className={inputCls}>
            {(Object.keys(TRANSPORT_LABELS) as SiemTransport[]).map((t) => (
              <option key={t} value={t}>
                {TRANSPORT_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Format"
          hint={
            format === "hec"
              ? "Splunk HTTP Event Collector : Splunk, CrowdStrike Falcon NG-SIEM / LogScale (ingestion HEC)."
              : format === "cef"
                ? "ArcSight CEF : Microsoft Sentinel (agent AMA), QRadar..."
                : "Un objet JSON par événement."
          }
        >
          <select value={format} onChange={(e) => setFormat(e.target.value as SiemFormat)} className={inputCls}>
            <option value="json">JSON</option>
            <option value="cef">CEF</option>
            <option value="hec" disabled={!isHttp}>
              HEC{isHttp ? "" : " (HTTP uniquement)"}
            </option>
          </select>
        </Field>
      </div>

      {isHttp ? (
        <div className="space-y-3">
          <Field
            label="URL"
            hint={format === "hec" ? "ex. https://splunk.example.com:8088/services/collector/event" : undefined}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className={inputCls} />
          </Field>
          <Field
            label="Jeton"
            hint={target?.has_secret ? "Laisser vide pour conserver le jeton enregistré." : "Jeton d'authentification HTTP (optionnel)."}
          >
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={target?.has_secret ? "laisser vide pour conserver" : ""}
              autoComplete="new-password"
              className={inputCls}
            />
          </Field>
          {format === "hec" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Sourcetype" hint="Optionnel">
                <input value={sourcetype} onChange={(e) => setSourcetype(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Index" hint="Optionnel">
                <input value={index} onChange={(e) => setIndex(e.target.value)} className={inputCls} />
              </Field>
              <div className="md:col-span-2">
                <Toggle
                  checked={bearer}
                  onChange={setBearer}
                  label='En-tête "Authorization: Bearer" au lieu de "Splunk" (LogScale / NG-SIEM)'
                />
              </div>
            </div>
          )}
          <Toggle checked={verifyTls} onChange={setVerifyTls} label="Vérifier le certificat TLS" />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <Field label="Hôte">
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="siem.example.com" className={inputCls} />
              </Field>
            </div>
            <Field label="Port" hint={`Par défaut ${defaultPort}`}>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={String(defaultPort)}
                className={inputCls}
              />
            </Field>
          </div>
          {transport === "tls" && (
            <Toggle checked={verifyTls} onChange={setVerifyTls} label="Vérifier le certificat TLS" />
          )}
          {transport === "udp" && (
            <p className="text-xs text-muted-foreground">
              UDP ne garantit pas la livraison : préférez TCP ou TLS pour un journal d'audit.
            </p>
          )}
        </div>
      )}

      <Field label="Flux envoyés">
        <div className="flex flex-wrap gap-4">
          {ALL_STREAMS.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={streams.includes(s)} onChange={() => toggleStream(s)} className="w-4 h-4" />
              {STREAM_LABELS[s]}
            </label>
          ))}
        </div>
      </Field>

      {!target && (
        <Field label="Point de départ">
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" checked={startFrom === "now"} onChange={() => setStartFrom("now")} />
              À partir de maintenant (seuls les nouveaux événements)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" checked={startFrom === "beginning"} onChange={() => setStartFrom("beginning")} />
              Depuis le début (tout l'historique est envoyé)
            </label>
          </div>
        </Field>
      )}
    </Modal>
  );
}

type Pending = { kind: "delete" | "now" | "beginning"; target: SiemTargetData };

export default function SiemTargetsPanel() {
  const [targets, setTargets] = useState<SiemTargetData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [edit, setEdit] = useState<SiemTargetData | null | undefined>(undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTargets(await api.get<SiemTargetData[]>("/api/siem-targets"));
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

  const test = async (t: SiemTargetData) => {
    setTesting(t.id);
    setNotice(null);
    try {
      const r = await api.post<OperationMessage>(`/api/siem-targets/${t.id}/test`, {});
      setNotice({ ok: r.ok, text: `${t.name} : ${r.message}` });
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(null);
    }
  };

  const toggle = async (t: SiemTargetData) => {
    try {
      const u = await api.patch<SiemTargetData>(`/api/siem-targets/${t.id}`, { is_active: !t.is_active });
      setTargets((prev) => prev.map((x) => (x.id === t.id ? u : x)));
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    }
  };

  const runPending = async () => {
    if (!pending) return;
    const { kind, target } = pending;
    setBusy(true);
    try {
      if (kind === "delete") {
        await api.delete(`/api/siem-targets/${target.id}`);
        setNotice({ ok: true, text: `Cible ${target.name} supprimée.` });
      } else {
        await api.post(`/api/siem-targets/${target.id}/cursor`, { position: kind });
        setNotice({
          ok: true,
          text:
            kind === "now"
              ? `${target.name} : l'envoi reprend à partir de maintenant.`
              : `${target.name} : tout l'historique va être renvoyé.`,
        });
      }
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="bg-card border rounded-lg p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-[18rem]">
          <h3 className="font-semibold flex items-center gap-2">
            <Radio size={18} /> Export SIEM
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Le journal d'audit et le journal des commandes sont transmis en continu (au moins une fois, reprise après
            redémarrage). HEC fonctionne avec Splunk et l'ingestion HEC de CrowdStrike Falcon NG-SIEM / LogScale ; CEF
            sur syslog convient à Microsoft Sentinel et QRadar.
          </p>
        </div>
        <button onClick={() => setEdit(null)} className={btnPrimary}>
          <Plus size={16} /> Nouvelle cible
        </button>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : targets.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Aucune cible SIEM configurée.</p>
      ) : (
        <div className="space-y-3">
          {targets.map((t) => (
            <div key={t.id} className={`border rounded-lg p-4 ${t.is_active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Chip>{TRANSPORT_LABELS[t.transport] || t.transport}</Chip>
                    <Chip tone="primary">{FORMAT_LABELS[t.format] || t.format}</Chip>
                    {t.is_active ? <Chip tone="green">Active</Chip> : <Chip>Inactive</Chip>}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono break-all">{destination(t)}</p>
                  <div className="flex flex-wrap gap-1">
                    {t.streams.map((s) => (
                      <Chip key={s} tone="blue">
                        {STREAM_LABELS[s] || s}
                      </Chip>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t.sent_count.toLocaleString("fr-FR")} événement{t.sent_count > 1 ? "s" : ""} envoyé
                    {t.sent_count > 1 ? "s" : ""} · dernier envoi :{" "}
                    {t.last_sent_at ? (
                      <span title={formatDate(t.last_sent_at)}>{relativeTime(t.last_sent_at)}</span>
                    ) : (
                      "jamais"
                    )}
                  </p>
                  {t.last_error && (
                    <p className="text-xs text-red-700 bg-red-50 rounded px-2 py-1 break-words">
                      Dernière erreur : {t.last_error}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-1">
                    <button onClick={() => test(t)} disabled={testing === t.id} className={btnSecondary}>
                      {testing === t.id ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                      Envoyer un test
                    </button>
                    <Toggle
                      checked={t.is_active}
                      onChange={() => toggle(t)}
                      label=""
                      title={t.is_active ? "Désactiver" : "Activer"}
                    />
                    <button onClick={() => setEdit(t)} className={iconBtn} title="Modifier">
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => setPending({ kind: "delete", target: t })} className={iconBtnDanger} title="Supprimer">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPending({ kind: "now", target: t })}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent"
                    >
                      <SkipForward size={13} /> Repartir de maintenant
                    </button>
                    <button
                      onClick={() => setPending({ kind: "beginning", target: t })}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent"
                    >
                      <Rewind size={13} /> Tout renvoyer
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {edit !== undefined && (
        <TargetModal
          target={edit}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            load();
          }}
        />
      )}
      {pending && (
        <ConfirmModal
          title={
            pending.kind === "delete"
              ? `Supprimer la cible ${pending.target.name}`
              : pending.kind === "now"
                ? `Repartir de maintenant (${pending.target.name})`
                : `Tout renvoyer (${pending.target.name})`
          }
          confirmLabel={pending.kind === "delete" ? "Supprimer" : pending.kind === "now" ? "Repartir de maintenant" : "Tout renvoyer"}
          danger={pending.kind === "delete"}
          loading={busy}
          onConfirm={runPending}
          onClose={() => setPending(null)}
        >
          {pending.kind === "delete" && <p>Les événements ne seront plus transmis à cette cible.</p>}
          {pending.kind === "now" && (
            <p>
              Les événements en attente d'envoi sont ignorés : seuls les événements à venir seront transmis. Utile
              après une longue panne du SIEM.
            </p>
          )}
          {pending.kind === "beginning" && (
            <p>
              Tout l'historique (audit et commandes) sera renvoyé depuis le début. Le SIEM recevra des doublons des
              événements déjà transmis.
            </p>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}
