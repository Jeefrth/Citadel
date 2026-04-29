# srv_gest — Documentation Projet

> **Schémas visuels Excalidraw** (ouvrir avec excalidraw.com ou extension VS Code) :
>
> - `docs/01-architecture-generale.excalidraw` — Vue d'ensemble 3 tiers
> - `docs/02-flux-auth-entra.excalidraw` — Flux OAuth2/OIDC avec Entra ID
> - `docs/03-modele-donnees.excalidraw` — Tables, relations FK et enums

## 1. Vision du Projet

**srv_gest** est une application web de gestion centralisée de serveurs Windows et Linux.
Elle permet aux administrateurs système de :
- Gérer un inventaire de serveurs (Windows / Linux)
- Exécuter des commandes à distance (PowerShell / Bash)
- Gérer les mises à jour système (Windows Update / apt / yum / dnf)
- Configurer des paramètres serveur à distance
- Superviser l'état des serveurs en temps réel

---

## 2. Architecture Générale

```
┌─────────────────────────────────────────────────────────────┐
│                       UTILISATEUR                           │
│                     (Navigateur Web)                        │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌──────────────────┐   ┌──────────────────────────────────────┐
│  Microsoft Entra │◀──│              FRONTEND                │
│  ID (Azure AD)   │──▶│        (React + TypeScript)          │
│                  │   │                                      │
│  - OAuth2 / OIDC │   │  ┌───────────┐ ┌──────────────────┐ │
│  - MSAL.js       │   │  │ Dashboard │ │ Terminal Distant │ │
│  - App Registration  │  └───────────┘ └──────────────────┘ │
└──────────────────┘   │  ┌───────────┐ ┌──────────────────┐ │
                       │  │ Inventaire│ │ Updates Manager  │ │
                       │  └───────────┘ └──────────────────┘ │
                       │  ┌───────────┐ ┌──────────────────┐ │
                       │  │ Paramètres│ │   Audit Logs     │ │
                       │  └───────────┘ └──────────────────┘ │
                       └────────────────────┬─────────────────┘
                                            │ REST API + WebSocket
                                            │ (Bearer Token Entra)
                                            ▼
┌─────────────────────────────────────────────────────────────┐
│                        BACKEND                              │
│                (Python — FastAPI)                            │
│                                                             │
│  ┌───────────┐ ┌───────────┐ ┌────────────────────────┐   │
│  │ API REST  │ │ WebSocket │ │ Auth Middleware         │   │
│  │ Endpoints │ │  Server   │ │ (validation token      │   │
│  └───────────┘ └───────────┘ │  Entra ID / JWKS)      │   │
│  ┌───────────┐ ┌───────────┐ └────────────────────────┘   │
│  │ Task      │ │ Connexion │ ┌────────────────────────┐   │
│  │ Queue     │ │  Manager  │ │  Audit Logger          │   │
│  └───────────┘ └───────────┘ └────────────────────────┘   │
└──────────┬───────────┬───────────┬──────────────────────────┘
           │           │           │
           ▼           ▼           ▼
┌──────────────┐ ┌───────────┐ ┌──────────────────────────────┐
│  PostgreSQL  │ │   Redis   │ │    SERVEURS DISTANTS         │
│              │ │ (cache +  │ │                              │
│ - Serveurs   │ │  sessions │ │  ┌──────────┐ ┌──────────┐  │
│ - Users sync │ │  + queue) │ │  │  Linux   │ │ Windows  │  │
│ - Audit log  │ │           │ │  │  (SSH)   │ │ (WinRM)  │  │
│ - Jobs       │ │           │ │  └──────────┘ └──────────┘  │
│ - Credentials│ │           │ │                              │
└──────────────┘ └───────────┘ └──────────────────────────────┘

Déploiement cible :
  - Phase initiale : serveur interne QIMinfo (Docker Compose)
  - Phase finale   : VM Azure (avec proximity Entra ID)
```

---

## 3. Stack Technique Proposée

