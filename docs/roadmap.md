# Roadmap Citadel

## Phases livrées

- **Phase 0–6** : cadrage, fondations, connectivité SSH/WinRM, terminal interactif, mises à jour, monitoring, hardening production.
- **Sprint A** : session recording (replay xterm.js).
- **Sprint B** : Mini-CA Ed25519, certificats SSH éphémères.
- **Sprint C** : MFA par session, command filter, timeout 30 min, CA persistante.
- **Sprint PAM-1** (11/2026) : règles d'accès, comptes par serveur, comptes virtuels, arborescence de nœuds, étiquettes, favoris, clés API, tickets RDP.
- **Sprint PAM-3** (11/2026) : ACL de connexion (login / connect, IP, horaires) et de commandes (API + terminal interactif), validation à 4 yeux, demandes d'accès temporaires, notifications (cloche, e-mail, Teams, webhook).
- **Sprint PAM-2** (11/2026) : coffre OpenBao (Transit + CA SSH + AppRole), migration et rotation de clé, rotation des mots de passe, vérification et collecte des comptes, planificateur. Correctifs : émetteurs Entra explicites, CORS restreint.

## Fonctionnalités inspirées de JumpServer

Analyse du 24/11/2026 de `jumpserver/jumpserver` (v5.2.1). JumpServer est sous **GPLv3** et Citadel sous MIT : on reprend des idées de fonctionnalités, jamais du code.

| Lot | Contenu | Statut |
|-----|---------|--------|
| 1. Socle PAM | C1 règles d'accès, B1 comptes par actif, B9 comptes virtuels, A1 nœuds, A2 étiquettes, A5 favoris, F4 clés API | ✅ Sprint PAM-1 |
| 2. Secrets | B10 coffre OpenBao (= D1), B3 rotation automatique, B5 collecte des comptes, B6 vérification des comptes | ✅ Sprint PAM-2 (voir `docs/vault.md`) |
| 3. Gouvernance | C3 ACL de connexion (IP, horaires), C5 ACL de commandes (refuser / alerter / valider), G1 demandes d'accès, G2 validation (= D2), G4 notifications | ✅ Sprint PAM-3 (voir `docs/governance.md`) |
| 4. Audit | D2 enregistrement RDP, D3 journal des commandes indexé, D4 supervision en direct, D5 coupure de session, D8 stockage externe, D9 SIEM (= E1) | À choisir |
| 5. Opérations | E1 SFTP web, E2 commandes multi-serveurs, E3 playbooks Ansible, A4 passerelles et zones, A8 synchro cloud | À choisir |
| Écartés pour l'instant | A9 à A11 (bases, Kubernetes, web), A14 RemoteApp, C7 masquage SQL, C9 multi-organisations, H2 haute dispo | Plus tard |

### Points relevés pendant PAM-1

- ~~`auth.py` : repli de validation sans vérification de l'émetteur~~ : corrigé en PAM-2 (émetteurs v1/v2 du tenant + `tid`).
- ~~`main.py` : CORS ouvert à toutes les origines~~ : corrigé en PAM-2.
- Rotation : pas encore de clés SSH ni de comptes de domaine AD ; sous Windows, le script peut apparaître dans le journal PowerShell 4104.
- Monitoring et mises à jour ne savent pas encore utiliser un compte en certificat éphémère (mot de passe ou clé requis).
- `docker-compose.prod.yml` n'a pas de service `guacd` : le RDP ne fonctionne pas en prod.
- Suppression d'un serveur : les enregistrements de session et les règles d'alerte qui le référencent bloquent la suppression (clés étrangères sans cascade).

## Priorité : axe sécurité

L'objectif des sprints D / E / F est de transformer Citadel d'un bastion fonctionnel en plateforme conforme aux exigences d'un environnement régulé (audit signé, gouvernance, supply chain).

### Sprint D — Secrets & gouvernance

#### D1. Externaliser `CREDENTIAL_ENCRYPTION_KEY` (✅ fait en PAM-2 avec OpenBao Transit)

