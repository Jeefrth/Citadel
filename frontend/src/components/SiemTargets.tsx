// Settings > Audit: SIEM export targets (syslog udp/tcp/tls or HTTP; JSON, CEF or HEC).
import { useCallback, useEffect, useState } from "react";
import { Loader2, MoreHorizontal, Pencil, Plus, Radio, Rewind, Send, SkipForward, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  Notice,
  SaveButton,
  Toggle,
  formatDate,
  type NoticeData,
} from "@/components/kit";
import { relativeTime } from "@/components/governanceUi";
import { ErrorLine, RowsSkeleton, SettingsCard, StatusDot, Tip } from "@/components/auditUi";

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
      title={target ? `Modifier la cible ${target.name}` : "Ajouter une cible SIEM"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid} />
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Sentinel" />
        </Field>
        <div className="flex items-end pb-2">
          <Toggle checked={isActive} onChange={setIsActive} label="Cible active" />
        </div>
        <Field label="Transport">
          <Select value={transport} onValueChange={(v) => changeTransport(v as SiemTransport)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TRANSPORT_LABELS) as SiemTransport[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {TRANSPORT_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <Select value={format} onValueChange={(v) => setFormat(v as SiemFormat)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="cef">CEF</SelectItem>
              <SelectItem value="hec" disabled={!isHttp}>
                HEC{isHttp ? "" : " (HTTP uniquement)"}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {isHttp ? (
        <div className="space-y-3">
          <Field
            label="URL"
            hint={format === "hec" ? "ex. https://splunk.example.com:8088/services/collector/event" : undefined}
          >
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="font-mono" />
          </Field>
          <Field
            label="Jeton"
            hint={target?.has_secret ? "Laisser vide pour conserver le jeton enregistré." : "Jeton d'authentification HTTP (optionnel)."}
          >
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={target?.has_secret ? "laisser vide pour conserver" : ""}
              autoComplete="new-password"
             
            />
          </Field>
          {format === "hec" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Sourcetype" hint="Optionnel">
                <Input value={sourcetype} onChange={(e) => setSourcetype(e.target.value)} />
              </Field>
              <Field label="Index" hint="Optionnel">
                <Input value={index} onChange={(e) => setIndex(e.target.value)} />
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
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="siem.example.com" className="font-mono" />
              </Field>
            </div>
            <Field label="Port" hint={`Par défaut ${defaultPort}`}>
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={String(defaultPort)}
               
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
              <Checkbox checked={streams.includes(s)} onCheckedChange={() => toggleStream(s)} />
              {STREAM_LABELS[s]}
            </label>
          ))}
        </div>
      </Field>

      {!target && (
        <Field label="Point de départ">
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                checked={startFrom === "now"}
                onChange={() => setStartFrom("now")}
                className="size-4 accent-[hsl(var(--primary))]"
              />
              À partir de maintenant (seuls les nouveaux événements)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                checked={startFrom === "beginning"}
                onChange={() => setStartFrom("beginning")}
                className="size-4 accent-[hsl(var(--primary))]"
              />
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
    <SettingsCard
      icon={Radio}
      title="Export SIEM"
      description="Le journal d'audit et le journal des commandes sont transmis en continu, au moins une fois, avec reprise après redémarrage. HEC convient à Splunk et à CrowdStrike Falcon NG-SIEM / LogScale, CEF sur syslog à Microsoft Sentinel et QRadar."
      actions={
        <Button size="sm" onClick={() => setEdit(null)}>
          <Plus /> Ajouter une cible
        </Button>
      }
    >
      <div className="space-y-3">
        <Notice notice={notice} onClose={() => setNotice(null)} />
        <ErrorBox message={error} />

        {loading ? (
          <RowsSkeleton rows={2} />
        ) : targets.length === 0 ? (
          <EmptyState
            icon={Radio}
            title="Aucune cible SIEM"
            action={
              <Button size="sm" variant="outline" onClick={() => setEdit(null)}>
                <Plus /> Ajouter une cible
              </Button>
            }
          >
            Ajoutez une cible syslog ou HTTP pour transmettre l'audit à votre SIEM.
          </EmptyState>
        ) : (
          <div className="divide-y rounded-md border">
            <AnimatePresence initial={false}>
              {targets.map((t) => (
                <motion.div
                  key={t.id}
                  layout
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <div className="pt-1.5">
                      <StatusDot
                        tone={!t.is_active ? "muted" : t.last_error ? "danger" : "success"}
                        label={!t.is_active ? "Inactive" : t.last_error ? "En erreur" : "Active"}
                      />
                    </div>
                    <div className={`min-w-0 flex-1 space-y-1 ${t.is_active ? "" : "opacity-60"}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{t.name}</span>
                        <Chip>{TRANSPORT_LABELS[t.transport] || t.transport}</Chip>
                        <Chip>{FORMAT_LABELS[t.format] || t.format}</Chip>
                        {!t.is_active && <Chip>Inactive</Chip>}
                      </div>
                      <p className="break-all font-mono text-xs text-muted-foreground">{destination(t)}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.streams.map((st) => STREAM_LABELS[st] || st).join(", ")}
                        {" · "}
                        <span className="tabular">{t.sent_count.toLocaleString("fr-FR")}</span> événement
                        {t.sent_count > 1 ? "s" : ""} envoyé{t.sent_count > 1 ? "s" : ""}
                        {" · "}dernier envoi{" "}
                        {t.last_sent_at ? (
                          <Tip content={formatDate(t.last_sent_at)}>
                            <span className="cursor-default">{relativeTime(t.last_sent_at)}</span>
                          </Tip>
                        ) : (
                          "jamais"
                        )}
                      </p>
                      {t.last_error && <ErrorLine>Dernière erreur : {t.last_error}</ErrorLine>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" onClick={() => test(t)} disabled={testing === t.id}>
                        {testing === t.id ? <Loader2 className="animate-spin" /> : <Send />}
                        Envoyer un test
                      </Button>
                      <Tip content={t.is_active ? "Désactiver" : "Activer"}>
                        <span className="flex items-center px-1.5">
                          <Switch
                            checked={t.is_active}
                            onCheckedChange={() => toggle(t)}
                            aria-label={t.is_active ? "Désactiver" : "Activer"}
                          />
                        </span>
                      </Tip>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Plus d'actions">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEdit(t)}>
                            <Pencil /> Modifier
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setPending({ kind: "now", target: t })}>
                            <SkipForward /> Repartir de maintenant
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setPending({ kind: "beginning", target: t })}>
                            <Rewind /> Tout renvoyer
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => setPending({ kind: "delete", target: t })}
                            className="text-danger focus:bg-danger/10 focus:text-danger"
                          >
                            <Trash2 /> Supprimer
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

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
    </SettingsCard>
  );
}
