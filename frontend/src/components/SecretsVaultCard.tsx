// Settings > "Coffre de secrets": backend status, blob inventory, migration of
// local blobs to the vault and transit key rotation (admin only).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRightLeft, KeyRound, Loader2, RefreshCw, Vault } from "lucide-react";
import { api } from "@/services/api";
import {
  errorMessage,
  type SecretsMigrateResult,
  type SecretsRotateKeyResult,
  type SecretsStatus,
} from "@/services/types";
import { Chip, ConfirmModal, ErrorBox, Notice, btnSecondary, type NoticeData } from "@/components/kit";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

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

  return (
    <div className="space-y-4">
      <div className="bg-card border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Vault size={18} /> Coffre de secrets
          </h3>
          <button onClick={load} disabled={loading} className="p-1.5 rounded hover:bg-accent text-muted-foreground" title="Actualiser">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="space-y-2 mb-4">
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <ErrorBox message={error} />
        </div>
        {!status && loading && <Loader2 size={20} className="animate-spin text-muted-foreground" />}
        {status && (
          <dl className="text-sm">
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
              <span className="font-mono text-xs">{status.vault_addr || "-"}</span>
            </Row>
            <Row label="État du coffre">
              {!vault ? (
                "-"
              ) : vault.reachable ? (
                <span className="flex flex-wrap justify-end gap-1">
                  <Chip tone="green">joignable</Chip>
                  {vault.initialized === false && <Chip tone="red">non initialisé</Chip>}
                  {vault.sealed ? <Chip tone="red">scellé</Chip> : <Chip tone="green">descellé</Chip>}
                  {vault.version && <Chip>v{vault.version}</Chip>}
                </span>
              ) : (
                <span className="flex flex-col items-end gap-1">
                  <Chip tone={isVault ? "red" : "default"}>injoignable</Chip>
                  <span className="text-xs text-muted-foreground break-all max-w-md">{vault.error}</span>
                </span>
              )}
            </Row>
            {vault?.reachable && vault.transit_key && (
              <Row label="Clé Transit">
                <span className="font-mono text-xs">{vault.transit_key}</span>{" "}
                <Chip tone="primary">version {vault.latest_version ?? "?"}</Chip>
                {vault.min_decryption_version !== undefined && (
                  <span className="text-xs text-muted-foreground ml-1">
                    (déchiffrement depuis v{vault.min_decryption_version})
                  </span>
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
                        {local ? "local" : `coffre v${ver}`} : {n}
                      </Chip>
                    );
                  })}
                </span>
              )}
            </Row>
            {vault?.reachable && vault.outdated_blobs !== undefined && (
              <Row label="Secrets sur une ancienne version de clé">
                <Chip tone={vault.outdated_blobs > 0 ? "amber" : "green"}>{vault.outdated_blobs}</Chip>
              </Row>
            )}
          </dl>
        )}
      </div>

      {status && (
        <div className="bg-card border rounded-lg p-6 space-y-4">
          <h3 className="font-semibold">Opérations</h3>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Migrer les secrets locaux vers le coffre</p>
              <p className="text-xs text-muted-foreground">
                Rechiffre avec la clé Transit du coffre chaque secret encore chiffré avec la clé locale.
                {!isVault && " Nécessite SECRETS_BACKEND=vault."}
                {isVault && status.local_blobs === 0 && " Aucun secret local à migrer."}
              </p>
            </div>
            <button
              onClick={() => setConfirm("migrate")}
              disabled={!canMigrate || running}
              className={`${btnSecondary} shrink-0`}
            >
              <ArrowRightLeft size={14} /> Migrer ({status.local_blobs})
            </button>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Rotation de la clé de chiffrement</p>
              <p className="text-xs text-muted-foreground">
                Crée une nouvelle version de la clé Transit puis rechiffre (rewrap) les secrets dans le
                coffre. Les secrets ne sont jamais exposés en clair, ni à Citadel ni dans les journaux.
                {!isVault && " Nécessite SECRETS_BACKEND=vault."}
              </p>
            </div>
            <button
              onClick={() => setConfirm("rotate")}
              disabled={!vaultUsable || running}
              className={`${btnSecondary} shrink-0`}
            >
              <KeyRound size={14} /> Faire tourner la clé
            </button>
          </div>
        </div>
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
          title="Rotation de la clé de chiffrement"
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
