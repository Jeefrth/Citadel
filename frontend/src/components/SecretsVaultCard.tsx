// Settings > "Coffre de secrets": backend status, blob inventory, migration of
// local blobs to the vault and transit key rotation (admin only).
import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, KeyRound, RefreshCw } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type SecretsMigrateResult,
  type SecretsRotateKeyResult,
  type SecretsStatus,
} from "@/services/types";
import { Chip, ConfirmModal, ErrorBox, Notice, type NoticeData } from "@/components/kit";
import { FactRow as Row, RowsSkeleton, SettingsCard, StatusDot, Tip, type DotTone } from "@/components/auditUi";
import { Button } from "@/components/ui/button";

export default function SecretsVaultCard() {
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [confirm, setConfirm] = useState<"migrate" | "rotate" | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<SecretsStatus>("/api/admin/secrets/status")
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const migrate = async () => {
    setRunning(true);
    try {
      const r = await api.post<SecretsMigrateResult>("/api/admin/secrets/migrate", {});
      setNotice({
        ok: r.failed === 0,
        text: (
          <>
            <p>
              {r.migrated} secret{r.migrated > 1 ? "s" : ""} migré{r.migrated > 1 ? "s" : ""} vers le coffre
              {r.failed > 0 && `, ${r.failed} en échec`}.
            </p>
            {r.errors.length > 0 && (
              <ul className="mt-1 text-xs font-mono list-disc pl-4">
                {r.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </>
        ),
      });
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setRunning(false);
      setConfirm(null);
      load();
    }
  };

  const rotateKey = async () => {
    setRunning(true);
    try {
      const r = await api.post<SecretsRotateKeyResult>("/api/admin/secrets/rotate-key", {});
      setNotice({
        ok: true,
        text: `Clé de chiffrement passée en version ${r.latest_version} ; ${r.rewrapped} secret${
          r.rewrapped > 1 ? "s" : ""
        } rechiffré${r.rewrapped > 1 ? "s" : ""}.`,
      });
    } catch (e) {
      setNotice({ ok: false, text: errorMessage(e) });
    } finally {
      setRunning(false);
      setConfirm(null);
      load();
    }
  };

  const vault = status?.vault ?? null;
  const isVault = status?.secrets_backend === "vault";
  const vaultUsable = isVault && vault?.reachable === true && vault.sealed === false;
  const canMigrate = vaultUsable && (status?.local_blobs ?? 0) > 0;
  const blobs = Object.entries(status?.blobs || {}).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const latest = vault?.reachable ? vault.latest_version : undefined;

  // Overall health: usable vault (or configured local key) = green, unreachable vault = red
  const health: DotTone = !status
    ? "muted"
    : isVault
      ? vaultUsable
        ? "success"
        : "danger"
      : status.local_key_configured
        ? "success"
        : "danger";

  return (
    <div className="space-y-4">
      <SettingsCard
        status={<StatusDot tone={health} />}
        title="Coffre de secrets"
        description="Chiffrement des mots de passe et clés des comptes, et autorité de certification SSH."
        actions={
          <Tip content="Actualiser">
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={load} disabled={loading} aria-label="Actualiser">
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
          </Tip>
        }
      >
        <div className="space-y-3">
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <ErrorBox message={error} />
          {!status && loading && <RowsSkeleton rows={5} />}
          {status && (
            <dl>
              <Row label="Chiffrement des secrets">
                {isVault ? (
                  <Chip tone="green">Coffre OpenBao / Vault (Transit)</Chip>
                ) : (
                  <Chip tone="amber">Local (AES-256-GCM)</Chip>
                )}
              </Row>
              <Row label="Autorité de certification SSH">
                {status.ca_backend === "vault" ? <Chip tone="green">Coffre</Chip> : <Chip>Locale</Chip>}
              </Row>
              {!isVault && (
                <Row label="Clé locale configurée">
                  {status.local_key_configured ? <Chip tone="green">oui</Chip> : <Chip tone="red">non</Chip>}
                </Row>
              )}
              <Row label="Adresse du coffre">
                <span className="break-all font-mono text-xs">{status.vault_addr || "-"}</span>
              </Row>
              <Row label="État du coffre">
                {!vault ? (
                  "-"
                ) : vault.reachable ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    <Chip tone="green">joignable</Chip>
                    {vault.initialized === false && <Chip tone="red">non initialisé</Chip>}
                    {vault.sealed ? <Chip tone="red">scellé</Chip> : <Chip tone="green">descellé</Chip>}
                    {vault.version && (
                      <Chip>
                        <span className="font-mono">v{vault.version}</span>
                      </Chip>
                    )}
                  </span>
                ) : (
                  <span className="flex flex-col items-end gap-1">
                    <Chip tone={isVault ? "red" : "default"}>injoignable</Chip>
                    <span className="max-w-md break-all font-mono text-xs text-muted-foreground">{vault.error}</span>
                  </span>
                )}
              </Row>
              {vault?.reachable && vault.transit_key && (
                <Row label="Clé Transit">
                  <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                    <span className="font-mono text-xs">{vault.transit_key}</span>
                    <Chip tone="primary">
                      <span className="tabular">version {vault.latest_version ?? "?"}</span>
                    </Chip>
                  </span>
                  {vault.min_decryption_version !== undefined && (
                    <p className="text-xs text-muted-foreground">
                      Déchiffrement depuis <span className="font-mono">v{vault.min_decryption_version}</span>
                    </p>
                  )}
                </Row>
              )}
              <Row label="Secrets chiffrés">
                {blobs.length === 0 ? (
                  <span className="text-muted-foreground">aucun</span>
                ) : (
                  <span className="flex flex-wrap justify-end gap-1">
                    {blobs.map(([k, n]) => {
                      const local = k === "local";
                      const ver = local ? null : Number(k.replace("vault:v", ""));
                      const outdated = latest !== undefined && ver !== null && ver < latest;
                      return (
                        <Chip
                          key={k}
                          tone={local ? (isVault ? "amber" : "default") : outdated ? "amber" : "green"}
                          title={outdated ? "Chiffré avec une ancienne version de la clé" : undefined}
                        >
                          <span className="tabular">
                            {local ? "local" : `coffre v${ver}`} : {n}
                          </span>
                        </Chip>
                      );
                    })}
                  </span>
                )}
              </Row>
              {vault?.reachable && vault.outdated_blobs !== undefined && (
                <Row label="Secrets sur une ancienne version de clé">
                  <Chip tone={vault.outdated_blobs > 0 ? "amber" : "green"}>
                    <span className="tabular">{vault.outdated_blobs}</span>
                  </Chip>
                </Row>
              )}
            </dl>
          )}
        </div>
      </SettingsCard>

      {status && (
        <SettingsCard title="Opérations">
          <div className="divide-y">
            <div className="flex items-start justify-between gap-4 pb-4">
              <div>
                <p className="text-sm font-medium">Migrer les secrets locaux vers le coffre</p>
                <p className="text-xs text-muted-foreground">
                  Rechiffre avec la clé Transit du coffre chaque secret encore chiffré avec la clé locale.
                  {!isVault && (
                    <>
                      {" "}Nécessite <span className="font-mono">SECRETS_BACKEND=vault</span>.
                    </>
                  )}
                  {isVault && status.local_blobs === 0 && " Aucun secret local à migrer."}
                </p>
              </div>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => setConfirm("migrate")} disabled={!canMigrate || running}>
                <ArrowRightLeft /> Migrer (<span className="tabular">{status.local_blobs}</span>)
              </Button>
            </div>
            <div className="flex items-start justify-between gap-4 pt-4">
              <div>
                <p className="text-sm font-medium">Faire tourner la clé de chiffrement</p>
                <p className="text-xs text-muted-foreground">
                  Crée une nouvelle version de la clé Transit puis rechiffre (rewrap) les secrets dans le coffre. Les
                  secrets ne sont jamais exposés en clair, ni à Citadel ni dans les journaux.
                  {!isVault && (
                    <>
                      {" "}Nécessite <span className="font-mono">SECRETS_BACKEND=vault</span>.
                    </>
                  )}
                </p>
              </div>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => setConfirm("rotate")} disabled={!vaultUsable || running}>
                <KeyRound /> Faire tourner la clé
              </Button>
            </div>
          </div>
        </SettingsCard>
      )}

      {confirm === "migrate" && (
        <ConfirmModal
          title="Migrer les secrets locaux vers le coffre"
          confirmLabel="Migrer"
          loading={running}
          onClose={() => setConfirm(null)}
          onConfirm={migrate}
        >
          <p>
            {status?.local_blobs} secret(s) chiffré(s) avec la clé locale vont être rechiffrés avec la clé
            Transit du coffre.
          </p>
          <p>
            Conservez la clé locale (CREDENTIAL_ENCRYPTION_KEY) tant que la migration n'est pas complète :
            les secrets en échec en dépendent toujours.
          </p>
        </ConfirmModal>
      )}
      {confirm === "rotate" && (
        <ConfirmModal
          title="Faire tourner la clé de chiffrement"
          confirmLabel="Faire tourner la clé"
          loading={running}
          onClose={() => setConfirm(null)}
          onConfirm={rotateKey}
        >
          <p>
            Une nouvelle version de la clé Transit
            {vault?.reachable && vault.transit_key ? (
              <>
                {" "}
                <span className="font-mono">{vault.transit_key}</span>
              </>
            ) : null}{" "}
            va être créée, puis tous les secrets seront rechiffrés avec elle.
          </p>
          <p>
            Le rechiffrement (rewrap) se fait dans le coffre : les secrets ne sont jamais déchiffrés ni
            exposés en clair. Les mots de passe des serveurs ne changent pas.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}
