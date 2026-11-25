// Sign-ins and devices (lot 6): tables shared by "Mon compte" and the audit pages.
import { AnimatePresence, motion } from "motion/react";
import { LogOut } from "lucide-react";
import type { DeviceData, LoginEventData, LoginMethod, LoginResult } from "@/services/types";
import { Chip, type ChipTone, formatDate } from "@/components/kit";
import { TableSkeleton, Tip } from "@/components/auditUi";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const LOGIN_METHOD_LABELS: Record<LoginMethod, string> = {
  entra: "Entra ID",
  access_key: "Clé API",
};

export const LOGIN_RESULT_INFO: Record<LoginResult, { label: string; tone: ChipTone }> = {
  success: { label: "Réussie", tone: "green" },
  denied: { label: "Refusée", tone: "red" },
};

export const DEVICE_KIND_LABELS: Record<DeviceData["kind"], string> = {
  web: "Navigateur",
  access_key: "Clé API",
};

export function LoginResultChip({ result }: { result: string }) {
  const info = LOGIN_RESULT_INFO[result as LoginResult] || { label: result, tone: "default" as ChipTone };
  return <Chip tone={info.tone}>{info.label}</Chip>;
}

/** Sign-in journal rows. `showUser` adds the user column (admin views). */
export function LoginEventsTable({
  items,
  loading,
  showUser,
}: {
  items: LoginEventData[];
  loading: boolean;
  showUser: boolean;
}) {
  const cols = showUser ? 7 : 6;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Date</TableHead>
          {showUser && <TableHead>Utilisateur</TableHead>}
          <TableHead>Méthode</TableHead>
          <TableHead>Résultat</TableHead>
          <TableHead>Raison</TableHead>
          <TableHead>IP</TableHead>
          <TableHead className="pr-4">Appareil</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className={cn(loading && items.length > 0 && "opacity-60")}>
        {loading && items.length === 0 ? (
          <TableSkeleton cols={cols} rows={5} />
        ) : (
          items.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="tabular whitespace-nowrap py-2 pl-4 text-muted-foreground">
                {formatDate(e.created_at)}
              </TableCell>
              {showUser && <TableCell className="whitespace-nowrap py-2">{e.user_name || "-"}</TableCell>}
              <TableCell className="whitespace-nowrap py-2 text-muted-foreground">
                {LOGIN_METHOD_LABELS[e.method] || e.method}
              </TableCell>
              <TableCell className="py-2">
                <LoginResultChip result={e.result} />
              </TableCell>
              <TableCell className="py-2 text-muted-foreground">{e.reason || "-"}</TableCell>
              <TableCell className="whitespace-nowrap py-2 font-mono text-xs text-muted-foreground">
                {e.ip_address || "-"}
              </TableCell>
              <TableCell className="whitespace-nowrap py-2 pr-4 text-muted-foreground">{e.device || "-"}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function DeviceState({ d }: { d: DeviceData }) {
  if (d.revoked_at) {
    return (
      <Tip content={`Déconnecté le ${formatDate(d.revoked_at)}${d.revoked_by ? ` par ${d.revoked_by}` : ""}`}>
        <span>
          <Chip>Déconnecté</Chip>
        </span>
      </Tip>
    );
  }
  return <Chip tone="green">Actif</Chip>;
}

/** Devices (browsers and API keys). `showUser` adds the user column (admin views). */
export function DevicesTable({
  devices,
  loading,
  showUser,
  onRevoke,
}: {
  devices: DeviceData[];
  loading: boolean;
  showUser: boolean;
  /** Omitted: no "Déconnecter" button (permission "sessions" missing). */
  onRevoke?: (d: DeviceData) => void;
}) {
  const cols = showUser ? 8 : 7;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Appareil</TableHead>
          {showUser && <TableHead>Utilisateur</TableHead>}
          <TableHead>Type</TableHead>
          <TableHead>IP</TableHead>
          <TableHead>Première connexion</TableHead>
          <TableHead>Dernière activité</TableHead>
          <TableHead>État</TableHead>
          <TableHead className="pr-4">
            <span className="sr-only">Gestion</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className={cn(loading && devices.length > 0 && "opacity-60")}>
        {loading && devices.length === 0 ? (
          <TableSkeleton cols={cols} rows={3} />
        ) : (
          <AnimatePresence initial={false}>
            {devices.map((d) => (
              <motion.tr
                key={d.id}
                layout
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className={cn("border-b transition-colors hover:bg-muted/50", d.revoked_at && "text-muted-foreground")}
              >
                <TableCell className="py-2 pl-4">
                  <span className="flex items-center gap-2">
                    <span className={cn(d.kind === "access_key" && "font-mono text-xs")}>{d.label}</span>
                    {d.current && <Chip tone="primary">Ce navigateur</Chip>}
                  </span>
                </TableCell>
                {showUser && <TableCell className="whitespace-nowrap py-2">{d.user_name || "-"}</TableCell>}
                <TableCell className="whitespace-nowrap py-2 text-muted-foreground">
                  {DEVICE_KIND_LABELS[d.kind] || d.kind}
                </TableCell>
                <TableCell className="whitespace-nowrap py-2 font-mono text-xs text-muted-foreground">
                  {d.ip_address || "-"}
                </TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">
                  {formatDate(d.first_seen)}
                </TableCell>
                <TableCell className="tabular whitespace-nowrap py-2 text-muted-foreground">
                  {formatDate(d.last_seen)}
                </TableCell>
                <TableCell className="py-2">
                  <DeviceState d={d} />
                </TableCell>
                <TableCell className="py-1.5 pr-4 text-right">
                  {!d.revoked_at && onRevoke && (
                    <Button variant="outline" size="sm" onClick={() => onRevoke(d)}>
                      <LogOut /> Déconnecter
                    </Button>
                  )}
                </TableCell>
              </motion.tr>
            ))}
          </AnimatePresence>
        )}
      </TableBody>
    </Table>
  );
}

/** Body of the "Déconnecter" confirmation, shared by "Mon compte" and the audit page. */
export function RevokeDeviceText({ device, own }: { device: DeviceData; own: boolean }) {
  if (device.kind === "access_key") {
    return (
      <p>
        La clé <span className="font-mono text-foreground">{device.label}</span> sera désactivée immédiatement. Les
        outils qui l'utilisent perdront l'accès.
      </p>
    );
  }
  return (
    <>
      <p>
        <strong>{device.label}</strong>
        {!own && device.user_name ? ` (${device.user_name})` : ""} devra se reconnecter : ses prochains appels à
        Citadel seront refusés et l'interface se déconnectera.
      </p>
      {device.current && (
        <p className="text-live">C'est le navigateur que vous utilisez : vous serez déconnecté tout de suite.</p>
      )}
      <p className="text-xs">
        La session Entra reste valide. Pour couper l'accès d'une personne, désactivez son compte Citadel.
      </p>
    </>
  );
}
