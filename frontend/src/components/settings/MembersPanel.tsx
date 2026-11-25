// Settings > Membres: people of the current organisation (role, custom role, active),
// invitations by e-mail, removal from the organisation (the account itself stays).
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MailPlus, UserMinus, Users, X } from "lucide-react";
import { api } from "@/services/api";
import { useCurrentUser } from "@/services/useCurrentUser";
import { roleLabel } from "@/services/org";
import {
  errorMessage,
  type BaseRole,
  type CustomRoleData,
  type OrgInvitation,
  type OrgInviteResult,
  type UserData,
} from "@/services/types";
import { ConfirmModal, ErrorBox, Notice, formatDate, type NoticeData } from "@/components/kit";
import { SettingsCard, TableSkeleton, Tip } from "@/components/auditUi";
import { BaseRoleCapNote } from "@/components/settings/RolesPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RoleSelect({
  value,
  onChange,
  className = "h-8 w-32",
}: {
  value: BaseRole;
  onChange: (v: BaseRole) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as BaseRole)}>
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">Admin</SelectItem>
        <SelectItem value="operator">Opérateur</SelectItem>
        <SelectItem value="viewer">Lecteur</SelectItem>
      </SelectContent>
    </Select>
  );
}

export default function MembersPanel({
  customRoles,
  onChanged,
}: {
  customRoles: CustomRoleData[];
  /** Called after a change that may affect custom role counts. */
  onChanged: () => void;
}) {
  const { user: me } = useCurrentUser();
  const orgName = me?.org?.name;

  const [members, setMembers] = useState<UserData[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<UserData | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<BaseRole>("viewer");
  const [inviting, setInviting] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<NoticeData | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, inv] = await Promise.all([
        api.get<UserData[]>("/api/org/members"),
        api.get<OrgInvitation[]>("/api/org/invitations"),
      ]);
      setMembers(m);
      setInvitations(inv);
    } catch (e) {
      setMembers((prev) => prev ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** PATCH a member; the response (UserRead) carries the resulting role, custom role and permissions. */
  const patchMember = async (userId: string, body: Record<string, unknown>, done?: string) => {
    setError(null);
    try {
      const updated = await api.patch<UserData>(`/api/org/members/${userId}`, body);
      setMembers((prev) => (prev || []).map((u) => (u.id === userId ? { ...u, ...updated } : u)));
      if (done) toast.success(done);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const removeMember = async () => {
    const target = removing;
    if (!target) return;
    setRemoveLoading(true);
    setError(null);
    try {
      await api.delete(`/api/org/members/${target.id}`);
      setMembers((prev) => (prev || []).filter((u) => u.id !== target.id));
      toast.success(`${target.display_name} retiré de l'organisation`);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRemoveLoading(false);
      setRemoving(null);
    }
  };

  const invite = async () => {
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) return;
    setInviting(true);
    setError(null);
    setInviteNotice(null);
    try {
      const res = await api.post<OrgInviteResult>("/api/org/invitations", { email: value, role: inviteRole });
      setInviteNotice({
        ok: true,
        text: (
          <>
            Invitation envoyée à <strong>{res.email}</strong> ({roleLabel(res.role).toLowerCase()}). La personne doit
            l'accepter dans Citadel (Mon compte) après s'être connectée avec Microsoft.
          </>
        ),
      });
      setEmail("");
      await load();
    } catch (e) {
      setInviteNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setInviting(false);
    }
  };

  const cancelInvitation = async (inv: OrgInvitation) => {
    setError(null);
    try {
      await api.delete(`/api/org/invitations/${inv.id}`);
      setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
      toast.success(`Invitation de ${inv.email} annulée`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const emailValid = EMAIL_PATTERN.test(email.trim());

  return (
    <>
      <BaseRoleCapNote />
      <ErrorBox message={error} />

      <SettingsCard
        icon={MailPlus}
        title="Inviter"
        description="La personne reçoit une invitation qu'elle doit accepter dans Citadel (Mon compte) après s'être connectée avec Microsoft. Elle ne devient membre qu'après avoir accepté."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && emailValid && !inviting && invite()}
              placeholder="prenom.nom@entreprise.com"
              aria-label="E-mail de la personne à inviter"
              className="min-w-56 flex-1 font-mono"
            />
            <RoleSelect value={inviteRole} onChange={setInviteRole} className="h-9 w-36" />
            <Button onClick={invite} disabled={!emailValid || inviting}>
              {inviting ? <Loader2 className="animate-spin" /> : <MailPlus />}
              Inviter
            </Button>
          </div>
          <Notice notice={inviteNotice} onClose={() => setInviteNotice(null)} />
        </div>
      </SettingsCard>

      <SettingsCard
        icon={Users}
        title={
          <>
            Membres{orgName ? ` de ${orgName}` : ""}{" "}
            <span className="tabular font-normal text-muted-foreground">({members?.length ?? 0})</span>
          </>
        }
        className="[&>div:last-child]:p-0"
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Nom</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Rôle</TableHead>
              <TableHead>Rôle personnalisé</TableHead>
              <TableHead>Actif</TableHead>
              <TableHead>Dernière connexion</TableHead>
              <TableHead className="pr-5 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          {members === null ? (
            <TableBody>
              <TableSkeleton cols={7} />
            </TableBody>
          ) : (
            <TableBody>
              {members.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Aucun membre. Invitez une première personne avec son e-mail.
                  </TableCell>
                </TableRow>
              )}
              {members.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="pl-5 font-medium">
                    {u.display_name}
                    {u.id === me?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(vous)</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{u.email || "-"}</TableCell>
                  <TableCell>
                    <RoleSelect value={u.role} onChange={(v) => patchMember(u.id, { role: v }, "Rôle modifié")} />
                  </TableCell>
                  <TableCell>
                    {u.role === "admin" ? (
                      <span className="text-xs text-muted-foreground">Toutes les permissions</span>
                    ) : (
                      <Select
                        value={u.custom_role_id || "none"}
                        onValueChange={(v) =>
                          patchMember(u.id, { custom_role_id: v === "none" ? null : v }, "Rôle personnalisé modifié")
                        }
                      >
                        <SelectTrigger className="h-8 w-44" title={(u.permissions || []).join(", ") || undefined}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Aucun</SelectItem>
                          {customRoles.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.name}
                            </SelectItem>
                          ))}
                          {u.custom_role_id && !customRoles.some((r) => r.id === u.custom_role_id) && (
                            <SelectItem value={u.custom_role_id}>{u.custom_role_name || "Rôle inconnu"}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={u.is_active}
                      onCheckedChange={(v) => patchMember(u.id, { is_active: v })}
                      aria-label={u.is_active ? "Désactiver le membre" : "Activer le membre"}
                    />
                  </TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {u.last_login ? formatDate(u.last_login) : "Jamais"}
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    <Tip content="Retirer de l'organisation">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                        onClick={() => setRemoving(u)}
                        aria-label="Retirer de l'organisation"
                      >
                        <UserMinus />
                      </Button>
                    </Tip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          )}
        </Table>
      </SettingsCard>

      {invitations.length > 0 && (
        <SettingsCard
          icon={MailPlus}
          title={
            <>
              Invitations en attente{" "}
              <span className="tabular font-normal text-muted-foreground">({invitations.length})</span>
            </>
          }
          description="Ces personnes n'ont pas encore accepté. Elles rejoindront l'organisation dès qu'elles accepteront depuis Mon compte."
          className="[&>div:last-child]:p-0"
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">E-mail</TableHead>
                <TableHead>Rôle</TableHead>
                <TableHead>Invitée le</TableHead>
                <TableHead className="pr-5 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="pl-5 font-mono text-xs">{inv.email}</TableCell>
                  <TableCell>{roleLabel(inv.role)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">{formatDate(inv.created_at)}</TableCell>
                  <TableCell className="pr-5 text-right">
                    <Tip content="Annuler l'invitation">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                        onClick={() => cancelInvitation(inv)}
                        aria-label="Annuler l'invitation"
                      >
                        <X />
                      </Button>
                    </Tip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsCard>
      )}

      {removing && (
        <ConfirmModal
          title="Retirer de l'organisation"
          confirmLabel="Retirer"
          danger
          loading={removeLoading}
          onConfirm={removeMember}
          onClose={() => setRemoving(null)}
        >
          <p>
            <strong>{removing.display_name}</strong> perdra l'accès à {orgName ? <strong>{orgName}</strong> : "cette organisation"}.
            Son compte Citadel reste actif dans ses autres organisations. Le retrait est journalisé dans l'audit.
          </p>
          {removing.id === me?.id && <p className="text-danger">Vous allez vous retirer vous-même de cette organisation.</p>}
        </ConfirmModal>
      )}
    </>
  );
}
