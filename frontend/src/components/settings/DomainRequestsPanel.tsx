// Platform > Organisations: e-mail domains asked by organisation SSOs, waiting for a
// platform admin. Approved domains are used for discovery from an address and to trust
// the provider's e-mails for invitations, so ownership must be checked out of band.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Globe, X } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type DomainRequest, type IdentityProviderData } from "@/services/types";
import { ProviderIcon } from "@/components/providerUi";
import { SettingsCard, Tip } from "@/components/auditUi";
import { Chip, ConfirmModal, ErrorBox } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Pending = { request: DomainRequest; domain: string; approve: boolean };

export default function DomainRequestsPanel() {
  const [requests, setRequests] = useState<DomainRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequests(await api.get<DomainRequest[]>("/api/platform/domain-requests"));
    } catch (e) {
      setRequests((prev) => prev ?? []);
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const apply = async () => {
    if (!pending) return;
    const { request, domain, approve } = pending;
    const current = request.verified_domains ?? [];
    const domains = approve ? [...new Set([...current, domain])] : current.filter((d) => d !== domain);
    setSaving(true);
    setError(null);
    try {
      const updated = await api.put<IdentityProviderData>(
        `/api/platform/identity-providers/${request.id}/verified-domains`,
        { domains },
      );
      setRequests((prev) =>
        (prev || [])
          .map((r) => (r.id === request.id ? { ...r, ...updated, org: r.org } : r))
          // keep the row while it still has approved domains to withdraw or domains to approve
          .filter((r) => r.id !== request.id || (r.pending_domains?.length ?? 0) > 0 || (r.verified_domains?.length ?? 0) > 0),
      );
      toast.success(approve ? `Domaine ${domain} approuvé` : `Domaine ${domain} retiré`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  // Only shown when there is something to review (or an error to show)
  if (requests === null || (requests.length === 0 && !error)) return null;

  return (
    <>
      <ErrorBox message={error} />
      {requests.length > 0 && (
        <SettingsCard
          icon={Globe}
          title={
            <>
              Domaines à valider <span className="tabular font-normal text-muted-foreground">({requests.length})</span>
            </>
          }
          description="Domaines e-mail demandés par le SSO d'une organisation. Une fois approuvé, un domaine sert à trouver ce SSO depuis une adresse et à faire confiance aux adresses du fournisseur pour les invitations. Vérifiez d'abord que l'organisation possède bien le domaine."
          className="[&>div:last-child]:p-0"
        >
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Organisation</TableHead>
                <TableHead>Fournisseur</TableHead>
                <TableHead>En attente</TableHead>
                <TableHead className="pr-5">Approuvés</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="py-3 pl-5">
                    <div className="font-medium">{r.org.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.org.slug}</div>
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <ProviderIcon kind={r.kind} className="size-3.5 text-muted-foreground" />
                      {r.name}
                    </div>
                    <div className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={r.issuer}>
                      {r.issuer}
                    </div>
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex flex-col items-start gap-1.5">
                      {(r.pending_domains ?? []).length === 0 && <span className="text-muted-foreground">-</span>}
                      {(r.pending_domains ?? []).map((d) => (
                        <div key={d} className="flex items-center gap-2">
                          <Chip tone="amber">
                            <span className="font-mono">{d}</span>
                          </Chip>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            disabled={saving}
                            onClick={() => setPending({ request: r, domain: d, approve: true })}
                          >
                            <Check /> Approuver
                          </Button>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="py-3 pr-5">
                    <div className="flex flex-col items-start gap-1.5">
                      {(r.verified_domains ?? []).length === 0 && <span className="text-muted-foreground">-</span>}
                      {(r.verified_domains ?? []).map((d) => (
                        <div key={d} className="flex items-center gap-1">
                          <Chip tone="green">
                            <span className="font-mono">{d}</span>
                          </Chip>
                          <Tip content="Retirer l'approbation">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-7 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                              disabled={saving}
                              onClick={() => setPending({ request: r, domain: d, approve: false })}
                              aria-label={`Retirer l'approbation de ${d}`}
                            >
                              <X />
                            </Button>
                          </Tip>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsCard>
      )}

      {pending && (
        <ConfirmModal
          title={pending.approve ? `Approuver ${pending.domain}` : `Retirer ${pending.domain}`}
          confirmLabel={pending.approve ? "Approuver" : "Retirer"}
          danger={!pending.approve}
          loading={saving}
          onConfirm={apply}
          onClose={() => setPending(null)}
        >
          {pending.approve ? (
            <>
              <p>
                <strong>{pending.request.org.name}</strong> pourra être trouvée depuis les adresses en{" "}
                <strong>@{pending.domain}</strong>, et les adresses de ce domaine données par{" "}
                <strong>{pending.request.name}</strong> seront acceptées pour ses invitations.
              </p>
              <p>
                Vérifiez avant d'approuver que l'organisation possède réellement ce domaine (enregistrement DNS,
                contrat, échange avec le client).
              </p>
            </>
          ) : (
            <p>
              Les adresses en <strong>@{pending.domain}</strong> ne mèneront plus au SSO de{" "}
              <strong>{pending.request.org.name}</strong>. Ses membres pourront toujours le trouver avec l'identifiant
              de l'organisation.
            </p>
          )}
        </ConfirmModal>
      )}
    </>
  );
}
