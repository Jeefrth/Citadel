# CLAUDE.md

## Projet

**Citadel** — Application web de gestion centralisée de serveurs Windows et Linux avec bastion SSH sécurisé.

- Dépôt GitHub : `https://github.com/Jeefrth/Citadel.git`
- Branche principale : `main`
- Chef de projet : Claude (assistant IA)
- Développeur : Jean-François Reithler

## Stack Technique

| Couche | Technologie |
|--------|-------------|
| Frontend | React 18 + TypeScript + Vite |
| UI Kit | Shadcn/ui + Tailwind CSS |
| Terminal | xterm.js + WebSocket |
| Backend | Python 3.12+ + FastAPI |
| BDD | PostgreSQL 16 |
| Cache | Redis 7 |
| SSH | asyncssh + ssh-keygen (certificats éphémères) |
| WinRM | pywinrm (NTLM) |
| Auth | Microsoft Entra ID (MSAL.js + JWKS) |
| CA | Mini-CA Ed25519 via ssh-keygen |
| Container | Docker + Docker Compose |
| Cloud | Azure VM (cible production) |

## Documentation

- Architecture et schémas : `docs/architecture.md`
- Schémas Excalidraw : `docs/01-*.excalidraw`, `docs/02-*.excalidraw`, `docs/03-*.excalidraw`
- Roadmap (sprints D/E/F sécurité + axes ultérieurs) : `docs/roadmap.md`
- Coffre de secrets (OpenBao) et cycle de vie des comptes : `docs/vault.md`
- Gouvernance (ACL, validations, notifications) : `docs/governance.md`
- Audit (enregistrements, journal, direct, SIEM) : `docs/audit.md`
- Opérations (fichiers, tâches, passerelles, Azure) : `docs/operations.md`
- Design de l'interface : `docs/design.md`
- README complet : `README.md`

## Historique des phases

- **Phase 0** : Cadrage, architecture, modèle de données, schémas Excalidraw
- **Phase 1** : Fondations — FastAPI, SQLAlchemy, Alembic, React+Vite, MSAL.js, Docker Compose
- **Phase 2** : Connectivité — SSH (asyncssh), WinRM (pywinrm), test connexion, exécution commandes
- **Phase 3** : Terminal interactif — WebSocket, xterm.js, session manager, multi-onglets
- **Phase 4** : Mises à jour — scan apt/dnf/yum + Windows Update, application, jobs, conformité
- **Phase 5** : Monitoring — métriques CPU/RAM/disque, dashboard, sparklines, alertes sur seuils
- **Phase 6** : Production — Dockerfiles multi-stage, nginx, tests pytest, rate limiting, security headers
- **Sprint A** : Session recording — enregistrement I/O terminal, replay xterm.js (play/pause/vitesse)
- **Sprint B** : Mini-CA — certificats SSH éphémères Ed25519 (5min à 24h), zéro secret stocké
- **Sprint C** : Hardening — MFA par session (popup Entra), command filter, timeout 30min, CA persistante
- **Sprint PAM-5** (11/2026) : opérations : SFTP web, tâches (commandes, playbooks Ansible), zones et passerelles, import Azure. Voir `docs/operations.md`
- **Sprint PAM-4** (11/2026) : audit : enregistrement RDP, journal des commandes, sessions en direct (observer, terminer), stockage local/S3/Azure + SHA-256 + rétention, export SIEM. Voir `docs/audit.md`
- **Sprint PAM-3** (11/2026) : ACL de connexion et de commandes (API + terminal, `websocket/line_tracker.py`), validation à 4 yeux, demandes d'accès, notifications. Voir `docs/governance.md`
- **Sprint PAM-2** (11/2026) : coffre OpenBao (Transit, CA SSH, AppRole, bootstrap idempotent), migration local → coffre et rotation de clé, rotation des mots de passe, vérification et collecte des comptes, planificateur (verrou Redis). Voir `docs/vault.md`
- **Sprint PAM-1** (11/2026, inspiré de JumpServer, réimplémenté) : règles d'accès (C1), comptes par serveur (B1), comptes virtuels @ALL/@USER/@INPUT (B9), arborescence de nœuds (A1), étiquettes (A2), favoris (A5), clés API personnelles (F4), tickets RDP à usage unique

## Conventions

- Langue de communication : français
- Code et commentaires : anglais
- Messages de commit : clairs et concis, en anglais
- Mise à jour de CLAUDE.md à chaque évolution majeure
- Schémas et documentation technique dans `docs/`
- Sécurité : pas de secrets dans le code, credentials chiffrés en BDD
- Variables sensibles dans `.env` (jamais commité)
- Clé CA dans `data/ca/` (jamais commitée)

## Cartographie du code

### Backend (`backend/`)