- Backend `core/security.py` : abstraire derrière un `KeyProvider` (env / Azure Key Vault / HashiCorp Vault).
- Rotation de clé : migration Alembic pour ré-encrypter les credentials avec un champ `key_version`.
- Suppression de la clé du `.env` en production.

#### D2. Workflow d'approbation 4-yeux (✅ fait en PAM-3)

- Nouveau modèle `ApprovalRequest` (action, requester, approvers, status, reason).
- Endpoint `/api/approvals` + UI : admin peut tagger des serveurs ou patterns de commandes comme "sensibles".
- Blocage WebSocket terminal et `execute` tant que pas approuvé.
- Notifications email / Teams aux approbateurs.

#### D3. Audit log signé

- Hash chain sur `AuditLog` (chaque entrée contient le hash de la précédente → tamper-evident).
- Signature Ed25519 du blob d'événements `SessionRecording`.
- Endpoint de vérification d'intégrité.

### Sprint E — Visibilité & supply chain

#### E1. Export SIEM

- Sortie syslog RFC5424 (TCP + TLS) et format CEF / LEEF.
- Webhook générique configurable (Splunk HEC, Elastic, Microsoft Sentinel).
- Champs : qui, quoi, où, quand, IP source, hash session.

#### E2. Hardening CI/CD

- GitHub Actions : `gitleaks` (secrets), `pip-audit` + `npm audit` (deps), `bandit` (SAST Python), `trivy` (images Docker).
- Signature des images (cosign) et publication de SBOM.

#### E3. Détection d'anomalies

- Service `anomaly_detector.py` : commandes hors heures, volumétrie sortie inhabituelle, patterns d'exfiltration (`tar | curl`, `base64 | curl`), commandes sudo répétées.
- Score de risque par session, alerte temps réel.

### Sprint F — Authentification & réseau

#### F1. WebAuthn / Passkeys pour admins

- En complément de MFA Entra, second facteur hardware obligatoire pour le rôle `admin`.
- Bibliothèque `webauthn` Python, UI d'enrollment.

#### F2. Rate limit affiné + IP allowlist

- Passer du rate limit global (200 req/min) à per-user et per-endpoint (login, terminal open).
- Allowlist CIDR par utilisateur ou rôle (nouvelle table `AccessPolicy`).
- Lockout progressif après échecs d'authentification.

#### F3. Renforcement command filter

- Passer du regex blocklist à une **allowlist par rôle** (viewer = lecture seule, operator = restreint, admin = tout).
- Sandboxing optionnel : exécution dans un shell restreint (`rbash`) côté serveur cible.

### Ordre recommandé

1. **D1 (Vault)** : un seul leak du `.env` compromet aujourd'hui toutes les credentials → risque #1.
2. **D3 (audit signé)** : pré-requis pour la valeur juridique des logs (compliance).
3. **D2 (4-eyes)** : forte plus-value gouvernance, peu de risque technique.
4. Puis Sprint E (visibilité), puis Sprint F (auth/réseau).

Estimation Sprint D : ~2 semaines à temps plein (touche `core/security`, modèles, UI, migrations).

## Axes ultérieurs (post-sécurité)

### Finalisation & qualité

- Stabiliser le RDP (commits récents marqués WIP).
- Tests E2E (Playwright frontend, extension pytest backend).
- Pipeline CI/CD GitHub Actions complet.

### Productivité opérateur

- Playbooks multi-serveurs (Ansible-like) sur `ServerGroup`.
- Scheduler cron-like pour patches automatiques (réutilise `UpdateJob`).
- SFTP / file transfer dans l'UI terminal.
- Notifications sortantes (Teams, Slack, email) sur alertes et fin de job.
- Auto-discovery réseau (scan CIDR → import serveurs).

### Observabilité & scale

- Export Prometheus + dashboard Grafana (réutilise `ServerMetric`).
- OpenTelemetry tracing distribué backend.
- Logs structurés JSON → Loki ou ELK.
- Stratégie backup / restore Postgres documentée.

### Déploiement production

- Terraform Azure (IaC : VM, VNet, NSG, Key Vault).
- Helm chart Kubernetes + Ingress.
- Procédure disaster recovery + tests de restauration.
