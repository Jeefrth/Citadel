# Coffre de secrets (OpenBao / HashiCorp Vault)

## Choix : OpenBao

| | OpenBao | HashiCorp Vault |
|---|---|---|
| Licence | MPL 2.0 (open source, Linux Foundation) | BSL 1.1 depuis 2023 (source disponible, usage commercial concurrent restreint) |
| API | Identique à Vault (fork de Vault 1.14) | Référence |
| Moteurs utilisés par Citadel | Transit, SSH, AppRole | Transit, SSH, AppRole |
| Image | `openbao/openbao:2.7.2` | `hashicorp/vault:2.2.x` |

Citadel est sous licence MIT et distribuable : un coffre open source évite toute contrainte de licence. Le code ne dépend que de l'API HTTP commune, donc **HashiCorp Vault fonctionne aussi** : changer l'image et adapter les chemins du service (`/vault/config/…` et `/vault/file` au lieu de `/openbao/…`, aussi dans `citadel.hcl`). Le backend et le bootstrap ne changent pas.

## Ce que le coffre protège

| Élément | Sans coffre (`local`) | Avec coffre (`vault`) |
|---|---|---|
| Mots de passe et clés des comptes | AES-256-GCM, clé `CREDENTIAL_ENCRYPTION_KEY` dans `.env` | **Transit** : chiffrés par le coffre, la clé ne le quitte jamais. Postgres ne contient que `vault:vN:…` |
| Clé privée de la CA SSH | Fichier `data/ca/ca_key` | **Moteur SSH** : la CA signe dans le coffre, la clé n'est jamais sur l'hôte Citadel |
| Accès de Citadel au coffre | n/a | **AppRole** avec une politique au moindre privilège (chiffrer, déchiffrer, rewrap, signer) |

Une fuite de la base ou du `.env` ne suffit plus à lire les secrets : il faut aussi un jeton valide sur le coffre.

## Démarrage (docker compose)

```
openbao          serveur, stockage Raft intégré, volume openbao-data
vault-bootstrap  job ponctuel et idempotent, relancé à chaque `up`
backend          démarre après la fin réussie du bootstrap
```

Le bootstrap :
1. initialise le coffre au premier lancement (1 clé de déverrouillage) et écrit `data/openbao/init/init.json` (clé de déverrouillage + jeton root, `chmod 600`) ;
2. déverrouille le coffre à chaque démarrage ;
3. active Transit et crée la clé `citadel-credentials` (aes256-gcm96, non exportable, non supprimable) ;
4. active le moteur SSH. **Si une CA locale existe déjà dans `data/ca`, il l'importe**, donc les serveurs qui lui font confiance n'ont rien à changer. Sinon il génère une CA ed25519 dans le coffre ;
5. crée la politique `citadel` et l'AppRole `citadel`, puis écrit `role_id` et `secret_id` dans `data/openbao/approle/` (monté en lecture seule dans le backend).

Variables (`.env`) : `SECRETS_BACKEND=vault`, `CA_BACKEND=vault`. Interface web du coffre en dev : http://127.0.0.1:8200 (jeton root dans `init.json`).

## Passer d'une base existante au coffre

1. Mettre `SECRETS_BACKEND=vault` et `CA_BACKEND=vault`, puis `docker compose up -d`.
2. Les nouveaux secrets sont écrits dans le coffre. Les anciens restent lisibles (Citadel reconnaît les deux formats).
3. Migrer les anciens : bouton dans Paramètres, ou `docker compose exec backend python -m app.cli secrets-migrate`.
4. Quand `secrets-status` affiche `local_blobs: 0`, retirer `CREDENTIAL_ENCRYPTION_KEY` du `.env`, et supprimer `data/ca/ca_key` après avoir vérifié qu'une connexion par certificat fonctionne.

## Rotation de la clé de chiffrement

Paramètres > Coffre, ou `python -m app.cli secrets-rotate-key`. Le coffre crée une nouvelle version de clé, puis Citadel fait un **rewrap** de chaque secret : le coffre rechiffre sans jamais renvoyer le clair.

## Cycle de vie des comptes (lot 2)

