// Address allow-list of the organisation (SaaS phase 2): checked on every entry point
// (web, API, access keys, terminals, RDP, SSH proxy, application keys).
import { useState } from "react";
import { AlertTriangle, Globe, Loader2, MapPin, Plus, Save, X } from "lucide-react";
import { Tip } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Loose format check (the backend validates and normalises): IPv4 / IPv6, optional /prefix. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d|[12]\d|3[0-2]))?$/;
const IPV6 = /^[0-9a-f:]+(\/(\d|[1-9]\d|1[01]\d|12[0-8]))?$/i;

export function looksLikeAddress(value: string): boolean {
  const v = value.trim();
  const m = v.match(IPV4);
  if (m) return [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255);
  return v.includes(":") && IPV6.test(v);
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  return ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
}

/**
 * Is `ip` covered by `entry` (exact address or IPv4 range)? IPv6 ranges are not
 * evaluated here: null = unknown (the backend has the final word).
 */
function covers(entry: string, ip: string): boolean | null {
  if (entry === ip) return true;
  const [net, prefix] = entry.split("/");
  const a = ipv4ToInt(ip);
  const n = ipv4ToInt(net);
  if (a === null || n === null) return ip.includes(":") || net.includes(":") ? null : false;
  const bits = prefix === undefined ? 32 : Number(prefix);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((n & mask) >>> 0);
}

export default function IpAllowlistEditor({
  list,
  onChange,
  dirty,
  saving,
  onSave,
  clientIp,
}: {
  list: string[];
  onChange: (list: string[]) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  clientIp: string | null | undefined;
}) {
  const [entry, setEntry] = useState("");
  const value = entry.trim();
  const invalid = value.length > 0 && !looksLikeAddress(value);

  const add = (v: string) => {
    const items = v
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const next = [...list];
    for (const i of items) if (!next.includes(i)) next.push(i);
    onChange(next);
    setEntry("");
  };

  const mine = clientIp ? list.some((e) => covers(e, clientIp) === true) : false;
  const unknown = clientIp ? list.some((e) => covers(e, clientIp) === null) : false;

  return (
    <div className="space-y-3">
      {list.length === 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-live/30 bg-live/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-live" />
          <span>Liste vide : toutes les adresses peuvent accéder à l'organisation.</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          {list.map((ip) => (
            <div key={ip} className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
              <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              <code className="flex-1 break-all font-mono text-xs">{ip}</code>
              {clientIp && covers(ip, clientIp) === true && (
                <span className="text-xs text-muted-foreground">inclut votre adresse</span>
              )}
              <Tip content="Retirer">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                  onClick={() => onChange(list.filter((i) => i !== ip))}
                  aria-label={`Retirer ${ip}`}
                >
                  <X />
                </Button>
              </Tip>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value && add(value)}
            placeholder="203.0.113.10, 192.168.1.0/24 ou 2001:db8::/32"
            className="font-mono"
            aria-invalid={invalid}
            aria-label="Adresse ou plage à autoriser"
          />
          <Button variant="outline" onClick={() => add(value)} disabled={!value}>
            <Plus /> Ajouter
          </Button>
        </div>
        <p className={invalid ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
          {invalid
            ? "Format inattendu : une adresse IPv4 ou IPv6, éventuellement suivie d'une plage (/24, /64...)."
            : "Une adresse ou une plage CIDR par entrée ; plusieurs entrées séparées par des espaces ou des virgules."}
        </p>
      </div>

      {clientIp && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="size-3.5" />
            Votre adresse actuelle : <code className="font-mono text-xs text-foreground">{clientIp}</code>
          </span>
          {!list.includes(clientIp) && (
            <Button size="sm" variant="outline" className="h-7" onClick={() => add(clientIp)}>
              <Plus /> Ajouter mon adresse
            </Button>
          )}
        </div>
      )}
      {list.length > 0 && clientIp && !mine && !unknown && (
        <p className="text-sm text-danger">
          Votre adresse actuelle n'est pas dans la liste : l'enregistrement sera refusé pour ne pas vous bloquer.
        </p>
      )}

      {dirty && (
        <Button onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Enregistrer la liste
        </Button>
      )}
    </div>
  );
}
