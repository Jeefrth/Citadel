// Platform > Organisations (platform admin only): list, create (own encryption key
// and SSH CA), rename, activate / deactivate, delete (inactive only, slug typed
// again). The default organisation stays active and cannot be deleted.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Building2, Check, KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { SLUG_PATTERN, suggestSlug, switchOrg } from "@/services/org";
import { errorMessage, type PlatformOrg } from "@/services/types";
import {
  Chip,
  ConfirmModal,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  Notice,
  PageHeader,
  SaveButton,
  formatDate,
  type NoticeData,
} from "@/components/kit";
import { TableSkeleton, Tip } from "@/components/auditUi";
import IdentityProvidersPanel from "@/components/settings/IdentityProvidersPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function CreateOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: (org: PlatformOrg) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : suggestSlug(name);
  const slugOk = SLUG_PATTERN.test(effectiveSlug);
  const emailOk = !adminEmail.trim() || EMAIL_PATTERN.test(adminEmail.trim());
  const valid = name.trim().length > 0 && slugOk && emailOk;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = { name: name.trim(), slug: effectiveSlug };
      if (adminEmail.trim()) body.admin_email = adminEmail.trim();
      const org = await api.post<PlatformOrg>("/api/platform/orgs", body);
      onCreated(org);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Nouvelle organisation"
      description="Elle reçoit sa propre clé de chiffrement et sa propre autorité de certification SSH."
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <SaveButton onClick={submit} loading={saving} disabled={!valid}>
            Créer l'organisation
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Client Alpha" autoFocus />
      </Field>
      <Field
        label="Identifiant"
        hint={
          effectiveSlug && !slugOk
            ? "3 à 63 caractères : lettres minuscules sans accent, chiffres et tirets."
            : "Utilisé dans l'en-tête X-Citadel-Org et le proxy SSH. Proposé à partir du nom, modifiable."
        }
      >
        <Input
          value={effectiveSlug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
          placeholder="client-alpha"
          className="font-mono"
          aria-invalid={!!effectiveSlug && !slugOk}
        />
      </Field>
      <Field
        label="E-mail du premier administrateur (facultatif)"
        hint={
          emailOk
            ? "Cette personne est invitée comme administrateur de l'organisation."
            : "Adresse e-mail invalide."
        }
      >
        <Input
          type="email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          placeholder="prenom.nom@client.com"
          className="font-mono"
          aria-invalid={!emailOk}
        />
      </Field>
    </Modal>
  );
}

function RenameOrgModal({
  org,
  onClose,
  onSaved,
}: {
  org: PlatformOrg;
  onClose: () => void;
  onSaved: (org: PlatformOrg) => void;
}) {
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && name.trim() !== org.name;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<PlatformOrg>(`/api/platform/orgs/${org.id}`, { name: name.trim() });
      onSaved(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Renommer l'organisation"
      description="L'identifiant ne change pas."
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <SaveButton onClick={submit} loading={saving} disabled={!valid}>
            Renommer
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
      </Field>
    </Modal>
  );
}

function DeleteOrgModal({
  org,
  onClose,
  onDeleted,
}: {
  org: PlatformOrg;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = typed.trim().toLowerCase() === org.slug;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/platform/orgs/${org.id}/delete`, { confirm_slug: typed.trim() });
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Supprimer l'organisation"
      description="Action définitive."
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!valid || saving}>
            <Trash2 /> Supprimer définitivement
          </Button>
        </>
      }
    >
      <ErrorBox message={error} />
      <p className="text-sm">
        Tout ce qui appartient à <strong>{org.name}</strong> est effacé : serveurs, comptes et secrets, règles,
        enregistrements de sessions et sauvegardes, journal d'audit, membres et invitations. Les comptes des personnes
        sont conservés, seule leur appartenance disparaît.
      </p>
      <Field label={`Tapez « ${org.slug} » pour confirmer`}>
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
          autoComplete="off"
        />
      </Field>
    </Modal>
  );
}

/** "Propre" (own key / CA) or "Commune" (shared with the platform, default org). */
function OwnChip({ own, icon: Icon, label }: { own: boolean; icon: typeof KeyRound; label: string }) {
  return (
    <Chip tone={own ? "green" : "default"} title={own ? `${label} propre à l'organisation` : `${label} commune (historique)`}>
      <Icon className="size-3" />
      {own ? "Propre" : "Commune"}
    </Chip>
  );
}