```
backend/
├── app/
│   ├── main.py              # FastAPI app, middleware stack, registration des routers
│   ├── api/                 # Routers REST (auth, servers, commands, updates, monitoring,
│   │                        #               sessions, users, ca, admin, pam)
│   ├── models/              # Entités SQLAlchemy (User, Server, Credential, AuditLog,
│   │                        #   UpdateJob, ServerMetric, AlertRule, SessionRecording,
│   │                        #   AppSetting) + pam.py (Node, Account, UserGroup,
│   │                        #   AccessPolicy, UserFavorite, AccessKey)
│   ├── schemas/             # Pydantic request/response
│   ├── services/            # Business logic (ssh_service, winrm_service, tickets (Redis),
│   │                        #                 monitoring_service, update_service,
│   │                        #                 ca_service, settings_service,
│   │                        #                 connection_manager)
│   ├── core/                # config, database, auth (JWT/JWKS + clés ctk_), security (AES-256-GCM),
│   │                        # permissions (évaluation des règles d'accès, résolution des comptes),
│   │                        # middleware (security headers, rate limit, logging),
│   │                        # command_filter (regex blocklist)
│   └── websocket/           # terminal (SSH WebSocket + recorder), rdp (Guacamole),
│                            # session_manager
├── alembic/versions/        # Migrations DB (initial, ephemeral cert, recordings,
│                            # cert auth fields, validity_minutes, app_settings,
│                            # email unique constraint, pam_core)
├── tests/
└── requirements.txt
```

**Endpoints principaux** :
- `/api/auth/me` — utilisateur courant (JWT)
- `/api/servers` — CRUD serveurs (filtres node/label/q/favoris), comptes, favoris, credentials
- `/api/servers/{id}/connectable-accounts`, `/connect-ticket` — choix du compte, ticket RDP 60 s
- `/api/nodes`, `/api/user-groups`, `/api/access-policies` — administration PAM
- `/api/me/access`, `/api/users/{id}/access` — accès effectifs ; `/api/access-keys` — clés API
- `/api/servers/{id}/test`, `/execute`, `/system-info` — connectivité
- `/api/servers/{id}/updates/scan|apply` + `/api/servers/updates/jobs` — patch management
- `/api/monitoring/*` — métriques + alertes + dashboard
- `/api/sessions` — historique sessions + recordings + bulk delete
- `/api/users` — admin users
- `/api/ca/public-key`, `/api/ca/setup-instructions` — Mini-CA Ed25519
- `/api/admin/*` — settings globaux, info système
- WebSocket : terminal SSH (xterm.js), RDP (Guacamole)