| Couche       | Technologie             | Justification                                      |
|-------------|-------------------------|---------------------------------------------------|
| Frontend    | React + TypeScript      | Écosystème riche, composants UI (xterm.js terminal)|
| UI Kit      | Shadcn/ui + Tailwind    | Design moderne, accessible, personnalisable        |
| Backend     | Python + FastAPI        | Async natif, performant, typage fort               |
| BDD         | PostgreSQL              | Robuste, adapté aux données relationnelles         |
| Cache/Queue | Redis                   | Sessions, cache, file de tâches                    |
| SSH Client  | Paramiko / asyncssh     | Connexion SSH vers serveurs Linux                  |
| WinRM       | pywinrm                 | Exécution PowerShell à distance sur Windows        |
| WebSocket   | FastAPI WebSocket       | Terminal interactif temps réel                     |
| Auth Front  | MSAL.js (@azure/msal-browser) | Authentification via Microsoft Entra ID       |
| Auth Back   | python-jose + JWKS      | Validation des tokens Entra ID côté API            |
| Container   | Docker + Docker Compose | Déploiement simplifié                              |
| Cloud       | Azure VM                | Hébergement cible en production                    |

---

## 4. Modules Fonctionnels

### 4.1 Inventaire Serveurs
- Ajout / modification / suppression de serveurs
- Informations : nom, IP, OS, type (Win/Linux), port SSH/WinRM, tags
- Groupes de serveurs (par environnement, rôle, localisation)
- Test de connectivité (ping + connexion SSH/WinRM)
- Import/export CSV

### 4.2 Terminal Distant
- Terminal interactif via WebSocket (xterm.js)
- Exécution de commandes SSH (Linux) ou PowerShell (Windows)
- Historique des commandes exécutées
- Multi-onglets (plusieurs serveurs simultanément)
- Coloration syntaxique de la sortie

### 4.3 Gestion des Mises à Jour
- **Linux** : détection des paquets à mettre à jour (apt/yum/dnf)
- **Windows** : interrogation Windows Update via PowerShell
- Planification de mises à jour
- Application de mises à jour avec suivi du statut
- Rapport de conformité des mises à jour

### 4.4 Paramètres Serveur
- Consultation des paramètres système (hostname, réseau, services, etc.)
- Modification de paramètres à distance
- Gestion des services (start/stop/restart/status)
- Gestion du pare-feu (règles iptables / Windows Firewall)

### 4.5 Monitoring (Dashboard)
- Tableau de bord avec état de tous les serveurs
- Métriques temps réel : CPU, RAM, disque, réseau
- Alertes sur seuils dépassés
- Graphiques d'historique (dernières 24h / 7j / 30j)

### 4.6 Gestion des Utilisateurs & Sécurité
- Authentification via Microsoft Entra ID (OAuth2 / OIDC)
- Synchronisation des profils Entra → BDD locale au premier login
- Rôles : Admin / Opérateur / Lecteur (RBAC, mappés depuis groupes Entra ou assignés manuellement)
- Audit log de toutes les actions
- Chiffrement des credentials serveur (AES-256)
- Timeout de session (géré par Entra + expiration token)

---

## 5. Flux d'Authentification — Microsoft Entra ID

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│          │     │          │     │ Microsoft│     │          │
│  User    │────▶│ Frontend │────▶│ Entra ID │     │ Backend  │
│          │     │ (MSAL.js)│     │ (login)  │     │ (FastAPI)│
│          │     │          │◀────│          │     │          │
│          │     │          │     └──────────┘     │          │
│          │     │          │                      │          │
│          │     │          │──── Bearer Token ───▶│          │
│          │     │          │◀─── API Response ────│          │
└──────────┘     └──────────┘                      └──────────┘

Détail du flux :
1. L'utilisateur clique "Se connecter" dans l'app
2. MSAL.js redirige vers la page de login Microsoft Entra ID
3. L'utilisateur s'authentifie (MFA si configuré dans Entra)
4. Entra ID renvoie un authorization code au frontend
5. MSAL.js échange le code contre un access token + id token (PKCE)
6. Le frontend stocke le token et l'envoie dans chaque requête API
   (Header: Authorization: Bearer <access_token>)
