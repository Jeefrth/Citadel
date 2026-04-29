# srv_gest

Application web de gestion centralisee de serveurs Windows et Linux avec bastion SSH securise.

## Fonctionnalites

### Gestion de serveurs

- **Inventaire** : serveurs Linux et Windows avec groupes, tags, credentials
- **Terminal distant** : terminal interactif SSH via WebSocket + xterm.js avec multi-onglets
- **Execution de commandes** : SSH (Linux) et PowerShell (Windows) avec filtrage de securite
- **Mises a jour** : detection et application (apt/dnf/yum + Windows Update)
- **Monitoring** : metriques temps reel CPU, RAM, disque, reseau avec historique et sparklines
- **Dashboard** : vue d'ensemble avec alertes configurables sur seuils

### Bastion securise

- **Mini-CA** : autorite de certification integree (Ed25519) pour certificats SSH ephemeres
- **Certificats ephemeres** : duree configurable de 5 minutes a 24 heures, aucun mot de passe stocke
- **Session recording** : enregistrement complet de toutes les sessions terminal avec replay
- **MFA par session** : re-authentification Microsoft obligatoire avant chaque ouverture de terminal
- **Command filtering** : blocklist de commandes dangereuses (rm -rf, mkfs, dd, fork bomb, etc.)
- **Timeout d'inactivite** : deconnexion automatique apres 30 minutes sans frappe

### Securite

- **Authentification** : Microsoft Entra ID (OAuth2/OIDC avec PKCE)
- **RBAC** : 3 roles (admin, operator, viewer) — premier utilisateur auto-promu admin
- **Chiffrement** : credentials serveur chiffres AES-256-GCM en BDD
- **Audit** : toutes les actions loguees (connexions, commandes, mises a jour, sessions)
- **Rate limiting** : 200 requetes/min par IP
- **Security headers** : CSP, X-Frame-Options, X-Content-Type-Options

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Frontend | React 18 + TypeScript + Vite |
| UI | Shadcn/ui + Tailwind CSS |
| Terminal | xterm.js + WebSocket |
| Backend | Python 3.12+ + FastAPI |
| Base de donnees | PostgreSQL 16 |
| Cache | Redis 7 |
| SSH | asyncssh + ssh-keygen (certificats) |
| WinRM | pywinrm (NTLM) |
| Auth | Microsoft Entra ID (MSAL.js + JWKS) |
| CA | Ed25519 via ssh-keygen |
| Conteneurs | Docker + Docker Compose |
| Deploiement | Azure VM (cible production) |

## Prerequis

- Docker + Docker Compose
- Node.js 20+
- Python 3.12+
- ssh-keygen (inclus avec OpenSSH)
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

| Variable | Description |
|----------|-------------|
| `AZURE_TENANT_ID` | Tenant ID depuis le portail Azure |
| `AZURE_CLIENT_ID` | Client ID de l'App Registration |
| `VITE_AZURE_TENANT_ID` | Meme valeur (pour le frontend) |
| `VITE_AZURE_CLIENT_ID` | Meme valeur (pour le frontend) |
| `CREDENTIAL_ENCRYPTION_KEY` | Generer avec la commande ci-dessous |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL |

```bash
# Generer une cle de chiffrement AES-256
python3 -c "from cryptography.hazmat.primitives.ciphers.aead import AESGCM; import base64; print(base64.b64encode(AESGCM.generate_key(bit_length=256)).decode())"
```

### 3. Configuration Entra ID

Dans le portail Azure, configurer l'App Registration :

**Authentication :**

- Type : Single Page Application (SPA)
- Redirect URI : `http://localhost:5173` (dev) / `https://votre-domaine` (prod)
- Cocher : Access tokens, ID tokens

**Expose an API :**

- Application ID URI : `api://<client-id>`
- Scope : `access_as_user`

**API permissions :**

- Microsoft Graph : `User.Read`

**Conditional Access (recommande) :**

- Creer une policy ciblant l'App Registration
- Grant : Require MFA
- Session : Sign-in frequency = Every time (pour MFA par terminal)

### 4. Lancer les services

**Option A : tout en Docker (sans acces reseau LAN)**

```bash
docker-compose up -d
```

**Option B : backend local (acces reseau LAN pour SSH)**

```bash
# BDD + Redis en Docker
docker-compose up -d db redis

# Backend local (Python 3.12+)
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp ../.env .env
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend local
cd frontend
npm install
npm run dev
```

### 5. Creer les tables

```bash
# En Docker
docker-compose exec backend alembic upgrade head

# Ou en local
cd backend && .venv/bin/python -m alembic upgrade head
```

### 6. Configurer un serveur pour les certificats ephemeres

```bash
# Recuperer la cle publique CA
curl http://localhost:8000/api/ca/public-key

# Sur le serveur cible (en root) :
echo '<cle_publique_ca>' | sudo tee /etc/ssh/srv_gest_ca.pub
echo 'TrustedUserCAKeys /etc/ssh/srv_gest_ca.pub' | sudo tee -a /etc/ssh/sshd_config
sudo systemctl restart sshd
```

## URLs

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger | http://localhost:8000/api/docs |
| ReDoc | http://localhost:8000/api/redoc |

## Architecture

