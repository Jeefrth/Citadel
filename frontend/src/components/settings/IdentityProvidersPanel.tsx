// OIDC identity providers (SaaS phase 3).
// - scope "org": SSO of the current organisation (Paramètres > Authentification, org admins):
//   e-mail domains, automatic arrival (JIT), enforcement.
// - scope "platform": buttons of the sign-in page (platform admins), no domains / JIT / enforcement.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, KeyRound, LogIn, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { roleLabel } from "@/services/org";
import {
  errorMessage,
  type BaseRole,
  type IdentityProviderData,
  type IdentityProviderInput,
  type ProviderKind,
} from "@/services/types";
import { PROVIDER_KIND_LABELS, ProviderIcon } from "@/components/providerUi";
import { SettingsCard, TableSkeleton, Tip } from "@/components/auditUi";
import { Chip, ConfirmModal, ErrorBox, Field, Modal, SaveButton, Toggle, iconBtn, iconBtnDanger } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Scope = "org" | "platform";

const KINDS: ProviderKind[] = ["entra", "okta", "google", "oidc"];
const GOOGLE_ISSUER = "https://accounts.google.com";
const DEFAULT_SCOPES = "openid email profile";

const ENTRA_RE = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i;

function entraIssuer(tenant: string): string {
  const t = tenant.trim();
  return t ? `https://login.microsoftonline.com/${t}/v2.0` : "";
}

function oktaIssuer(domain: string): string {
  const d = domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return d ? `https://${d}` : "";
}

/** Redirect URI to register at the provider, with a copy button. */
function RedirectUri({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(uri).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{uri}</code>
      <Tip content={copied ? "Copiée" : "Copier l'URI"}>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={copy} aria-label="Copier l'URI de redirection">
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </Tip>
    </div>
  );
}

