// "Notifications" tab of the settings page: external channels (e-mail, Teams, webhook).
import { useCallback, useEffect, useState } from "react";
import { Bell, Loader2, Mail, MessageSquare, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type ChannelType,
  type EmailChannelConfig,
  type NotificationChannelData,
  type NotificationChannelIn,
  type NotificationEvent,
  type NotificationLevel,
  type OperationMessage,
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
} from "@/components/kit";
import { LEVEL_INFO, relativeTime } from "@/components/governanceUi";

const TYPE_INFO: Record<ChannelType, { label: string; icon: typeof Mail }> = {
  email: { label: "E-mail (SMTP)", icon: Mail },
  teams: { label: "Microsoft Teams", icon: MessageSquare },
  webhook: { label: "Webhook", icon: Webhook },
};

const LEVELS: NotificationLevel[] = ["info", "warning", "critical"];

// ── Channel dialog ───────────────────────────────────────────

function ChannelModal({
  channel,
  events,
  onClose,
  onSaved,
}: {
  channel: NotificationChannelData | null;
  events: NotificationEvent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(channel?.name || "");
  const [type, setType] = useState<ChannelType>(channel?.type || "email");
  const [isActive, setIsActive] = useState(channel?.is_active ?? true);
  const cfg0: EmailChannelConfig = channel?.config || {};
  const [host, setHost] = useState(cfg0.host || "");
  const [port, setPort] = useState<number>(cfg0.port || 587);
  const [starttls, setStarttls] = useState(cfg0.starttls ?? true);
  const [username, setUsername] = useState(cfg0.username || "");
  const [sender, setSender] = useState(cfg0.sender || "");
  const [to, setTo] = useState((cfg0.to || []).join(", "));
  const [toRecipients, setToRecipients] = useState(cfg0.to_recipients ?? true);
  const [secret, setSecret] = useState("");
  const [allEvents, setAllEvents] = useState(!channel || channel.events.length === 0);
  const [selEvents, setSelEvents] = useState<string[]>(channel?.events || []);
  const [minLevel, setMinLevel] = useState<NotificationLevel>(channel?.min_level || "info");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEmail = type === "email";
  const toList = to
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const badMail = toList.filter((x) => !/^[^@\s]+@[^@\s]+$/.test(x));
  const needsSecret = !isEmail && !channel?.has_secret;
  const urlOk = isEmail || !secret || /^https?:\/\//.test(secret);
  const valid =
    name.trim() !== "" &&
    (!isEmail || host.trim() !== "") &&
    badMail.length === 0 &&
    (!needsSecret || secret.trim() !== "") &&
    urlOk &&
    (allEvents || selEvents.length > 0);

  const save = async () => {
    setLoading(true);
    setError(null);
    const config: EmailChannelConfig = isEmail
      ? {
          host: host.trim(),
          port,
          starttls,
          username: username.trim() || undefined,
          sender: sender.trim() || undefined,
          to: toList,
          to_recipients: toRecipients,
        }
      : {};
    const body: NotificationChannelIn = {
      name: name.trim(),
      type,
      is_active: isActive,
      config,
      events: allEvents ? [] : selEvents,
      min_level: minLevel,
    };
    if (secret) body.secret = secret;
    try {
      if (channel) {
        // type is fixed after creation (not part of the update schema)
        const { type: _t, ...patch } = body;
        void _t;
        await api.patch(`/api/notification-channels/${channel.id}`, patch);
      } else {
        await api.post("/api/notification-channels", body);
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleEvent = (ev: string) =>
    setSelEvents((prev) => (prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]));

  return (
    <Modal
      title={channel ? `Modifier le canal ${channel.name}` : "Nouveau canal de notification"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <button onClick={onClose} className={btnSecondary}>
            Annuler
          </button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {channel ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Nom *">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoFocus />
        </Field>
        <Field label="Type" hint={channel ? "Le type ne peut plus être modifié." : undefined}>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ChannelType)}
            disabled={!!channel}
            className={inputCls}
          >
            {(Object.keys(TYPE_INFO) as ChannelType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_INFO[t].label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Toggle checked={isActive} onChange={setIsActive} label="Canal actif" />

      {isEmail ? (
        <div className="border-t pt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <Field label="Serveur SMTP *">
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="smtp.office365.com"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="Port" hint="465 = TLS implicite.">
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className={inputCls}
              />
            </Field>
          </div>
          <Toggle
            checked={starttls}
            onChange={setStarttls}
            disabled={port === 465}
            label="STARTTLS"
            title="Ignoré sur le port 465 (TLS implicite)"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Utilisateur SMTP">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                className={inputCls}
              />
            </Field>
            <Field
              label="Mot de passe SMTP"
              hint={channel?.has_secret ? "Laisser vide pour conserver le mot de passe actuel." : undefined}
            >
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                placeholder={channel?.has_secret ? "••••••••" : ""}
                className={inputCls}
              />
            </Field>
            <Field label="Expéditeur" hint="Par défaut : l'utilisateur SMTP.">
              <input
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                placeholder="citadel@exemple.com"
                className={inputCls}
              />
            </Field>
            <Field label="Destinataires fixes" hint="Adresses séparées par des virgules.">
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="soc@exemple.com, it@exemple.com"
                className={inputCls}
              />
              {badMail.length > 0 && (
                <p className="text-xs text-red-700 mt-1">Adresse invalide : {badMail.join(", ")}</p>
              )}
            </Field>
          </div>
          <Toggle
            checked={toRecipients}
            onChange={setToRecipients}
            label="Écrire aussi aux utilisateurs concernés (valideurs, demandeur...)"
          />
        </div>
      ) : (
        <div className="border-t pt-4">
          <Field
            label={type === "teams" ? "URL du workflow Teams *" : "URL du webhook *"}
            hint={
              <>
                {type === "teams"
                  ? "Teams > canal > Workflows > « Publier dans un canal lorsqu'une requête webhook est reçue »."
                  : "Reçoit un POST JSON par événement."}
                {channel?.has_secret && " Laisser vide pour conserver l'URL actuelle (elle n'est jamais réaffichée)."}
              </>
            }
          >
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              placeholder={channel?.has_secret ? "URL enregistrée" : "https://..."}
              className={`${inputCls} font-mono`}
            />
            {!urlOk && <p className="text-xs text-red-700 mt-1">L'URL doit commencer par https://</p>}
          </Field>
        </div>
      )}

      <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <Field label="Événements">
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={allEvents}
                onChange={(e) => setAllEvents(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              Tous les événements
            </label>
            <div className={`space-y-1.5 pl-6 ${allEvents ? "opacity-40 pointer-events-none" : ""}`}>
              {events.map((ev) => (
                <label key={ev.event} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allEvents || selEvents.includes(ev.event)}
                    onChange={() => toggleEvent(ev.event)}
                    className="w-4 h-4 rounded"
                  />
                  {ev.label}
                  <span className="text-xs text-muted-foreground font-mono">{ev.event}</span>
                </label>
              ))}
            </div>
            {!allEvents && selEvents.length === 0 && (
              <p className="text-xs text-red-700 mt-1">Choisissez au moins un événement.</p>
            )}
          </Field>
        </div>
        <Field label="Niveau minimal">
          <select
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as NotificationLevel)}
            className={inputCls}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_INFO[l].label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ── Panel ────────────────────────────────────────────────────

export default function NotificationChannelsPanel() {
  const [channels, setChannels] = useState<NotificationChannelData[]>([]);
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [edit, setEdit] = useState<NotificationChannelData | null | undefined>(undefined);
  const [del, setDel] = useState<NotificationChannelData | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, e] = await Promise.all([
        api.get<NotificationChannelData[]>("/api/notification-channels"),
        api.get<NotificationEvent[]>("/api/notification-events"),
      ]);
      setChannels(c);
      // "test" is only used by the test button
      setEvents(e.filter((x) => x.event !== "test"));
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

  const eventLabel = (ev: string) => events.find((x) => x.event === ev)?.label || ev;

  const test = async (c: NotificationChannelData) => {
    setTesting(c.id);
    setNotice(null);
    try {
      const r = await api.post<OperationMessage>(`/api/notification-channels/${c.id}/test`, {});
      setNotice({ ok: r.ok, text: `${c.name} : ${r.message}` });
      load();
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(null);
    }
  };

  const toggle = async (c: NotificationChannelData) => {
    try {
      const updated = await api.patch<NotificationChannelData>(`/api/notification-channels/${c.id}`, {
        is_active: !c.is_active,
      });
      setChannels((prev) => prev.map((x) => (x.id === c.id ? updated : x)));
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    }
  };

  const doDelete = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await api.delete(`/api/notification-channels/${del.id}`);
      setChannels((prev) => prev.filter((x) => x.id !== del.id));
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      setDel(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground flex-1 min-w-[18rem]">
          Les notifications apparaissent toujours dans Citadel (cloche). Les canaux ci-dessous les relaient en
          plus par e-mail, dans Teams ou vers un webhook, selon les événements et le niveau choisis.
        </p>
        <button onClick={() => setEdit(null)} className={btnPrimary}>
          <Plus size={16} /> Nouveau canal
        </button>
      </div>
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <ErrorBox message={error} />

      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </div>
      ) : channels.length === 0 ? (
        <div className="bg-card border rounded-lg p-12 text-center">
          <Bell size={48} className="mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Aucun canal externe configuré.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map((c) => {
            const info = TYPE_INFO[c.type] || TYPE_INFO.webhook;
            const Icon = info.icon;
            return (
              <div key={c.id} className={`bg-card border rounded-lg p-4 ${c.is_active ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Icon size={18} />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Chip>{info.label}</Chip>
                      {c.is_active ? <Chip tone="green">Actif</Chip> : <Chip>Inactif</Chip>}
                      <Chip tone={LEVEL_INFO[c.min_level]?.tone || "default"}>
                        dès {LEVEL_INFO[c.min_level]?.label.toLowerCase() || c.min_level}
                      </Chip>
                    </div>
                    {c.type === "email" && (
                      <p className="text-xs text-muted-foreground">
                        {c.config.host}:{c.config.port || 587}
                        {(c.config.to || []).length > 0 && <> vers {(c.config.to || []).join(", ")}</>}
                        {c.config.to_recipients !== false && <> + utilisateurs concernés</>}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {c.events.length === 0 ? (
                        <span className="text-xs text-muted-foreground">Tous les événements</span>
                      ) : (
                        c.events.map((ev) => (
                          <Chip key={ev} tone="blue">
                            {eventLabel(ev)}
                          </Chip>
                        ))
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Dernier envoi :{" "}
                      {c.last_sent_at ? (
                        <span title={formatDate(c.last_sent_at)}>{relativeTime(c.last_sent_at)}</span>
                      ) : (
                        "jamais"
                      )}
                    </p>
                    {c.last_error && (
                      <p className="text-xs text-red-700 bg-red-50 rounded px-2 py-1 break-words">
                        Dernière erreur : {c.last_error}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => test(c)} disabled={testing === c.id} className={btnSecondary}>
                      {testing === c.id ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                      Envoyer un test
                    </button>
                    <Toggle
                      checked={c.is_active}
                      onChange={() => toggle(c)}
                      label=""
                      title={c.is_active ? "Désactiver" : "Activer"}
                    />
                    <button onClick={() => setEdit(c)} className={iconBtn} title="Modifier">
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => setDel(c)} className={iconBtnDanger} title="Supprimer">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {edit !== undefined && (
        <ChannelModal
          channel={edit}
          events={events}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            setEdit(undefined);
            load();
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title={`Supprimer le canal ${del.name}`}
          confirmLabel="Supprimer"
          danger
          loading={busy}
          onConfirm={doDelete}
          onClose={() => setDel(null)}
        >
          <p>Les notifications ne seront plus relayées par ce canal.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