7. Le backend valide le token via les clés publiques JWKS de Entra
8. Si premier login : création du profil utilisateur en BDD locale
9. L'utilisateur accède à l'application avec son rôle assigné
```

### Configuration Entra ID requise

- **App Registration** dans le portail Azure
  - Type : Single Page Application (SPA)
  - Redirect URI : `https://<app-domain>/auth/callback`
  - API permissions : `User.Read` (Microsoft Graph)
  - Token configuration : groups claim (optionnel, pour mapper les rôles)
- **Variables d'environnement backend** :
  - `AZURE_TENANT_ID` : ID du tenant Entra
  - `AZURE_CLIENT_ID` : ID de l'App Registration
  - `AZURE_AUTHORITY` : `https://login.microsoftonline.com/<tenant_id>`

---

## 7. Flux de Données — Exécution de Commande

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│          │     │          │     │          │     │          │
│  User    │────▶│ Frontend │────▶│ Backend  │────▶│ Serveur  │
│          │     │ (React)  │     │ (FastAPI)│     │ Distant  │
│          │     │          │     │          │     │          │
│          │◀────│          │◀────│          │◀────│          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
   Affiche         WebSocket       SSH/WinRM        Exécute
   résultat        (stream)        (stream)         commande

Détail du flux :
1. L'utilisateur saisit une commande dans le terminal web
2. Le frontend envoie la commande via WebSocket au backend
3. Le backend vérifie le token Entra + les permissions RBAC
4. Le backend ouvre/réutilise une connexion SSH ou WinRM
5. La commande est exécutée sur le serveur distant
6. La sortie (stdout/stderr) est streamée en retour
7. Le backend relaye via WebSocket au frontend
8. Le terminal affiche le résultat en temps réel
9. La commande est enregistrée dans l'audit log
```

---

## 6. Modèle de Données

```
┌──────────────────┐      ┌─────────────────┐
│      users       │      │    servers       │
├──────────────────┤      ├─────────────────┤
│ id (PK, UUID)    │      │ id (PK, UUID)   │
│ entra_object_id  │      │ name            │
│ email            │      │ hostname        │
│ display_name     │      │ ip_address      │
│ role (enum)      │      │ os_type (enum)  │
│ is_active        │      │ os_version      │
│ created_at       │      │ ssh_port        │
│ last_login       │      │ winrm_port      │
└────────┬─────────┘      │ credential_id   │──┐
         │                │ group_id (FK)   │  │
         │                │ status          │  │
         │                │ last_seen       │  │
         │                │ tags (JSONB)    │  │
         │                │ created_at      │  │
         │                └─────────────────┘  │
         │                                     │
         ▼                                     ▼
┌──────────────────┐      ┌─────────────────┐
│   audit_logs     │      │  credentials    │
├──────────────────┤      ├─────────────────┤
│ id (PK, UUID)    │      │ id (PK, UUID)   │
│ user_id (FK)     │      │ name            │
│ server_id (FK)   │      │ type (ssh/winrm)│
│ action           │      │ username        │
│ command          │      │ encrypted_pwd   │
│ result           │      │ ssh_key_enc     │
│ status           │      │ created_at      │
│ ip_address       │      └─────────────────┘
│ timestamp        │
└──────────────────┘      ┌─────────────────┐
                          │  server_groups   │
┌──────────────────┐      ├─────────────────┤
│   update_jobs    │      │ id (PK, UUID)   │
├──────────────────┤      │ name            │
│ id (PK, UUID)    │      │ description     │
│ server_id (FK)   │      │ created_at      │
│ user_id (FK)     │      └─────────────────┘
│ type             │
│ packages (JSONB) │
│ status           │
│ scheduled_at     │
│ started_at       │
│ completed_at     │
│ output (TEXT)    │
└──────────────────┘

