# CLAUDE.md

## Projet

**srv_gest** — Application web de gestion centralisée de serveurs Windows et Linux.

- Dépôt GitLab : `https://gitlab.qiminfo.net/jean-francois.reithler/srv_gest.git`
- Branche principale : `main`
- Chef de projet : Claude (assistant IA)
- Développeur : Jean-François Reithler

## Objectifs

- Gérer un inventaire de serveurs (Windows / Linux)
- Exécuter des commandes à distance (PowerShell / Bash) via terminal web interactif
- Gérer les mises à jour système (Windows Update / apt / yum / dnf)
- Configurer des paramètres serveur à distance
- Superviser l'état des serveurs en temps réel (dashboard)

## Décisions Validées

- **Stack** : React + TypeScript (frontend), FastAPI + Python (backend) — validé
- **BDD** : PostgreSQL — validé
- **Auth** : Microsoft Entra ID (App Registration, OAuth2/OIDC, MSAL.js) — validé
- **Déploiement** : interne QIMinfo initialement, VM Azure en cible finale — validé

## Stack Technique

| Couche       | Technologie                    |
|-------------|--------------------------------|
| Frontend    | React + TypeScript + Vite      |
| UI Kit      | Shadcn/ui + Tailwind CSS       |
| Backend     | Python + FastAPI               |
| BDD         | PostgreSQL                     |
| Cache/Queue | Redis                          |
| SSH         | asyncssh                       |
| WinRM       | pywinrm                        |
| WebSocket   | FastAPI WebSocket              |
| Auth Front  | MSAL.js (@azure/msal-browser)  |
| Auth Back   | python-jose + JWKS (Entra ID)  |
| Container   | Docker + Docker Compose        |
| Cloud       | Azure VM (cible production)    |

## Documentation

- Architecture, schémas et feuille de route : `docs/architecture.md`
- Schémas Excalidraw :
  - `docs/01-architecture-generale.excalidraw`
  - `docs/02-flux-auth-entra.excalidraw`
  - `docs/03-modele-donnees.excalidraw`

## Phase actuelle

**Phase 0 — Cadrage projet** (terminé)

**Phase 1 — Fondations** (terminé)

- Structure projet (backend/frontend/docker-compose)
- Backend FastAPI : modèles SQLAlchemy (6 tables), Alembic, config
- Auth : middleware Entra ID (JWKS validation), sync profil, RBAC (admin/operator/viewer)
- API REST : CRUD serveurs, groups, credentials (chiffrés AES-256-GCM), audit logging
- Frontend React : Vite + TS, MSAL.js (login/logout), routing, layout sidebar
- Pages : Dashboard, Serveurs (liste), Terminal (placeholder), Updates (placeholder), Audit (placeholder)
- Docker Compose : PostgreSQL 16, Redis 7, backend, frontend
- Sécurité : chiffrement credentials, .env.example, .gitignore

**Phase 2 — Connectivité SSH / WinRM** (terminé)

- Service SSH : asyncssh — connexion, test, exécution commandes, infos système Linux
- Service WinRM : pywinrm — connexion NTLM, test, exécution PowerShell, infos système Windows
- Connection Manager : dispatcher auto SSH/WinRM selon os_type, mise à jour statut serveur
- API : POST /servers/{id}/test-connection, POST /servers/{id}/execute, GET /servers/{id}/info
- Frontend : boutons test connexion / infos / exécuter par serveur, modales commande et infos système
- Audit : toutes les commandes exécutées sont loguées

**Phase 3 — Terminal Interactif** (terminé)

- Backend WebSocket : endpoint `/ws/terminal/{server_id}`, auth par token, protocole JSON (auth/input/output/resize)
- Session Manager : gestion des sessions SSH PTY persistantes (create, read, write, resize, close)
- Composant Terminal : xterm.js avec thème Tokyo Night, base64 bidirectionnel, resize dynamique
- Page Terminal multi-onglets : sélecteur de serveur, onglets avec indicateur connexion, fermeture individuelle
- Proxy WebSocket Vite pour dev
- Audit : ouverture/fermeture de session terminal loguées
- Note : terminal interactif SSH (Linux), Windows en mode commande uniquement pour l'instant

**Phase 4 — Gestion des Mises à Jour** (terminé)

- Update service Linux : détection auto apt/dnf/yum, scan packages, classification sévérité, application MAJ
- Update service Windows : scan via COM Windows Update, détection sévérité MSRC, application via PowerShell
- API : GET /servers/{id}/updates (scan), POST /servers/{id}/updates/apply, GET /updates/jobs, GET /updates/compliance
- Schéma UpdateJob en BDD : suivi des jobs (pending/running/completed/failed)
- Frontend complet : cartes résumé (scannés, MAJ dispo, sécurité, conformité), scan individuel/global, liste packages dépliable avec sévérité, application MAJ, historique des jobs
- Audit : scans et applications loguées

**Phase 5 — Monitoring & Dashboard** (terminé)

- Monitoring service : collecte CPU, RAM, disque, réseau, uptime, processus via SSH (Linux) et PowerShell (Windows)
- Modèle ServerMetric en BDD : historique des métriques avec timestamp, nettoyage automatique configurable
- Modèle AlertRule : règles d'alerte sur seuils (CPU > 90%, RAM > 85%, etc.) par serveur ou global
- API : POST /servers/{id}/metrics (collect), GET /metrics/latest, GET /metrics/history, GET /dashboard/summary, CRUD alert rules, cleanup
- Dashboard enrichi : 4 cartes résumé (serveurs, CPU moyen, RAM moyen, alertes), cartes serveur avec barres de progression CPU/RAM/disque, alertes visuelles
- Page détail serveur : métriques temps réel, graphiques sparkline SVG (historique 24h), infos système, réseau, actions rapides
- Composant Sparkline SVG léger (sans dépendance chart)

**Prochaine étape : Phase 6 — Production**

## Conventions

- Langue de communication : français
- Code et commentaires : anglais
- Messages de commit : clairs et concis, en anglais
- Mise à jour de CLAUDE.md à chaque évolution majeure
- Schémas et documentation technique dans `docs/`
- Sécurité : pas de secrets dans le code, credentials chiffrés en BDD
- Variables sensibles dans `.env` (jamais commité)

## Commandes utiles

```bash
# Démarrage complet (PostgreSQL + Redis + backend + frontend)
docker-compose up -d

# Backend seul (dev)
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload

# Frontend seul (dev)
cd frontend && npm install && npm run dev

# Générer une clé de chiffrement (pour .env CREDENTIAL_ENCRYPTION_KEY)
python -c "from app.core.security import generate_encryption_key; print(generate_encryption_key())"

# Créer une migration Alembic
cd backend && alembic revision --autogenerate -m "description"

# Appliquer les migrations
cd backend && alembic upgrade head

# Health check API
curl http://localhost:8000/api/health
```
