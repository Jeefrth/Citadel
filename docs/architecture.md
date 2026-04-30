# Citadel — Documentation Architecture

> Schemas Excalidraw (ouvrir avec excalidraw.com ou extension VS Code) :
>
> - `01-architecture-generale.excalidraw` — Vue d'ensemble 3 tiers
> - `02-flux-auth-entra.excalidraw` — Flux OAuth2/OIDC avec Entra ID
> - `03-modele-donnees.excalidraw` — Tables, relations FK et enums

## 1. Vision

Citadel est une application web de gestion centralisee de serveurs Windows et Linux
avec bastion SSH securise integre. Elle permet de gerer un inventaire de serveurs,
executer des commandes a distance, gerer les mises a jour, monitorer les metriques,
et se connecter en terminal interactif avec authentification renforcee (MFA)
et certificats SSH ephemeres.

## 2. Architecture Generale

```text
Utilisateur (Navigateur)
    |
    | HTTPS
    v
+--------------------------------------------------+
|              FRONTEND (React + TS)               |
|  MSAL.js (Entra ID) → Bearer Token              |
|  Pages: Dashboard, Serveurs, Terminal,           |
|         Sessions, Updates, Audit                 |
+--------------------------------------------------+
    |                              |
    | REST API                     | WebSocket
    v                              v
+--------------------------------------------------+
|               BACKEND (FastAPI)                  |
|                                                  |
|  Auth Middleware (JWKS)    Mini-CA (Ed25519)     |
|  RBAC (admin/op/viewer)   Certificats ephemeres |
|  Command Filter            Session Recording     |
|  Rate Limiting             Idle Timeout (30min)  |
+--------------------------------------------------+
    |          |          |           |
    v          v          v           v
+--------+ +-------+ +----------+ +------------------+
|PostgreSQL| |Redis | |Serveurs  | |Microsoft Entra ID|
|          | |      | |Linux(SSH)| |  OAuth2/OIDC     |
|9 tables  | |cache | |Win(WinRM)| |  MFA             |
+--------+ +-------+ +----------+ +------------------+
```

## 3. Stack Technique

| Couche | Technologie | Role |
|--------|-------------|------|
| Frontend | React 18 + TypeScript + Vite | SPA avec routing |
| UI | Shadcn/ui + Tailwind CSS | Composants + style |
| Terminal | xterm.js + addon-fit + addon-web-links | Terminal web |
| Backend | Python 3.12+ + FastAPI | API REST + WebSocket |
| ORM | SQLAlchemy 2 (async) + Alembic | BDD + migrations |
| BDD | PostgreSQL 16 | Stockage principal |
| Cache | Redis 7 | Sessions, cache |
| SSH | asyncssh + ssh-keygen | Connexion + certificats |
| WinRM | pywinrm (NTLM) | PowerShell distant |
| Auth | MSAL.js (front) + python-jose (back) | Entra ID tokens |
| CA | ssh-keygen (Ed25519) | Certificats ephemeres |
| Securite | AES-256-GCM (cryptography) | Chiffrement credentials |
| Container | Docker + Docker Compose | Dev et prod |

## 4. Modules Fonctionnels

### 4.1 Inventaire Serveurs

- CRUD serveurs (nom, hostname, IP, OS, ports, tags)
- Groupes de serveurs
- 4 types de credentials : ssh_password, ssh_key, winrm, ephemeral_cert
- Test de connectivite (SSH/WinRM)
- Import d'infos systeme

### 4.2 Terminal Distant (Bastion)

- Terminal interactif SSH via WebSocket + xterm.js
- Multi-onglets (plusieurs serveurs simultanes)
- Modale MFA obligatoire avant ouverture (`prompt: "login"`)
- Session recording (tous les I/O enregistres avec timestamps)
- Replay de sessions (play/pause/reset, vitesse 1x/2x/5x/10x)
- Timeout d'inactivite (30 minutes)
- Theme Tokyo Night

### 4.3 Mini-CA (Certificats Ephemeres)

- Cle CA Ed25519 generee au demarrage, persistee dans `data/ca/`
- Signature de certificats SSH via ssh-keygen
- Duree configurable : 5 min, 15 min, 30 min, 1h, 2h, 4h, 8h, 12h, 24h
- Zero secret stocke en BDD pour ce type de credential
- Setup serveur : une ligne dans sshd_config (TrustedUserCAKeys)

### 4.4 Gestion des Mises a Jour

- Detection automatique du package manager (apt/dnf/yum)
- Scan Windows Update via COM
- Classification severite (critical, important, moderate, low)
- Application des MAJ avec suivi des jobs
- Rapport de conformite

### 4.5 Monitoring et Dashboard

- Collecte metriques : CPU, RAM, disque, reseau, uptime, processus
- Stockage historique en BDD (table server_metrics)
- Dashboard : cartes resume, barres de progression, alertes
- Page detail serveur : sparklines SVG (24h), infos systeme
- Alertes configurables sur seuils (CPU > 90%, etc.)

