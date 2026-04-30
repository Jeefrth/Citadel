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