**Middleware stack (ordre d'exécution)** : SecurityHeaders → RequestLogging → RateLimit (200 req/min) → CORS

**Énumérations clés** : UserRole (admin/operator/viewer), OSType, CredentialType (ssh_password / ssh_key / winrm / ephemeral_cert), ServerStatus, JobStatus, PolicyAction (connect / execute / copy / paste)

### Frontend (`frontend/`)

```
frontend/
├── src/
│   ├── main.tsx             # Entry Vite + init MSAL
│   ├── App.tsx              # Routing (support dev mode bypass)
│   ├── pages/               # Dashboard, Servers, ServerDetail, TerminalPage, Sessions,
│   │                        # Updates, Audit, Settings (coffre, notifications), Access
│   │                        # (règles, groupes, accès effectifs, comptes découverts, ACL),
│   │                        # Approvals (validations 4 yeux, demandes d'accès), MyAccount
│   ├── components/          # Layout (sidebar + NotificationBell), LoginPage, Terminal,
│   │                        # RdpViewer, NodeTree, ConnectDialog, AccountsSection,
│   │                        # DiscoveredAccounts, SecretsVaultCard, AclRules,
│   │                        # NotificationChannels, ui.tsx (briques communes)
│   ├── services/            # authConfig.ts (MSAL), api.ts (fetch typé + Bearer)
│   └── lib/                 # utils.ts
├── vite.config.ts
└── package.json             # React 18, Vite 6, Shadcn/ui, xterm.js 5.5,
                             # @azure/msal-browser 3.27, @azure/msal-react 2.1,
                             # guacamole-common-js 1.5, react-router-dom 7
```

**Flux auth** : MSAL → Entra ID (OAuth2/OIDC PKCE) → token Bearer dans headers ; pour le terminal, `acquireTokenPopup({ prompt: "login" })` force MFA avant ouverture WebSocket.

### Docker (`docker-compose.yml`)

Services dev : `guacd` (1.6.0, non publié, enregistre dans `data/recordings/raw`), `openbao` (2.7.2, UI sur 127.0.0.1:8200), `vault-bootstrap` (job idempotent : init, unseal, transit, CA SSH, AppRole ; fichiers dans `data/openbao/`), `db` (Postgres 16, 5432), `redis` (7, 6379), `backend` (FastAPI, port hôte `BACKEND_PORT`, 8000 par défaut ; 8010 sur le Mac de JF car 8000 est pris par un serveur LLM local), `guacd` (Guacamole, 4822), `frontend` (Vite, 5173, proxy vers `backend:8000`). Clé de la CA montée depuis `./data/ca`. Prod : `docker-compose.prod.yml` avec nginx en reverse proxy, pas d'exposition DB/Redis.

### Décisions architecturales clés

1. **Certificats SSH éphémères** : Mini-CA Ed25519 signe à la demande des certs courts (5 min à 24 h) → `cert_validity_minutes` ; aucun secret stocké pour ce type de credential.
2. **Session recording** : événements I/O terminal timestampés, base64-encodés, stockés en JSONB ; replay xterm.js avec contrôle de vitesse.
3. **MFA par session terminal** : popup Entra forcé avant chaque ouverture WebSocket.
4. **Chiffrement credentials** : `SECRETS_BACKEND=vault` → OpenBao Transit (`vault:vN:…` en base, clé jamais hors du coffre) ; `local` → AES-256-GCM avec `CREDENTIAL_ENCRYPTION_KEY`. `decrypt_value` lit les deux formats. CA SSH dans le coffre si `CA_BACKEND=vault`.
5. **Command filter** : blocklist regex (rm -rf, mkfs, dd, fork bomb, shutdown, curl|sh…).
6. **RBAC + règles d'accès** : 3 rôles (admin / operator / viewer). L'admin voit tout ; les autres ne voient que les serveurs accordés par une `AccessPolicy` (utilisateurs ou groupes × serveurs, nœuds avec sous-nœuds ou étiquettes × comptes × actions, fenêtre de validité). Le rôle sert de plafond (viewer : jamais `execute`). Un serveur invisible renvoie 404.
7. **Async** : FastAPI + asyncio + asyncssh + asyncpg pour haute concurrence.
8. **Timeout terminal** : 30 minutes d'inactivité.
9. **Comptes** : un serveur a N comptes (`Account`) dont un « par défaut » utilisé par l'automatisation (monitoring, mises à jour, commandes). Secret = `Credential` référencé ou certificat éphémère. Comptes virtuels dans les règles : `@ALL`, `@USER` (partie locale de l'UPN + certificat), `@INPUT` (saisi à la connexion, jamais stocké).
10. **RDP par ticket** : `POST /connect-ticket` contrôle les droits et résout le compte, puis le WebSocket n'accepte qu'un ticket Redis à usage unique (60 s). Aucun jeton ni mot de passe dans les URL (uvicorn journalise les query strings).
11. **Clés API** : `ctk_<prefix>_<secret>`, seul le SHA-256 est stocké, héritent des droits de l'utilisateur, ne peuvent pas créer d'autres clés.
12. **Gouvernance** : point de contrôle unique `services/enforcement.py` (terminal, ticket RDP, execute). Règles ordonnées par priorité, première correspondance gagnante, aucune = autorisé. 4 yeux strict (jamais sa propre demande). IP client via `core/governance.client_ip` (X-Forwarded-For seulement depuis `TRUSTED_PROXIES`).
13. **Audit** : enregistrements stockés hors base (gzip + SHA-256 vérifié à la relecture, `services/recording_storage.py`), registre des sessions en direct dans Redis (`services/live.py`, pub/sub sortie + contrôle), SIEM par curseur persistant (`services/siem.py`).
14. **Routage** : `services/routing.py`, `async with routing.via(server)` déclare la route ; `ssh_service._connect` et `session_manager` prennent la passerelle en `tunnel=`, WinRM/RDP/Ansible passent par `tcp_endpoint` (redirection de port). Tout nouvel accès à un serveur doit être entouré de `via(server)`.

## Commandes utiles

```bash
# Dev local (backend + frontend avec accès réseau LAN)
docker-compose up -d db redis
cd backend && .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
cd frontend && npm run dev

# Docker complet
docker-compose up -d

# Migrations
cd backend && .venv/bin/python -m alembic upgrade head

# Générer clé de chiffrement
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM; import base64; print(base64.b64encode(AESGCM.generate_key(bit_length=256)).decode())"

# Clé publique CA (pour setup serveurs)
curl http://localhost:8010/api/ca/public-key   # BACKEND_PORT

# Health check
curl http://localhost:8010/api/health

# Coffre : état, migration des secrets locaux, rotation de clé
docker compose exec backend python -m app.cli secrets-status
docker compose exec backend python -m app.cli secrets-migrate
docker compose exec backend python -m app.cli secrets-rotate-key

# Tests backend
docker compose exec -T backend python -m pytest -q
```