function ProviderModal({
  scope,
  provider,
  redirectUri,
  onClose,
  onSaved,
}: {
  scope: Scope;
  provider: IdentityProviderData | null;
  redirectUri: string;
  onClose: () => void;
  onSaved: (p: IdentityProviderData, created: boolean) => void;
}) {
  const editing = provider !== null;
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "entra");
  const [name, setName] = useState(provider?.name ?? PROVIDER_KIND_LABELS.entra);
  const [issuer, setIssuer] = useState(provider?.issuer ?? "");
  const [tenant, setTenant] = useState(() => provider?.issuer.match(ENTRA_RE)?.[1] ?? "");
  const [oktaDomain, setOktaDomain] = useState(() =>
    provider?.kind === "okta" ? provider.issuer.replace(/^https:\/\//i, "").split("/")[0] : "",
  );
  const [clientId, setClientId] = useState(provider?.client_id ?? "");
  const [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState(provider?.scopes ?? DEFAULT_SCOPES);
  const [domains, setDomains] = useState((provider?.domains ?? []).join(", "));
  const [jitRole, setJitRole] = useState<BaseRole | "none">(provider?.jit_role ?? "none");
  const [enforced, setEnforced] = useState(provider?.enforced ?? false);
  const [active, setActive] = useState(provider?.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeKind = (k: ProviderKind) => {
    setKind(k);
    if (k === "google") setIssuer(GOOGLE_ISSUER);
    else if (k === "entra") setIssuer(entraIssuer(tenant));
    else if (k === "okta") setIssuer(oktaIssuer(oktaDomain));
    else if (issuer === GOOGLE_ISSUER) setIssuer("");
    if (!name.trim() || Object.values(PROVIDER_KIND_LABELS).includes(name.trim())) {
      setName(k === "oidc" ? "" : PROVIDER_KIND_LABELS[k]);
    }
  };

  const domainList = domains
    .split(/[\s,;]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const needsSecret = !editing || !provider?.has_secret;
  const valid =
    name.trim().length > 0 &&
    issuer.trim().length > 0 &&
    clientId.trim().length > 0 &&
    scopes.split(/\s+/).includes("openid") &&
    (!needsSecret || secret.length > 0);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    const body: IdentityProviderInput = {
      kind,
      name: name.trim(),
      issuer: issuer.trim(),
      client_id: clientId.trim(),
      client_secret: secret ? secret : null,
      scopes: scopes.trim(),
      domains: scope === "org" ? domainList : [],
      jit_role: scope === "org" && jitRole !== "none" ? jitRole : null,
      enforced: scope === "org" && editing ? enforced : false,
      is_active: active,
    };
    const base = scope === "org" ? "/api/org/identity-providers" : "/api/platform/identity-providers";
    try {
      const saved = editing
        ? await api.put<IdentityProviderData>(`${base}/${provider.id}`, body)
        : await api.post<IdentityProviderData>(base, body);
      onSaved(saved, !editing);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? `Modifier ${provider.name}` : scope === "org" ? "Nouveau SSO" : "Nouveau fournisseur de connexion"}
      description={
        scope === "org"
          ? "Connexion des membres par le fournisseur d'identité de votre organisation (OIDC)."
          : "Bouton proposé à tous sur la page de connexion (OIDC)."
      }
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Annuler
          </Button>
          <SaveButton onClick={submit} loading={saving} disabled={!valid}>
            {editing ? "Enregistrer" : "Ajouter le fournisseur"}
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          <Select value={kind} onValueChange={(v) => changeKind(v as ProviderKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {PROVIDER_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Nom affiché">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Microsoft Contoso" />
        </Field>
      </div>

      {kind === "entra" && (
        <Field label="Tenant Entra" hint="ID du tenant (GUID) ou domaine, par exemple contoso.onmicrosoft.com.">
          <Input
            value={tenant}
            onChange={(e) => {
              setTenant(e.target.value);
              setIssuer(entraIssuer(e.target.value));
            }}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="font-mono"
          />
        </Field>
      )}
      {kind === "okta" && (
        <Field label="Domaine Okta" hint="Par exemple contoso.okta.com. L'émetteur peut aussi être https://<domaine>/oauth2/default selon votre serveur d'autorisation.">
          <Input
            value={oktaDomain}
            onChange={(e) => {
              setOktaDomain(e.target.value);
              setIssuer(oktaIssuer(e.target.value));
            }}
            placeholder="contoso.okta.com"
            className="font-mono"
          />
        </Field>
      )}
      <Field
        label="Émetteur (issuer)"
        hint={
          kind === "google"
            ? "Fixe pour Google."
            : kind === "oidc"
              ? "URL de l'émetteur OIDC, sans /.well-known/openid-configuration."
              : "Déduit du champ ci-dessus, modifiable."
        }
      >
        <Input
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          readOnly={kind === "google"}
          placeholder="https://"
          className="font-mono"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="ID client">
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" autoComplete="off" />
        </Field>
        <Field
          label="Secret client"
          hint={editing && provider.has_secret ? "Laissez vide pour garder le secret actuel." : "Jamais réaffiché après l'enregistrement."}
        >
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={editing && provider.has_secret ? "Inchangé" : ""}
            className="font-mono"
            autoComplete="new-password"
          />
        </Field>
      </div>

      <Field label="Scopes" hint="Séparés par des espaces ; « openid » est obligatoire.">
        <Input value={scopes} onChange={(e) => setScopes(e.target.value)} className="font-mono" />
      </Field>

      {scope === "org" && (
        <>
          <Field
            label="Domaines e-mail"
            hint={
              kind === "google"
                ? "Obligatoire en pratique pour Google : sans domaine, tout compte Google pourrait se présenter. Ils servent aussi à trouver votre SSO depuis la page de connexion."
                : "Séparés par des virgules. Ils servent à trouver votre SSO depuis la page de connexion et limitent les adresses acceptées."
            }
          >
            <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="contoso.com, contoso.fr" className="font-mono" />
          </Field>
          {kind === "google" && domainList.length === 0 && (
            <p className="rounded-md border border-live/30 bg-live/10 px-3 py-2 text-sm">
              Renseignez au moins un domaine pour limiter ce SSO aux comptes de votre entreprise.
            </p>
          )}
          <Field
            label="Arrivée automatique"
            hint="Rôle donné à une personne de vos domaines à sa première connexion. « Aucune » : une invitation reste nécessaire."
          >
            <Select value={jitRole} onValueChange={(v) => setJitRole(v as BaseRole | "none")}>
              <SelectTrigger className="sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Aucune (invitation requise)</SelectItem>
                <SelectItem value="viewer">Lecteur</SelectItem>
                <SelectItem value="operator">Opérateur</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {editing && (
            <div className="space-y-1">
              <Toggle checked={enforced} onChange={setEnforced} label="Imposer ce SSO" />
              <p className="text-xs text-muted-foreground">
                Les membres devront se connecter par ce fournisseur. Possible seulement si votre session actuelle a été
                ouverte avec lui.
              </p>
            </div>
          )}
        </>
      )}

      <Toggle checked={active} onChange={setActive} label="Actif" />

      <div className="space-y-1.5">
        <p className="text-sm font-medium">URI de redirection</p>
        <p className="text-xs text-muted-foreground">À déclarer dans l'application créée chez le fournisseur (plateforme Web).</p>
        <RedirectUri uri={redirectUri} />
      </div>
    </Modal>
  );
}

export default function IdentityProvidersPanel({ scope }: { scope: Scope }) {
  const base = scope === "org" ? "/api/org/identity-providers" : "/api/platform/identity-providers";
  const [providers, setProviders] = useState<IdentityProviderData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<IdentityProviderData | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<IdentityProviderData | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setProviders(await api.get<IdentityProviderData[]>(base));
    } catch (e) {
      setProviders((prev) => prev ?? []);
      setError(errorMessage(e));
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  // Same for every provider; before the first one exists, the app origin is the best guess
  const redirectUri = providers?.[0]?.redirect_uri || `${window.location.origin}/api/auth/callback`;

  const remove = async () => {
    const target = deleting;
    if (!target) return;
    setDeleteLoading(true);
    setError(null);
    try {
      await api.delete(`${base}/${target.id}`);
      setProviders((prev) => (prev || []).filter((p) => p.id !== target.id));
      toast.success("Fournisseur supprimé");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleteLoading(false);
      setDeleting(null);
    }
  };

  const cols = scope === "org" ? 6 : 4;

  return (
    <>
      <ErrorBox message={error} />
      <SettingsCard
        icon={scope === "org" ? KeyRound : LogIn}
        title={scope === "org" ? "SSO de l'organisation" : "Page de connexion"}
        description={
          scope === "org"
            ? "Fournisseurs d'identité OIDC (Entra, Okta, Google Workspace...) par lesquels vos membres se connectent. Ils sont proposés depuis la page de connexion à partir de l'adresse e-mail ou de l'identifiant de l'organisation."
            : "Fournisseurs proposés en bouton à tout le monde sur la page de connexion. Un compte n'est ouvert qu'avec une invitation ou le SSO d'une organisation."
        }
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus /> {scope === "org" ? "Ajouter un SSO" : "Ajouter un fournisseur"}
          </Button>
        }
        className="[&>div:last-child]:p-0"
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-5">Nom</TableHead>
              <TableHead>Émetteur</TableHead>
              {scope === "org" && <TableHead>Domaines</TableHead>}
              {scope === "org" && <TableHead>Arrivée automatique</TableHead>}
              <TableHead>État</TableHead>
              <TableHead className="pr-5 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers === null ? (
              <TableSkeleton cols={cols} rows={2} />
            ) : providers.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={cols} className="py-8 text-center text-muted-foreground">
                  {scope === "org"
                    ? "Aucun SSO. Ajoutez le fournisseur d'identité de votre entreprise."
                    : "Aucun fournisseur. La page de connexion ne propose que le SSO d'entreprise."}
                </TableCell>
              </TableRow>
            ) : (
              providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-5">
                    <span className="flex items-center gap-2">
                      <ProviderIcon kind={p.kind} className="size-3.5 text-muted-foreground" />
                      <span className="font-medium">{p.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={p.issuer}>
                    {p.issuer}
                  </TableCell>
                  {scope === "org" && (
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.domains.length ? p.domains.join(", ") : "-"}
                    </TableCell>
                  )}
                  {scope === "org" && (
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {p.jit_role ? roleLabel(p.jit_role) : "Sur invitation"}
                    </TableCell>
                  )}
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {p.is_active ? <Chip tone="green">Actif</Chip> : <Chip>Inactif</Chip>}
                      {p.enforced && <Chip tone="amber">Imposé</Chip>}
                      {!p.has_secret && <Chip tone="red">Sans secret</Chip>}
                    </span>
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    <div className="flex justify-end gap-1">
                      <Tip content="Modifier">
                        <button type="button" className={iconBtn} onClick={() => setEditing(p)} aria-label={`Modifier ${p.name}`}>
                          <Pencil className="size-4" />
                        </button>
                      </Tip>
                      <Tip content="Supprimer">
                        <button
                          type="button"
                          className={iconBtnDanger}
                          onClick={() => setDeleting(p)}
                          aria-label={`Supprimer ${p.name}`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </Tip>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <div className="space-y-1.5 border-t px-5 py-4">
          <p className="text-sm text-muted-foreground">URI de redirection à déclarer chez le fournisseur</p>
          <RedirectUri uri={redirectUri} />
        </div>
      </SettingsCard>

      {editing !== undefined && (
        <ProviderModal
          scope={scope}
          provider={editing}
          redirectUri={editing?.redirect_uri || redirectUri}
          onClose={() => setEditing(undefined)}
          onSaved={(p, created) => {
            setEditing(undefined);
            setProviders((prev) =>
              created ? [...(prev || []), p] : (prev || []).map((x) => (x.id === p.id ? p : x)),
            );
            toast.success(created ? "Fournisseur ajouté" : "Fournisseur enregistré");
          }}
        />
      )}

      {deleting && (
        <ConfirmModal
          title={`Supprimer ${deleting.name}`}
          confirmLabel="Supprimer"
          danger
          loading={deleteLoading}
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        >
          <p>
            {scope === "org"
              ? "Les membres qui se connectent uniquement par ce fournisseur perdront leur moyen de connexion."
              : "Le bouton disparaît de la page de connexion. Les personnes qui ne se connectent que par lui perdront leur moyen de connexion."}
          </p>
          {deleting.enforced && <p className="text-danger">Ce SSO est imposé : retirez l'obligation d'abord si vous comptez en utiliser un autre.</p>}
        </ConfirmModal>
      )}
    </>
  );
}
