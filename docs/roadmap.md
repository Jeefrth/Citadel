# Roadmap Citadel

## Phases livrées

- **Phase 0–6** : cadrage, fondations, connectivité SSH/WinRM, terminal interactif, mises à jour, monitoring, hardening production.
- **Sprint A** : session recording (replay xterm.js).
- **Sprint B** : Mini-CA Ed25519, certificats SSH éphémères.
- **Sprint C** : MFA par session, command filter, timeout 30 min, CA persistante.

## Priorité : axe sécurité

L'objectif des sprints D / E / F est de transformer Citadel d'un bastion fonctionnel en plateforme conforme aux exigences d'un environnement régulé (audit signé, gouvernance, supply chain).

### Sprint D — Secrets & gouvernance

#### D1. Externaliser `CREDENTIAL_ENCRYPTION_KEY`

- Backend `core/security.py` : abstraire derrière un `KeyProvider` (env / Azure Key Vault / HashiCorp Vault).
- Rotation de clé : migration Alembic pour ré-encrypter les credentials avec un champ `key_version`.
- Suppression de la clé du `.env` en production.

#### D2. Workflow d'approbation 4-yeux

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