### 4.6 Securite

- Auth : Microsoft Entra ID (OAuth2/OIDC avec PKCE)
- MFA par session : popup re-auth avant chaque terminal
- RBAC : admin, operator, viewer
- Credentials : AES-256-GCM avec nonce aleatoire
- Command filter : blocklist regex (rm -rf, mkfs, dd, fork bomb, etc.)
- Rate limiting : 200 req/min par IP
- Security headers : CSP, X-Frame-Options, X-Content-Type-Options
- Audit : toutes les actions loguees

## 5. Flux d'Authentification

```text
1. User clique "Se connecter"
2. MSAL.js redirect vers Entra ID
3. User s'authentifie (+ MFA si Conditional Access)
4. Entra renvoie un authorization code
5. MSAL.js echange le code → access_token + id_token (PKCE)
6. Frontend envoie Bearer token dans chaque requete API
7. Backend valide le token via JWKS (cles publiques Microsoft)
8. Si premier login : creation du profil en BDD (premier user = admin)
```

Pour le terminal :

```text
1. User clique sur un serveur dans le picker
2. Modale "Verification d'identite" apparait
3. User clique "Confirmer (MFA)"
4. Popup Microsoft s'ouvre → login + MFA
5. Token frais obtenu → WebSocket s'ouvre
6. Backend valide le token, ouvre session SSH
7. Si credential = ephemeral_cert : signe un certificat a la volee
8. Terminal interactif demarre, I/O enregistres
9. A la fermeture : session sauvee en BDD
```

## 6. Modele de Donnees

9 tables PostgreSQL :

| Table | Description |
|-------|-------------|
| users | Profils synchronises depuis Entra ID (oid, email, role) |
| servers | Inventaire serveurs (nom, IP, OS, ports, status, tags) |
| server_groups | Groupement logique de serveurs |
| credentials | Identifiants (ssh_password, ssh_key, winrm, ephemeral_cert) |
| audit_logs | Journal de toutes les actions (user, server, action, timestamp) |
| update_jobs | Jobs de mise a jour (status, output, timestamps) |
| server_metrics | Metriques historiques (CPU, RAM, disque, reseau) |
| alert_rules | Regles d'alerte sur seuils |
| session_recordings | Enregistrements terminal (events JSONB timestamps) |

Enums :

- role : admin, operator, viewer
- os_type : linux, windows
- credential_type : ssh_password, ssh_key, winrm, ephemeral_cert
- server_status : online, offline, unknown
- job_status : pending, running, completed, failed, cancelled

## 7. Securite en Detail

### Authentification Entra ID

- Frontend : MSAL.js avec Authorization Code + PKCE (SPA flow)
- Backend : validation JWT via JWKS (cles publiques Microsoft)
- Support audiences : `api://<client_id>` et `<client_id>` brut
- Compatibilite issuer v1 et v2
- Premier utilisateur auto-promu admin

### Bastion SSH

- Mini-CA Ed25519 persistee dans `data/ca/` (exclue du git)
- Certificats signes via `ssh-keygen -s` (pas l'API asyncssh, plus fiable)
- Duree configurable de 5 minutes a 24 heures
- Certificat genere a chaque connexion, nettoye apres usage
- Le serveur cible doit avoir `TrustedUserCAKeys` dans sshd_config

### MFA par Session

- Chaque ouverture de terminal declenche `acquireTokenPopup` avec `prompt: "login"`
- Force une re-authentification complete via Entra ID
- Si Conditional Access configure avec "Every time" → MFA a chaque terminal
- Modale de confirmation cote UI avant le popup

### Protection des Commandes

Blocklist regex sur le endpoint `/execute` :

- `rm -rf /`, `mkfs.*`, `dd of=/dev/sd*`
- Fork bomb : `:(){ :|:& };`
- `shutdown`, `reboot`, `halt`, `poweroff`, `init 0`
- `wget|sh`, `curl|sh`, `curl|bash`
- `chmod 777 /`, `> /dev/sd*`

### Chiffrement

- Credentials serveur : AES-256-GCM avec nonce aleatoire 12 bytes
- Cle de chiffrement dans `.env` (CREDENTIAL_ENCRYPTION_KEY)
- CA private key : fichier avec permissions 600

## 8. Deploiement

### Dev local

```bash
docker-compose up -d db redis    # BDD + Redis
cd backend && .venv/bin/uvicorn app.main:app --reload
cd frontend && npm run dev
```

### Production

```bash
docker-compose -f docker-compose.prod.yml up -d
```

- Frontend : nginx (build React) avec proxy API/WS
- Backend : Python slim avec user non-root
- PostgreSQL + Redis sans ports exposes
- Health checks sur tous les services