export default function PlatformOrgs() {
  const { user, isPlatformAdmin, loading: userLoading } = useCurrentUser();
  const [orgs, setOrgs] = useState<PlatformOrg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<PlatformOrg | null>(null);
  const [deactivating, setDeactivating] = useState<PlatformOrg | null>(null);
  const [deleting, setDeleting] = useState<PlatformOrg | null>(null);
  const [toggleLoading, setToggleLoading] = useState<string | null>(null);
  const [created, setCreated] = useState<PlatformOrg | null>(null);

  const load = useCallback(async () => {
    try {
      setOrgs(await api.get<PlatformOrg[]>("/api/platform/orgs"));
    } catch (e) {
      setOrgs((prev) => prev ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (isPlatformAdmin) load();
  }, [isPlatformAdmin, load]);

  const replace = (org: PlatformOrg) =>
    setOrgs((prev) => (prev || []).map((o) => (o.id === org.id ? { ...o, ...org } : o)));

  const setActive = async (org: PlatformOrg, isActive: boolean) => {
    setToggleLoading(org.id);
    setError(null);
    try {
      const updated = await api.patch<PlatformOrg>(`/api/platform/orgs/${org.id}`, { is_active: isActive });
      replace(updated);
      toast.success(isActive ? `${org.name} activée` : `${org.name} désactivée`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setToggleLoading(null);
      setDeactivating(null);
    }
  };

  const currentOrgId = user?.org?.id;
  const createdNotice: NoticeData | null = created
    ? {
        ok: true,
        text: (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>
              Organisation <strong>{created.name}</strong> créée, avec sa clé de chiffrement et son autorité de
              certification SSH.
            </span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => switchOrg(created.slug)}>
              <ArrowRightLeft /> Basculer vers {created.name}
            </Button>
          </div>
        ),
      }
    : null;

  if (!userLoading && !isPlatformAdmin) {
    return (
      <div>
        <PageHeader title="Organisations" />
        <EmptyState icon={Building2} title="Réservé aux administrateurs de la plateforme">
          Demandez à un administrateur de la plateforme de créer ou de modifier une organisation.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Organisations"
        description="Chaque organisation a ses serveurs, ses membres, sa clé de chiffrement et son autorité de certification SSH. En bas : les fournisseurs proposés sur la page de connexion."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Nouvelle organisation
          </Button>
        }
      />

      <Notice notice={createdNotice} onClose={() => setCreated(null)} />
      <ErrorBox message={error} />

      <Card className="overflow-hidden rounded-lg shadow-none">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Nom</TableHead>
              <TableHead>Identifiant</TableHead>
              <TableHead className="text-right">Membres</TableHead>
              <TableHead>Clé de chiffrement</TableHead>
              <TableHead>CA SSH</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Créée le</TableHead>
              <TableHead className="pr-5 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs === null ? (
              <TableSkeleton cols={8} />
            ) : orgs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  Aucune organisation. Créez la première avec « Nouvelle organisation ».
                </TableCell>
              </TableRow>
            ) : (
              orgs.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="pl-5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{o.name}</span>
                      {o.is_default && <Chip>Par défaut</Chip>}
                      {o.id === currentOrgId && (
                        <Chip tone="blue">
                          <Check className="size-3" /> Actuelle
                        </Chip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{o.slug}</TableCell>
                  <TableCell className="tabular text-right">{o.members}</TableCell>
                  <TableCell>
                    <OwnChip own={o.has_own_key} icon={KeyRound} label="Clé de chiffrement" />
                  </TableCell>
                  <TableCell>
                    <OwnChip own={o.has_own_ca} icon={ShieldCheck} label="Autorité de certification SSH" />
                  </TableCell>
                  <TableCell>
                    {o.is_default ? (
                      <Tip content="L'organisation par défaut ne peut pas être désactivée">
                        <span className="inline-flex">
                          <Switch checked disabled aria-label="Organisation par défaut, toujours active" />
                        </span>
                      </Tip>
                    ) : (
                      <Switch
                        checked={o.is_active}
                        disabled={toggleLoading === o.id}
                        onCheckedChange={(v) => (v ? setActive(o, true) : setDeactivating(o))}
                        aria-label={o.is_active ? `Désactiver ${o.name}` : `Activer ${o.name}`}
                      />
                    )}
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {formatDate(o.created_at, false)}
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    <div className="flex justify-end gap-1">
                      {o.id !== currentOrgId && o.is_active && (
                        <Tip content={`Basculer vers ${o.name}`}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground"
                            onClick={() => switchOrg(o.slug)}
                            aria-label={`Basculer vers ${o.name}`}
                          >
                            <ArrowRightLeft />
                          </Button>
                        </Tip>
                      )}
                      <Tip content="Renommer">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground"
                          onClick={() => setRenaming(o)}
                          aria-label={`Renommer ${o.name}`}
                        >
                          <Pencil />
                        </Button>
                      </Tip>
                      {!o.is_default && (
                        <Tip content={o.is_active ? "Désactivez-la d'abord pour pouvoir la supprimer" : "Supprimer"}>
                          <span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleting(o)}
                              disabled={o.is_active}
                              aria-label={`Supprimer ${o.name}`}
                            >
                              <Trash2 />
                            </Button>
                          </span>
                        </Tip>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Buttons of the sign-in page (platform providers) */}
      <div className="space-y-4 pt-4">
        <IdentityProvidersPanel scope="platform" />
      </div>

      {creating && (
        <CreateOrgModal
          onClose={() => setCreating(false)}
          onCreated={(org) => {
            setCreating(false);
            setCreated(org);
            toast.success("Organisation créée");
            load();
          }}
        />
      )}

      {renaming && (
        <RenameOrgModal
          org={renaming}
          onClose={() => setRenaming(null)}
          onSaved={(org) => {
            replace(org);
            setRenaming(null);
            toast.success("Organisation renommée");
          }}
        />
      )}

      {deleting && (
        <DeleteOrgModal
          org={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            toast.success("Organisation supprimée");
            load();
          }}
        />
      )}

      {deactivating && (
        <ConfirmModal
          title="Désactiver l'organisation"
          confirmLabel="Désactiver"
          danger
          loading={toggleLoading === deactivating.id}
          onConfirm={() => setActive(deactivating, false)}
          onClose={() => setDeactivating(null)}
        >
          <p>
            Les membres de <strong>{deactivating.name}</strong> ne pourront plus y travailler tant qu'elle reste désactivée.
            Ses données sont conservées et vous pourrez la réactiver.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}
