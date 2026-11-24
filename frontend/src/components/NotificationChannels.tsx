// "Notifications" tab of the settings page: external channels (e-mail, Teams, webhook).
import { useCallback, useEffect, useState } from "react";
import { Bell, Loader2, Mail, MessageSquare, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  EmptyState,
  Toggle,
  formatDate,
  iconBtn,
  iconBtnDanger,
  type NoticeData,
} from "@/components/kit";
import { LEVEL_INFO, relativeTime } from "@/components/governanceUi";
import { ErrorLine, RowsSkeleton, SettingsCard, StatusDot, Tip } from "@/components/auditUi";

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
      title={channel ? `Modifier le canal ${channel.name}` : "Ajouter un canal de notification"}
      onClose={onClose}
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!valid}>
            {channel ? "Enregistrer" : "Créer"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Type" hint={channel ? "Le type ne peut plus être modifié." : undefined}>
          <Select value={type} onValueChange={(v) => setType(v as ChannelType)} disabled={!!channel}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TYPE_INFO) as ChannelType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_INFO[t].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Toggle checked={isActive} onChange={setIsActive} label="Canal actif" />

      {isEmail ? (
        <div className="border-t pt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <Field label="Serveur SMTP">
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="smtp.office365.com"
                  className="font-mono"
                />
              </Field>
            </div>
            <Field label="Port" hint="465 = TLS implicite.">
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="tabular font-mono"
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
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
               
              />
            </Field>
            <Field
              label="Mot de passe SMTP"
              hint={channel?.has_secret ? "Laisser vide pour conserver le mot de passe actuel." : undefined}
            >
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                placeholder={channel?.has_secret ? "••••••••" : ""}
               
              />
            </Field>
            <Field label="Expéditeur" hint="Par défaut : l'utilisateur SMTP.">
              <Input
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                placeholder="citadel@exemple.com"
               
              />
            </Field>
            <Field label="Destinataires fixes" hint="Adresses séparées par des virgules.">
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="soc@exemple.com, it@exemple.com"
               
              />
              {badMail.length > 0 && (
                <p className="text-xs mt-1 text-danger">Adresse invalide : {badMail.join(", ")}</p>
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
            label={type === "teams" ? "URL du workflow Teams" : "URL du webhook"}
            hint={
              <>
                {type === "teams"
                  ? "Teams > canal > Workflows > « Publier dans un canal lorsqu'une requête webhook est reçue »."
                  : "Reçoit un POST JSON par événement."}
                {channel?.has_secret && " Laisser vide pour conserver l'URL actuelle (elle n'est jamais réaffichée)."}
              </>
            }
          >
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="off"
              placeholder={channel?.has_secret ? "URL enregistrée" : "https://..."}
              className="font-mono"
            />
            {!urlOk && <p className="text-xs mt-1 text-danger">L'URL doit commencer par https://</p>}
          </Field>
        </div>
      )}

      <div className="border-t pt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <Field label="Événements">
            <label className="mb-2 flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={allEvents} onCheckedChange={(v) => setAllEvents(v === true)} />
              Tous les événements
            </label>
            <div className={`space-y-1.5 pl-6 ${allEvents ? "opacity-40 pointer-events-none" : ""}`}>
              {events.map((ev) => (
                <label key={ev.event} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={allEvents || selEvents.includes(ev.event)} onCheckedChange={() => toggleEvent(ev.event)} />
                  {ev.label}
                  <span className="text-xs text-muted-foreground font-mono">{ev.event}</span>
                </label>
              ))}
            </div>
            {!allEvents && selEvents.length === 0 && (
              <p className="text-xs mt-1 text-danger">Choisissez au moins un événement.</p>
            )}
          </Field>
        </div>
        <Field label="Niveau minimal">
          <Select value={minLevel} onValueChange={(v) => setMinLevel(v as NotificationLevel)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {LEVEL_INFO[l].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
    <SettingsCard
      icon={Bell}
      title="Canaux de notification"
      description="Les notifications apparaissent toujours dans Citadel (cloche). Ces canaux les relaient aussi par e-mail, dans Teams ou vers un webhook, selon les événements et le niveau choisis."
      actions={
        <Button size="sm" onClick={() => setEdit(null)}>
          <Plus /> Ajouter un canal
        </Button>
      }
    >
      <div className="space-y-3">
        <Notice notice={notice} onClose={() => setNotice(null)} />
        <ErrorBox message={error} />

        {loading ? (
          <RowsSkeleton rows={3} />
        ) : channels.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="Aucun canal externe"
            action={
              <Button size="sm" variant="outline" onClick={() => setEdit(null)}>
                <Plus /> Ajouter un canal
              </Button>
            }
          >
            Ajoutez un canal e-mail, Teams ou webhook pour relayer les notifications hors de Citadel.
          </EmptyState>
        ) : (
          <div className="divide-y rounded-md border">
            <AnimatePresence initial={false}>
              {channels.map((c) => {
                const info = TYPE_INFO[c.type] || TYPE_INFO.webhook;
                const Icon = info.icon;
                return (
                  <motion.div
                    key={c.id}
                    layout
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
                      <div className="pt-1.5">
                        <StatusDot
                          tone={!c.is_active ? "muted" : c.last_error ? "danger" : "success"}
                          label={!c.is_active ? "Inactif" : c.last_error ? "En erreur" : "Actif"}
                        />
                      </div>
                      <div className={`min-w-0 flex-1 space-y-1 ${c.is_active ? "" : "opacity-60"}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{c.name}</span>
                          <Chip>
                            <Icon className="size-3" />
                            {info.label}
                          </Chip>
                          <Chip tone={LEVEL_INFO[c.min_level]?.tone || "default"}>
                            dès {LEVEL_INFO[c.min_level]?.label.toLowerCase() || c.min_level}
                          </Chip>
                          {!c.is_active && <Chip>Inactif</Chip>}
                        </div>
                        {c.type === "email" && (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-mono">
                              {c.config.host}:{c.config.port || 587}
                            </span>
                            {(c.config.to || []).length > 0 && (
                              <>
                                {" "}vers <span className="font-mono">{(c.config.to || []).join(", ")}</span>
                              </>
                            )}
                            {c.config.to_recipients !== false && <> + utilisateurs concernés</>}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {c.events.length === 0 ? "Tous les événements" : c.events.map(eventLabel).join(", ")}
                          {" · "}dernier envoi{" "}
                          {c.last_sent_at ? (
                            <Tip content={formatDate(c.last_sent_at)}>
                              <span className="cursor-default">{relativeTime(c.last_sent_at)}</span>
                            </Tip>
                          ) : (
                            "jamais"
                          )}
                        </p>
                        {c.last_error && <ErrorLine>Dernière erreur : {c.last_error}</ErrorLine>}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" onClick={() => test(c)} disabled={testing === c.id}>
                          {testing === c.id ? <Loader2 className="animate-spin" /> : <Send />}
                          Envoyer un test
                        </Button>
                        <Tip content={c.is_active ? "Désactiver" : "Activer"}>
                          <span className="flex items-center px-1.5">
                            <Switch
                              checked={c.is_active}
                              onCheckedChange={() => toggle(c)}
                              aria-label={c.is_active ? "Désactiver" : "Activer"}
                            />
                          </span>
                        </Tip>
                        <Tip content="Modifier">
                          <button onClick={() => setEdit(c)} className={iconBtn} aria-label="Modifier">
                            <Pencil className="size-4" />
                          </button>
                        </Tip>
                        <Tip content="Supprimer">
                          <button onClick={() => setDel(c)} className={iconBtnDanger} aria-label="Supprimer">
                            <Trash2 className="size-4" />
                          </button>
                        </Tip>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

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
    </SettingsCard>
  );
}
