# srv_gest

Application web de gestion centralisee de serveurs Windows et Linux.

## Fonctionnalites

- **Inventaire serveurs** : gestion de serveurs Linux et Windows avec groupes, credentials chiffres et tags
- **Terminal distant** : terminal interactif SSH via WebSocket + xterm.js (Linux), execution de commandes PowerShell (Windows)
- **Mises a jour** : detection et application des updates (apt/dnf/yum pour Linux, Windows Update pour Windows)
- **Monitoring** : collecte temps reel CPU, RAM, disque, reseau, uptime avec historique et sparklines
- **Dashboard** : vue d'ensemble avec metriques, alertes configurables sur seuils
- **Audit** : toutes les actions sont loguees (connexions, commandes, mises a jour)
- **Securite** : authentification Microsoft Entra ID, RBAC (admin/operator/viewer), credentials chiffres AES-256-GCM

## Stack technique

| Couche | Technologie |
|--------|------------|
| Frontend | React + TypeScript + Vite |
| UI | Shadcn/ui + Tailwind CSS |
| Backend | Python + FastAPI |
| Base de donnees | PostgreSQL |
| Cache | Redis |
| SSH | asyncssh |
| WinRM | pywinrm |
| Temps reel | WebSocket + xterm.js |
| Auth | Microsoft Entra ID (MSAL.js + JWKS) |
| Conteneurs | Docker + Docker Compose |
| Deploiement cible | Azure VM |

## Prerequis

- Docker + Docker Compose
- Node.js 20+ (pour le dev frontend)
- Python 3.12+ (pour le dev backend)
- Une App Registration Microsoft Entra ID

## Installation

### 1. Cloner le depot

```bash
git clone https://gitlab.qiminfo.net/jean-francois.reithler/srv_gest.git
cd srv_gest
```

### 2. Configurer l'environnement

```bash
cp .env.example .env
```

Remplir les valeurs dans `.env` :

- `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` : depuis votre App Registration Entra ID
- `VITE_AZURE_TENANT_ID` / `VITE_AZURE_CLIENT_ID` : memes valeurs pour le frontend
- `CREDENTIAL_ENCRYPTION_KEY` : generer avec la commande ci-dessous
- `POSTGRES_PASSWORD` : choisir un mot de passe

```bash
# Generer une cle de chiffrement
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM; import base64; print(base64.b64encode(AESGCM.generate_key(bit_length=256)).decode())"
```

### 3. Configuration Entra ID

Dans le portail Azure, creer une App Registration :

- **Type** : Single Page Application (SPA)
- **Redirect URI** : `http://localhost:5173` (dev) / `https://votre-domaine` (prod)
- **API permissions** : `User.Read` (Microsoft Graph)
- **Expose an API** : ajouter un scope `access_as_user`

### 4. Lancer avec Docker Compose

```bash
docker-compose up -d
```

Services lances :

- Frontend : http://localhost:5173
- Backend API : http://localhost:8000
- API docs (Swagger) : http://localhost:8000/docs
- PostgreSQL : localhost:5432
- Redis : localhost:6379

### 5. Creer les tables en BDD

```bash
docker-compose exec backend alembic revision --autogenerate -m "initial"
docker-compose exec backend alembic upgrade head
```

## Developpement

### Backend seul

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend seul

```bash
cd frontend
npm install
npm run dev
```

Le frontend est configure avec un proxy Vite vers le backend (`/api` et `/ws`).

## Architecture

```
srv_gest/
├── backend/
│   ├── app/
│   │   ├── api/           # Routes FastAPI (auth, servers, commands, updates, monitoring)
│   │   ├── core/          # Config, auth Entra ID, securite (chiffrement AES)
│   │   ├── models/        # Modeles SQLAlchemy (7 tables)
│   │   ├── schemas/       # Schemas Pydantic (validation)
│   │   ├── services/      # Logique metier (SSH, WinRM, updates, monitoring)
│   │   ├── websocket/     # Terminal interactif (session manager)
│   │   └── main.py
│   └── alembic/           # Migrations BDD
├── frontend/
│   ├── src/
│   │   ├── components/    # Layout, Terminal xterm.js, Sparkline SVG, LoginPage
│   │   ├── pages/         # Dashboard, Servers, ServerDetail, Terminal, Updates, Audit
│   │   ├── services/      # Client API, config MSAL.js
│   │   └── App.tsx
├── docs/                  # Architecture + schemas Excalidraw
├── docker-compose.yml
└── .env.example
```

## API Endpoints

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/auth/me` | Profil utilisateur courant |
| GET | `/api/servers/` | Liste des serveurs |
| POST | `/api/servers/` | Creer un serveur |
| POST | `/api/servers/{id}/test-connection` | Tester la connexion SSH/WinRM |
| POST | `/api/servers/{id}/execute` | Executer une commande distante |
| GET | `/api/servers/{id}/info` | Infos systeme du serveur |
| GET | `/api/servers/{id}/updates` | Scanner les mises a jour |
| POST | `/api/servers/{id}/updates/apply` | Appliquer les mises a jour |
| POST | `/api/servers/{id}/metrics` | Collecter les metriques |
| GET | `/api/dashboard/summary` | Resume dashboard avec metriques |
| WS | `/ws/terminal/{server_id}` | Terminal interactif WebSocket |

## Roles (RBAC)

| Role | Voir | Executer | Administrer |
|------|------|----------|-------------|
| viewer | oui | non | non |
| operator | oui | oui | non |
| admin | oui | oui | oui |

## Securite

- Authentification via Microsoft Entra ID (OAuth2/OIDC avec PKCE)
- Tokens valides cote backend via JWKS
- Credentials serveur chiffres en BDD (AES-256-GCM)
- Audit log de toutes les actions
- CORS configure strictement
- Variables sensibles dans `.env` (jamais commite)

## Licence

Projet interne QIMinfo.