- **Vérification** : connexion de test avec le secret stocké (SSH, WinRM, ou certificat). Planifiée toutes les `ACCOUNT_VERIFY_INTERVAL_HOURS` (24 h).
- **Collecte** : liste des comptes du système (Linux : `getent passwd` + groupes sudo/wheel/admin + `lastlog` ; Windows : `Get-LocalUser` + groupe Administrateurs). Signale les comptes non gérés par Citadel. Planifiée toutes les `ACCOUNT_DISCOVERY_INTERVAL_HOURS` (24 h).
- **Rotation** des mots de passe, à la demande ou tous les N jours :
  1. nouveau mot de passe de 24 caractères, enregistré chiffré **avant** toute modification (statut `pending`) ;
  2. changement sur la cible via le compte par défaut du serveur (`chpasswd` sur stdin sous Linux, avec `sudo -n` si ce n'est pas root ; `Set-LocalUser` sous Windows) ;
  3. si le changement réussit : activation et vérification. Sinon : statut `failed`, l'ancien secret reste en place ;
  4. un identifiant partagé par plusieurs comptes n'est jamais modifié : le compte reçoit d'abord son propre identifiant ;
  5. historique conservé (5 derniers), sans jamais exposer les secrets par l'API.

Le planificateur tourne dans le backend toutes les `SCHEDULER_INTERVAL_SECONDS` (300 s), protégé par un verrou Redis (un seul cycle à la fois même avec plusieurs workers).

## Limites connues

- Rotation : mots de passe de comptes **locaux** uniquement. Pas encore de rotation des clés SSH ni des comptes de domaine Active Directory.
- Windows : le script de rotation contient le mot de passe ; si la journalisation des blocs de script PowerShell (événement 4104) est active sur la cible, il peut y apparaître. Purger ou restreindre ce journal, ou exclure le compte de service Citadel.
- Monitoring et mises à jour ne savent pas encore utiliser un compte par certificat.

## Production

Le mode compose fourni convient à un usage personnel ou de labo. Pour la production :

- **Auto-unseal** : configurer `seal "azurekeyvault"` (ou KMS/HSM) dans `deploy/openbao/citadel.hcl`. Plus de clé de déverrouillage sur disque.
- **Jeton root** : après le premier bootstrap, sortir `init.json` du serveur (coffre-fort hors ligne), puis révoquer le jeton root. Les bootstraps suivants nécessiteront alors un jeton admin fourni ponctuellement.
- **TLS** sur le listener si le coffre est accédé hors du réseau compose (`VAULT_CACERT` côté backend).
- **Sauvegardes** : `bao operator raft snapshot save` régulièrement. Sans le coffre, les secrets de la base sont irrécupérables.
- **Rotation du secret_id AppRole** : `python -m app.cli vault-bootstrap --rotate-secret-id`.

## Sauvegarde chiffrée des comptes (lot 7)

Paramètres > Sauvegardes. Une archive contient tous les comptes gérés (serveur, adresse, port, identifiant, mot de passe ou clé privée), chiffrée en **AES-256-GCM** avec une clé dérivée (scrypt, N=2^15) d'une **phrase de passe** choisie par un admin (16 caractères au moins). Citadel la garde chiffrée dans le coffre mais ne la réaffiche jamais : la conserver hors de Citadel (coffre-fort personnel), c'est le seul moyen de relire une sauvegarde si Citadel a disparu.

- Destinations : téléchargement (à la demande), stockage des enregistrements (local / S3 / Azure, sous `backups/`), e-mail (pièce jointe via les canaux e-mail actifs).
- Planification : `backup_interval_days` (0 = à la demande), `backup_destinations`, `backup_email_recipients`. Échec : notification `backup.failed`.
- Historique : date, déclencheur, destinations, nombre de comptes, taille, SHA-256 (l'archive elle-même n'est pas gardée en base).
- Le téléchargement et le changement de phrase de passe sont refusés avec une clé d'accès (session Entra obligatoire).

Relire une sauvegarde (fichier `.cab`) :

```bash
python -m app.cli backup-decrypt citadel-comptes-AAAAMMJJ-HHMMSS.cab -o comptes.json   # fichier en mode 600
```

Sans Citadel, avec Python et le paquet `cryptography` :

```python
import base64, json, getpass
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
head, env = open("sauvegarde.cab").read().split("\n", 2)[:2]
env = json.loads(env)
key = Scrypt(salt=base64.b64decode(env["salt"]), length=32, n=env["n"], r=env["r"], p=env["p"]).derive(getpass.getpass().encode())
print(AESGCM(key).decrypt(base64.b64decode(env["nonce"]), base64.b64decode(env["ciphertext"]), head.encode()).decode())
```

## API pour les applications (lot 7)

Paramètres > Applications : une application (script, CI, outil) lit les secrets qui lui sont accordés avec **sa propre clé** (`cap_...`, affichée une seule fois, seul son SHA-256 est gardé ; régénérable).

- Portée : serveurs, nœuds (avec sous-nœuds) ou étiquettes, et noms de comptes (`*` = tous).
- Adresses autorisées (CIDR) ; une application sans restriction d'IP est signalée comme risque. Expiration (365 jours par défaut).
- Chaque lecture et chaque refus est dans le journal d'audit (`app.secret_read`).

```bash
curl -H "Authorization: Bearer cap_..." "https://citadel/api/app/v1/secret?server=web-01&account=deploy"
# {"server":"web-01","address":"10.0.0.5","port":22,"username":"deploy","type":"ssh_password","password":"..."}
```

Un nom de serveur ambigu répond 409 : utiliser alors l'identifiant du serveur.