```
srv_gest/
├── backend/
│   ├── app/
│   │   ├── api/           # Routes : auth, servers, commands, updates, monitoring, sessions, ca
│   │   ├── core/          # Config, auth Entra ID, securite AES, middleware, command filter
│   │   ├── models/        # SQLAlchemy : users, servers, credentials, audit, metrics, sessions, alerts
│   │   ├── schemas/       # Pydantic : validation request/response
│   │   ├── services/      # SSH, WinRM, updates, monitoring, Mini-CA
│   │   ├── websocket/     # Terminal interactif + session manager + recording
│   │   └── main.py
│   └── alembic/           # Migrations BDD
├── frontend/
│   ├── src/
│   │   ├── components/    # Layout, Terminal xterm.js, Sparkline SVG, LoginPage
│   │   ├── pages/         # Dashboard, Servers, ServerDetail, Terminal, Sessions, Updates, Audit
│   │   ├── services/      # Client API avec Bearer token, config MSAL.js
│   │   └── App.tsx
├── data/
│   └── ca/                # Cle CA (persitante, exclue du git)
├── docs/                  # Architecture + schemas Excalidraw
├── docker-compose.yml     # Dev (hot-reload)
├── docker-compose.prod.yml # Production (nginx + multi-stage)
└── .env.example
```

## API Endpoints

### Authentification

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/auth/me` | Profil utilisateur courant |

### Serveurs

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/servers/` | Liste des serveurs |
| POST | `/api/servers/` | Creer un serveur |
| PATCH | `/api/servers/{id}` | Modifier un serveur |
| DELETE | `/api/servers/{id}` | Supprimer un serveur |
| POST | `/api/servers/{id}/test-connection` | Tester la connexion SSH/WinRM |
| POST | `/api/servers/{id}/execute` | Executer une commande (avec filtrage) |
| GET | `/api/servers/{id}/info` | Infos systeme du serveur |

### Credentials

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/servers/credentials/` | Liste des credentials |
| POST | `/api/servers/credentials/` | Creer (ssh_password, ssh_key, winrm, ephemeral_cert) |
| PATCH | `/api/servers/credentials/{id}` | Modifier |
| DELETE | `/api/servers/credentials/{id}` | Supprimer |

### Mises a jour

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/servers/{id}/updates` | Scanner les MAJ disponibles |
| POST | `/api/servers/{id}/updates/apply` | Appliquer les MAJ |
| GET | `/api/servers/updates/jobs` | Historique des jobs |

### Monitoring

| Methode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/servers/{id}/metrics` | Collecter les metriques |
| GET | `/api/servers/{id}/metrics/latest` | Dernieres metriques |
| GET | `/api/servers/{id}/metrics/history` | Historique (param: hours) |
| GET | `/api/dashboard/summary` | Resume complet dashboard |

### Sessions (bastion)

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/sessions/` | Liste des enregistrements |
| GET | `/api/sessions/{id}` | Detail + events pour replay |
| DELETE | `/api/sessions/{id}` | Supprimer un enregistrement |

### Certificats (CA)

| Methode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/ca/public-key` | Cle publique CA |
| GET | `/api/ca/setup-instructions` | Guide setup serveur (param: hostname) |

### Terminal

| Methode | Endpoint | Description |
|---------|----------|-------------|
| WS | `/ws/terminal/{server_id}` | Terminal interactif WebSocket |

## Roles (RBAC)

| Role | Voir serveurs | Executer commandes | Terminal | Gerer users/credentials | Supprimer |
|------|--------------|-------------------|----------|------------------------|-----------|
| viewer | oui | non | non | non | non |
| operator | oui | oui | oui | non | non |
| admin | oui | oui | oui | oui | oui |

Le premier utilisateur qui se connecte via Entra ID est automatiquement admin.

## Securite en detail

### Authentification

- OAuth2/OIDC avec PKCE (SPA flow) via Microsoft Entra ID
- Tokens valides cote backend via JWKS (cles publiques Microsoft)
- Support audiences `api://<client_id>` et `<client_id>` brut
- Compatibility issuer v1 et v2

### Bastion SSH

- **Mini-CA Ed25519** : cle CA persistante dans `data/ca/`, jamais commitee
- **Certificats ephemeres** : generes a chaque connexion via `ssh-keygen`, duree 5min a 24h
- **Zero credentials stockes** : avec le type `ephemeral_cert`, aucun mot de passe en BDD
- **MFA par session** : popup Microsoft avec `prompt: "login"` avant chaque terminal
- **Session recording** : tous les I/O enregistres en JSONB avec timestamps pour replay
- **Timeout** : 30 minutes d'inactivite = deconnexion automatique

### Protection des commandes

- **Command filter** : blocklist regex sur `/execute` (rm -rf, mkfs, dd, fork bomb, shutdown, curl|sh)
- **Rate limiting** : 200 req/min par IP via middleware
- **Security headers** : CSP, X-Frame-Options DENY, X-Content-Type-Options nosniff

### Donnees

- Credentials serveur chiffres AES-256-GCM (nonce aleatoire par valeur)
- Variables sensibles dans `.env` (exclu du git)
- CA private key dans `data/ca/` (exclu du git)

## Licence

Projet interne QIMinfo.
