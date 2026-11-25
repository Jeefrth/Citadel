// Paramètres > Rôles (lot 7): custom roles add administration permissions to an
// operator or a viewer. The base role still caps actions on servers.
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Info, Pencil, Plus, Trash2, UserCog } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type CustomRoleData } from "@/services/types";
import { Chip, ConfirmModal, EmptyState, ErrorBox, Field, Modal, SaveButton } from "@/components/kit";
import { SettingsCard, TableSkeleton } from "@/components/auditUi";
import { RowAction } from "@/components/AccountsSection";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Short names for the capability codes (the backend gives the long description). */
export const PERM_SHORT: Record<string, string> = {
  audit: "Audit",
  sessions: "Contrôle des sessions",
  servers: "Inventaire",
  secrets: "Secrets",
  policies: "Droits",
  playbooks: "Playbooks",
};

export function useCapabilities(): Record<string, string> {
  const [caps, setCaps] = useState<Record<string, string>>({});
  useEffect(() => {
    api.get<Record<string, string>>("/api/capabilities").then(setCaps).catch(() => {});
  }, []);
  return caps;
}

/** Reminder shown wherever roles are assigned. */
export function BaseRoleCapNote() {
  return (
    <div className="flex gap-2 rounded-md border border-info/25 bg-info/10 px-3 py-2.5 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-info" />
      <p className="text-foreground">
        Un rôle personnalisé ajoute des permissions d'administration à un opérateur ou un lecteur. Le rôle de base
        plafonne toujours les actions sur les serveurs (un lecteur n'exécute jamais rien) et l'accès aux serveurs reste
        donné par les règles d'accès. Utilisateurs, rôles, paramètres, coffre, sauvegardes et applications restent
        réservés aux administrateurs.
      </p>
    </div>
  );
}

function RoleModal({
  role,
  caps,
  onClose,
  onSaved,
}: {
  role: CustomRoleData | null;
  caps: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (p: string) => setPerms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]));

  const save = async () => {
    setLoading(true);
    setError(null);
    const body = { name: name.trim(), description: description.trim() || null, permissions: perms };
    try {
      if (role) await api.put(`/api/custom-roles/${role.id}`, body);
      else await api.post("/api/custom-roles", body);
      toast.success(role ? "Rôle enregistré" : "Rôle créé");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title={role ? `Modifier le rôle ${role.name}` : "Nouveau rôle"}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={save} loading={loading} disabled={!name.trim()}>
            {role ? "Enregistrer le rôle" : "Créer le rôle"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Auditeur" autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Permissions</p>
        {Object.keys(caps).length === 0 && <p className="text-sm text-muted-foreground">Chargement des permissions...</p>}
        {Object.entries(caps).map(([code, label]) => (
          <label key={code} className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
            <Checkbox checked={perms.includes(code)} onCheckedChange={() => toggle(code)} className="mt-0.5" />
            <span>
              <span className="font-medium">{PERM_SHORT[code] || code}</span>{" "}
              <span className="font-mono text-xs text-muted-foreground">{code}</span>
              <span className="block text-xs text-muted-foreground">{label}</span>
            </span>
          </label>
        ))}
      </div>
      {(perms.includes("policies") || perms.includes("servers")) && (
        <p className="text-xs text-live">
          « Droits » permet de s'accorder des accès et « Inventaire » de créer des comptes : à réserver à des personnes de
          confiance.
        </p>
      )}
    </Modal>
  );
}

export default function RolesPanel({ onChanged }: { onChanged?: () => void }) {
  const caps = useCapabilities();
  const [roles, setRoles] = useState<CustomRoleData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomRoleData | null | undefined>(undefined);
  const [removing, setRemoving] = useState<CustomRoleData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<CustomRoleData[]>("/api/custom-roles")
      .then((r) => {
        setRoles(r);
        setError(null);
      })
      .catch((e) => {
        setRoles((r) => r ?? []);
        setError(errorMessage(e));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/api/custom-roles/${removing.id}`);
      toast.success(`Rôle ${removing.name} supprimé`);
      setRoles((r) => (r || []).filter((x) => x.id !== removing.id));
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  return (
    <>
      <BaseRoleCapNote />
      <SettingsCard
        icon={UserCog}
        title="Rôles personnalisés"
        description="Attribuez-les dans l'onglet Utilisateurs."
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus /> Nouveau rôle
          </Button>
        }
        className="[&>div:last-child]:p-0"
      >
        {error && (
          <div className="px-5 pt-4">
            <ErrorBox message={error} />
          </div>
        )}
        {roles && roles.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={UserCog}
              title="Aucun rôle personnalisé"
              action={
                <Button variant="outline" onClick={() => setEditing(null)}>
                  <Plus /> Créer un rôle
                </Button>
              }
            >
              Créez un rôle, par exemple un auditeur qui consulte tous les enregistrements sans être administrateur.
            </EmptyState>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Nom</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead className="text-right">Membres</TableHead>
                <TableHead className="pr-5">
                  <span className="sr-only">Gestion</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!roles ? (
                <TableSkeleton cols={4} rows={2} />
              ) : (
                <AnimatePresence initial={false}>
                  {roles.map((r) => (
                    <motion.tr key={r.id} layout exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="border-b hover:bg-muted/50">
                      <TableCell className="py-2 pl-5">
                        <p className="font-medium">{r.name}</p>
                        {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {r.permissions.length === 0 && <span className="text-xs text-muted-foreground">aucune</span>}
                          {r.permissions.map((p) => (
                            <Chip key={p} title={caps[p]}>
                              {PERM_SHORT[p] || p}
                            </Chip>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="tabular py-2 text-right">{r.members}</TableCell>
                      <TableCell className="py-1.5 pr-5">
                        <div className="flex items-center justify-end gap-1">
                          <RowAction label="Modifier" onClick={() => setEditing(r)}>
                            <Pencil />
                          </RowAction>
                          <RowAction label="Supprimer" danger onClick={() => setRemoving(r)}>
                            <Trash2 />
                          </RowAction>
                        </div>
                      </TableCell>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        )}
      </SettingsCard>

      {editing !== undefined && (
        <RoleModal
          role={editing}
          caps={caps}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
            onChanged?.();
          }}
        />
      )}
      {removing && (
        <ConfirmModal
          title={`Supprimer le rôle ${removing.name}`}
          confirmLabel="Supprimer le rôle"
          danger
          loading={busy}
          onConfirm={remove}
          onClose={() => setRemoving(null)}
        >
          <p>
            {removing.members > 0
              ? `Ses ${removing.members} membre(s) gardent seulement leur rôle de base.`
              : "Aucun utilisateur n'a ce rôle."}
          </p>
        </ConfirmModal>
      )}
    </>
  );
}