Enums :
  - role       : admin | operator | viewer
  - os_type    : linux | windows
  - cred_type  : ssh_password | ssh_key | winrm
  - job_status : pending | running | completed | failed | cancelled

Note : pas de password_hash — l'authentification est déléguée
à Microsoft Entra ID. La table users stocke le profil synchronisé
au premier login via le champ entra_object_id (unique).
```

---

## 7. Sécurité

- **Transport** : HTTPS obligatoire (TLS 1.3)
- **Authentification** : Microsoft Entra ID (OAuth2 / OIDC), tokens validés via JWKS
- **Autorisation** : RBAC (Admin / Opérateur / Lecteur), rôles en BDD locale
- **Credentials serveur** : chiffrés en BDD (AES-256-GCM), jamais en clair
- **Audit** : toutes les actions loguées avec user, timestamp, IP source
- **Input** : validation stricte de toutes les entrées (Pydantic)
- **Rate limiting** : protection contre le brute force
- **CORS** : configuré strictement (domaine de l'app uniquement)
- **CSP** : Content Security Policy en place
- **Secrets** : variables d'environnement, jamais dans le code (tenant_id, client_id, clé AES)

---

## 8. Feuille de Route (Phases)

### Phase 1 — Fondations (Sprint 1-2)

- [ ] Setup projet (structure, Docker Compose, .env)
- [ ] Backend : modèles BDD (SQLAlchemy), migrations (Alembic)
- [ ] Backend : middleware auth Entra ID (validation token JWKS)
- [ ] Frontend : scaffold React + Vite, routing, layout Shadcn/ui
- [ ] Frontend : intégration MSAL.js (login / logout / token)
- [ ] API : CRUD serveurs + gestion credentials (chiffrés)
- [ ] Synchronisation profil Entra → table users au premier login

### Phase 2 — Connectivité (Sprint 3-4)
- [ ] Connexion SSH (Linux) via asyncssh
- [ ] Connexion WinRM (Windows) via pywinrm
- [ ] Test de connectivité depuis l'UI
- [ ] Exécution de commandes simples

### Phase 3 — Terminal Interactif (Sprint 5-6)
- [ ] WebSocket backend
- [ ] Intégration xterm.js frontend
- [ ] Streaming temps réel de la sortie
- [ ] Multi-onglets terminal

### Phase 4 — Gestion des Mises à Jour (Sprint 7-8)
- [ ] Détection des updates Linux (apt/yum/dnf)
- [ ] Détection des updates Windows (PowerShell)
- [ ] Application des mises à jour
- [ ] Planification et rapports

### Phase 5 — Monitoring & Dashboard (Sprint 9-10)
- [ ] Collecte métriques (CPU, RAM, disque)
- [ ] Dashboard temps réel
- [ ] Alertes et notifications
- [ ] Graphiques historiques

### Phase 6 — Production (Sprint 11-12)
- [ ] Tests E2E complets
- [ ] Documentation utilisateur
- [ ] Hardening sécurité
- [ ] Déploiement production

---

## 9. Arborescence Projet (Cible)

```
srv_gest/
├── backend/
│   ├── app/
│   │   ├── api/              # Routes FastAPI
│   │   │   ├── auth.py
│   │   │   ├── servers.py
│   │   │   ├── commands.py
│   │   │   ├── updates.py
│   │   │   └── users.py
│   │   ├── core/             # Configuration, sécurité
│   │   │   ├── config.py
│   │   │   ├── security.py
│   │   │   └── database.py
│   │   ├── models/           # Modèles SQLAlchemy
│   │   ├── schemas/          # Schémas Pydantic
│   │   ├── services/         # Logique métier
│   │   │   ├── ssh_service.py
│   │   │   ├── winrm_service.py
│   │   │   ├── update_service.py
│   │   │   └── monitoring_service.py
│   │   ├── websocket/        # Gestionnaire WebSocket
│   │   └── main.py
│   ├── alembic/              # Migrations BDD
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── services/
│   │   └── App.tsx
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
├── docs/
│   └── architecture.md
├── CLAUDE.md
└── README.md
```
