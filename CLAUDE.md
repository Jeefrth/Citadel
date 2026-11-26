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
| Auth | OIDC multi-fournisseurs (Entra, Google, Okta, OIDC générique) + sessions Citadel |
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
- Kubernetes : `docs/kubernetes.md`
- Multi-organisation (SaaS phase 1) : `docs/saas-phase1.md`
- Règles par organisation et console plateforme (SaaS phase 2) : `docs/saas-phase2.md`
- Connexion multi-fournisseurs (SaaS phase 3) : `docs/saas-phase3.md`
- Plan de test manuel (recette) : `docs/plan-de-test.md`, laboratoire `scripts/test-lab.sh up|users|status|down`
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
- **SaaS phase 2** (11/2026) : réglages d'organisation réellement appliqués (liste d'adresses, limite de requêtes, inactivité, durées de certificat, enregistrement), numéros de demande par organisation, console plateforme. Voir `docs/saas-phase2.md`
- **SaaS phase 3** (11/2026) : connexion OIDC multi-fournisseurs (boutons plateforme + SSO par organisation avec domaines, arrivée automatique, SSO imposé), sessions Citadel (jeton 10 min + cookie de renouvellement tournant), ré-authentification avant terminal, MSAL retiré. Voir `docs/saas-phase3.md`
- **SaaS phase 1** (11/2026) : organisations (isolation ORM + RLS Postgres, rôle par appartenance, super-admin plateforme, invitations avec consentement, clé Transit et CA SSH par organisation, proxy SSH multi-org, suppression d'organisation). Voir `docs/saas-phase1.md`
- **Lot 8** (11/2026) : Kubernetes (clusters, règles par espace de noms, logs, actions, shell dans un conteneur sur le cœur de session commun). Voir `docs/kubernetes.md`
- **Lot 7** (11/2026) : proxy SSH, masquage, push de comptes, sauvegarde chiffrée, API applications, risques, rôles personnalisés. Voir `docs/operations.md`, `docs/vault.md`, `docs/governance.md`, `docs/audit.md`
- **Lot 6** (11/2026) : journal des connexions et appareils, rapports, rappel d'expiration et import/export des règles, revue des VM cloud, téléchargement groupé des enregistrements
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
│   ├── main.tsx             # Entry Vite
│   ├── App.tsx              # Routing (support dev mode bypass)
│   ├── pages/               # Dashboard, Servers, ServerDetail, TerminalPage, Sessions,
│   │                        # Updates, Audit, Settings (coffre, notifications), Access
│   │                        # (règles, groupes, accès effectifs, comptes découverts, ACL),
│   │                        # Approvals (validations 4 yeux, demandes d'accès), MyAccount
│   ├── components/          # Layout (sidebar + NotificationBell), LoginPage, Terminal,
│   │                        # RdpViewer, NodeTree, ConnectDialog, AccountsSection,
│   │                        # DiscoveredAccounts, SecretsVaultCard, AclRules,
│   │                        # NotificationChannels, ui.tsx (briques communes)
│   ├── services/            # session.ts (jeton Citadel, renouvellement, ré-authentification), api.ts (fetch typé + Bearer)
│   └── lib/                 # utils.ts
├── vite.config.ts
└── package.json             # React 18, Vite 6, Shadcn/ui, xterm.js 5.5,
                             # @azure/msal-browser 3.27, @azure/msal-react 2.1,
                             # guacamole-common-js 1.5, react-router-dom 7
```

**Flux auth** : `/api/auth/login/{fournisseur}` → fournisseur OIDC (code + PKCE côté serveur, `services/oidc.py`) → `/api/auth/callback` pose le cookie de renouvellement → le front (`services/session.ts`) obtient un jeton Citadel de 10 min par `POST /api/auth/refresh` (en-tête `X-Citadel-Refresh: 1`, rotation du cookie). Avant un terminal : fenêtre de ré-authentification (`/api/auth/reauth`, `prompt=login`), le serveur exige un `auth_time` de moins de 5 min (`require_recent_auth`).

### Docker (`docker-compose.yml`)

Services dev : `guacd` (1.6.0, non publié, enregistre dans `data/recordings/raw`), `openbao` (2.7.2, UI sur 127.0.0.1:8200), `vault-bootstrap` (job idempotent : init, unseal, transit, CA SSH, AppRole ; fichiers dans `data/openbao/`), `db` (Postgres 16, 5432), `redis` (7, 6379), `backend` (FastAPI, port hôte `BACKEND_PORT`, 8000 par défaut ; 8010 sur le Mac de JF car 8000 est pris par un serveur LLM local), `guacd` (Guacamole, 4822), `frontend` (Vite, 5173, proxy vers `backend:8000`). Clé de la CA montée depuis `./data/ca`. Prod : `docker-compose.prod.yml` avec nginx en reverse proxy, pas d'exposition DB/Redis.

### Décisions architecturales clés

1. **Certificats SSH éphémères** : Mini-CA Ed25519 signe à la demande des certs courts (5 min à 24 h) → `cert_validity_minutes` ; aucun secret stocké pour ce type de credential.
2. **Session recording** : événements I/O terminal timestampés, base64-encodés, stockés en JSONB ; replay xterm.js avec contrôle de vitesse.
3. **MFA par session terminal** : ré-authentification chez le fournisseur (fenêtre) avant chaque ouverture de terminal, contrôlée côté serveur par l'`auth_time` de la session.
4. **Chiffrement credentials** : `SECRETS_BACKEND=vault` → OpenBao Transit (`vault:vN:…` en base, clé jamais hors du coffre) ; `local` → AES-256-GCM avec `CREDENTIAL_ENCRYPTION_KEY`. `decrypt_value` lit les deux formats. CA SSH dans le coffre si `CA_BACKEND=vault`.
5. **Command filter** : blocklist regex (rm -rf, mkfs, dd, fork bomb, shutdown, curl|sh…).
6. **RBAC + règles d'accès** : 3 rôles (admin / operator / viewer). L'admin voit tout ; les autres ne voient que les serveurs accordés par une `AccessPolicy` (utilisateurs ou groupes × serveurs, nœuds avec sous-nœuds ou étiquettes × comptes × actions, fenêtre de validité). Le rôle sert de plafond (viewer : jamais `execute`). Un serveur invisible renvoie 404.
7. **Async** : FastAPI + asyncio + asyncssh + asyncpg pour haute concurrence.
8. **Timeout terminal** : réglage `idle_timeout_minutes` de l'organisation (30 min par défaut).
9. **Comptes** : un serveur a N comptes (`Account`) dont un « par défaut » utilisé par l'automatisation (monitoring, mises à jour, commandes). Secret = `Credential` référencé ou certificat éphémère. Comptes virtuels dans les règles : `@ALL`, `@USER` (partie locale de l'UPN + certificat), `@INPUT` (saisi à la connexion, jamais stocké).
10. **RDP par ticket** : `POST /connect-ticket` contrôle les droits et résout le compte, puis le WebSocket n'accepte qu'un ticket Redis à usage unique (60 s). Aucun jeton ni mot de passe dans les URL (uvicorn journalise les query strings).
11. **Clés API** : `ctk_<prefix>_<secret>`, seul le SHA-256 est stocké, héritent des droits de l'utilisateur, ne peuvent pas créer d'autres clés.
12. **Gouvernance** : point de contrôle unique `services/enforcement.py` (terminal, ticket RDP, execute, tâches, mises à jour). **Tout nouveau chemin qui exécute quelque chose sur un serveur doit appeler `enforce_connect` + `check_command` avec l'IP client, et `log_command`** (les mises à jour l'oubliaient : commande canonique `system-update ...`). Les tâches stockent `client_ip` à la création. Règles ordonnées par priorité, première correspondance gagnante, aucune = autorisé. 4 yeux strict (jamais sa propre demande). IP client via `core/governance.client_ip` (X-Forwarded-For seulement depuis `TRUSTED_PROXIES`).
13. **Audit** : enregistrements stockés hors base (gzip + SHA-256 vérifié à la relecture, `services/recording_storage.py`), registre des sessions en direct dans Redis (`services/live.py`, pub/sub sortie + contrôle), SIEM par curseur persistant (`services/siem.py`).
15. **Cœur de session** : `services/terminal_core.py` porte tout terminal interactif (web, proxy SSH, shell Kubernetes) via un `TargetChannel` (read/write/resize/close). Une cible qui n'est pas un serveur (`is_k8s`) n'a pas de server_id en audit et ses règles « validation » refusent.
17. **Organisations** : toute donnée client porte `org_id` (`core/tenancy.TenantMixin`). Le contexte (`tenant(org)` / `system()`) est posé par `core/auth.bind_user` (en-tête `X-Citadel-Org`, champ `org` des WebSockets, ticket RDP, org de la clé d'accès / application) ; sans contexte, une requête sur une table client échoue (fail closed), et la RLS Postgres (`citadel_rls`) refuse les lignes d'une autre org. Les utilisateurs sont globaux : **toute liste ou résolution d'utilisateurs passe par `services/members.py`**, les droits d'une autre personne par `load_member`. Un nouveau code en tâche de fond doit entrer dans l'org (`with tenant(org)`), et `apply_to_session(db)` si la transaction est déjà ouverte. Paramètres via `settings_service.scope()` (plateforme = org_id NULL, écriture seulement en `system()`).
16. **Permissions** : `core/auth.CAPABILITIES` + `require_perm(cap)` / `has_perm(user, cap)` (rôles personnalisés). Les fonctions qui pourraient élargir des droits ou exporter tous les secrets restent `require_role(ADMIN)`.
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
