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
│   │                        #               sessions, users, ca, admin)
│   ├── models/              # Entités SQLAlchemy (User, Server, ServerGroup, Credential,
│   │                        #                     AuditLog, UpdateJob, ServerMetric,
│   │                        #                     AlertRule, SessionRecording, AppSetting)
│   ├── schemas/             # Pydantic request/response
│   ├── services/            # Business logic (ssh_service, winrm_service,
│   │                        #                 monitoring_service, update_service,
│   │                        #                 ca_service, settings_service,
│   │                        #                 connection_manager)
│   ├── core/                # config, database, auth (JWT/JWKS), security (AES-256-GCM),
│   │                        # middleware (security headers, rate limit, logging),
│   │                        # command_filter (regex blocklist)
│   └── websocket/           # terminal (SSH WebSocket + recorder), rdp (Guacamole),
│                            # session_manager
├── alembic/versions/        # Migrations DB (initial, ephemeral cert, recordings,
│                            # cert auth fields, validity_minutes, app_settings,
│                            # email unique constraint)
├── tests/
└── requirements.txt
```

**Endpoints principaux** :
- `/api/auth/me` — utilisateur courant (JWT)
- `/api/servers` — CRUD serveurs, groupes, credentials
- `/api/servers/{id}/test`, `/execute`, `/system-info` — connectivité
- `/api/servers/{id}/updates/scan|apply` + `/api/servers/updates/jobs` — patch management
- `/api/monitoring/*` — métriques + alertes + dashboard
- `/api/sessions` — historique sessions + recordings + bulk delete
- `/api/users` — admin users
- `/api/ca/public-key`, `/api/ca/setup-instructions` — Mini-CA Ed25519
- `/api/admin/*` — settings globaux, info système
- WebSocket : terminal SSH (xterm.js), RDP (Guacamole)

**Middleware stack (ordre d'exécution)** : SecurityHeaders → RequestLogging → RateLimit (200 req/min) → CORS

**Énumérations clés** : UserRole (admin/operator/viewer), OSType, CredentialType (ssh_password / ssh_key / winrm / ephemeral_cert), ServerStatus, JobStatus

### Frontend (`frontend/`)

```
frontend/
├── src/
│   ├── main.tsx             # Entry Vite + init MSAL
│   ├── App.tsx              # Routing (support dev mode bypass)
│   ├── pages/               # Dashboard, Servers, ServerDetail, TerminalPage,
│   │                        # Sessions, Updates, Audit, Settings
│   ├── components/          # Layout (sidebar), LoginPage, Terminal (xterm.js),
│   │                        # RdpViewer (Guacamole), Sparkline (SVG 24h)
│   ├── services/            # authConfig.ts (MSAL), api.ts (fetch typé + Bearer)
│   └── lib/                 # utils.ts
├── vite.config.ts
└── package.json             # React 18, Vite 6, Shadcn/ui, xterm.js 5.5,
                             # @azure/msal-browser 3.27, @azure/msal-react 2.1,
                             # guacamole-common-js 1.5, react-router-dom 7
```

**Flux auth** : MSAL → Entra ID (OAuth2/OIDC PKCE) → token Bearer dans headers ; pour le terminal, `acquireTokenPopup({ prompt: "login" })` force MFA avant ouverture WebSocket.

### Docker (`docker-compose.yml`)

Services dev : `db` (Postgres 16, 5432), `redis` (7, 6379), `backend` (FastAPI, 8000), `guacd` (Guacamole, 4822), `frontend` (Vite, 5173). Prod : `docker-compose.prod.yml` avec nginx en reverse proxy, pas d'exposition DB/Redis.

### Décisions architecturales clés

1. **Certificats SSH éphémères** : Mini-CA Ed25519 signe à la demande des certs courts (5 min à 24 h) → `cert_validity_minutes` ; aucun secret stocké pour ce type de credential.
2. **Session recording** : événements I/O terminal timestampés, base64-encodés, stockés en JSONB ; replay xterm.js avec contrôle de vitesse.
3. **MFA par session terminal** : popup Entra forcé avant chaque ouverture WebSocket.
4. **Chiffrement credentials** : AES-256-GCM + nonce, clé `CREDENTIAL_ENCRYPTION_KEY` dans `.env`.
5. **Command filter** : blocklist regex (rm -rf, mkfs, dd, fork bomb, shutdown, curl|sh…).
6. **RBAC** : 3 rôles (admin / operator / viewer) vérifiés via claims JWT.
7. **Async** : FastAPI + asyncio + asyncssh + asyncpg pour haute concurrence.
8. **Timeout terminal** : 30 minutes d'inactivité.

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
curl http://localhost:8000/api/ca/public-key

# Health check
curl http://localhost:8000/api/health
```
