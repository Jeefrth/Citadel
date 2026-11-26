# Roadmap Citadel

## Phases livrées

- **Phase 0–6** : cadrage, fondations, connectivité SSH/WinRM, terminal interactif, mises à jour, monitoring, hardening production.
- **Sprint A** : session recording (replay xterm.js).
- **Sprint B** : Mini-CA Ed25519, certificats SSH éphémères.
- **Sprint C** : MFA par session, command filter, timeout 30 min, CA persistante.
- **Sprint PAM-1** (11/2026) : règles d'accès, comptes par serveur, comptes virtuels, arborescence de nœuds, étiquettes, favoris, clés API, tickets RDP.
- **Sprint PAM-5** (11/2026) : transfert de fichiers SFTP audité, tâches sur plusieurs serveurs (commandes et playbooks Ansible), zones et passerelles SSH avec bascule (SSH, RDP, WinRM et tout le reste), import des VM Azure.
- **Sprint PAM-4** (11/2026) : enregistrement RDP (guacd), journal des commandes indexé, supervision en lecture seule et coupure en direct (SSH et RDP), stockage local / S3 / Azure avec SHA-256 et rétention, export SIEM (syslog CEF/JSON, HTTP HEC).
- **Sprint PAM-3** (11/2026) : ACL de connexion (login / connect, IP, horaires) et de commandes (API + terminal interactif), validation à 4 yeux, demandes d'accès temporaires, notifications (cloche, e-mail, Teams, webhook).
- **Sprint PAM-2** (11/2026) : coffre OpenBao (Transit + CA SSH + AppRole), migration et rotation de clé, rotation des mots de passe, vérification et collecte des comptes, planificateur. Correctifs : émetteurs Entra explicites, CORS restreint.

## Fonctionnalités inspirées de JumpServer

Analyse du 24/11/2026 de `jumpserver/jumpserver` (v5.2.1). JumpServer est sous **GPLv3** et Citadel sous MIT : on reprend des idées de fonctionnalités, jamais du code.

| Lot | Contenu | Statut |
|-----|---------|--------|
| 1. Socle PAM | C1 règles d'accès, B1 comptes par actif, B9 comptes virtuels, A1 nœuds, A2 étiquettes, A5 favoris, F4 clés API | ✅ Sprint PAM-1 |
| 2. Secrets | B10 coffre OpenBao (= D1), B3 rotation automatique, B5 collecte des comptes, B6 vérification des comptes | ✅ Sprint PAM-2 (voir `docs/vault.md`) |
| 3. Gouvernance | C3 ACL de connexion (IP, horaires), C5 ACL de commandes (refuser / alerter / valider), G1 demandes d'accès, G2 validation (= D2), G4 notifications | ✅ Sprint PAM-3 (voir `docs/governance.md`) |
| 4. Audit | D2 enregistrement RDP, D3 journal des commandes indexé, D4 supervision en direct, D5 coupure de session, D8 stockage externe, D9 SIEM (= E1) | ✅ Sprint PAM-4 (voir `docs/audit.md`) |
| 5. Opérations | E1 SFTP web, E2 commandes multi-serveurs, E3 playbooks Ansible, A4 passerelles et zones, A8 synchro cloud | ✅ Sprint PAM-5 (voir `docs/operations.md`) |
| Écartés pour l'instant | A9 à A11 (bases, Kubernetes, web), A14 RemoteApp, C7 masquage SQL, C9 multi-organisations, H2 haute dispo | Plus tard |

### Points relevés pendant PAM-1

- ~~`auth.py` : repli de validation sans vérification de l'émetteur~~ : corrigé en PAM-2 (émetteurs v1/v2 du tenant + `tid`).
- ~~`main.py` : CORS ouvert à toutes les origines~~ : corrigé en PAM-2.
- Rotation : pas encore de clés SSH ni de comptes de domaine AD ; sous Windows, le script peut apparaître dans le journal PowerShell 4104.
- Monitoring et mises à jour ne savent pas encore utiliser un compte en certificat éphémère (mot de passe ou clé requis).
- ~~`docker-compose.prod.yml` sans `guacd`~~ : ajouté en PAM-4 (et guacd n'est plus publié sur le réseau en dev).
- ~~Suppression d'un serveur bloquée par ses enregistrements~~ : corrigé en PAM-4 (enregistrements conservés, règles d'alerte supprimées).

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

#### E1. Export SIEM (✅ fait en PAM-4)

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

#### F2. Rate limit affiné + IP allowlist (✅ en partie fait en SaaS phase 2 : liste d'adresses et limite par personne au niveau de l'organisation ; reste le verrouillage progressif)

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


## Pistes d'évolution (26/11/2026)

Idées réunies après les phases SaaS 1 à 3. Effort : **S** (quelques jours), **M** (une à deux semaines), **L** (plusieurs semaines). ⭐ = recommandé.

### SaaS (suite des phases)
| Piste | Effort | Notes |
|---|---|---|
| ⭐ Phase 4 : connecteur sortant installé chez le client | L | Condition pour joindre les serveurs privés d'un client sans ouvrir de port. **Un agent installé sur un serveur du site, qui découvre les serveurs existants** (détail plus bas). |
| Phase 5 : produit (inscription, adresse par client, quotas, facturation, RGPD) | L | Deux grilles étudiées : à la personne (entreprises) ou à la ressource protégée avec sous-organisations (infogérants). |
| Sous-organisations pour infogérants (parent / clients, facture consolidée) | M | Indispensable pour la grille « infogérance ». |
| Marque blanche (logo, couleurs, domaine de l'infogérant) | M | |
| Portail client en lecture seule (qui est intervenu, relectures, rapports) | M | |
| Clé maîtrisée par le client (BYOK : Azure Key Vault, HSM) | M | |
| Hébergement des données au choix (Suisse, UE), instance dédiée | M | |
| Vérification DNS automatique des domaines d'organisation | S | Remplace la validation manuelle du super-admin (dnspython). |

### Étendre ce qu'on protège
| Piste | Effort | Notes |
|---|---|---|
| Bases de données (PostgreSQL, MySQL, SQL Server) : identifiant temporaire, journal des requêtes | L | Souvent le premier besoin après SSH et RDP. |
| Applications web internes via proxy HTTP identifié et enregistré | L | Consoles d'hyperviseur, de pare-feu… sans VPN. |
| Équipements réseau (FortiGate, switchs) comme cibles | M | |
| ⭐ Sauvegarde et comparaison des configurations réseau après chaque session, alerte de dérive hors Citadel | M | |
| Consoles cloud (Azure, AWS) : rôle temporaire | M | |
| Comptes Active Directory : rotation, découverte des comptes à privilèges | M | |

### Accès juste à temps et organisation du travail
| Piste | Effort | Notes |
|---|---|---|
| ⭐ Demande et validation depuis Teams ou Slack, expiration automatique | M | La validation à 4 yeux existe, il manque le canal. |
| Zéro privilège permanent par défaut | M | |
| ⭐ Ticket Jira / JSM obligatoire pour se connecter, session rattachée au ticket | S | |
| Lien avec l'astreinte (PagerDuty, Opsgenie) | S | |
| Fenêtres de maintenance pour les actions sensibles | S | |
| ⭐ Bibliothèque de procédures lançables par un niveau 1 sans shell | M | |
| ChatOps : lancer une procédure validée depuis Teams | M | |
| Session partagée ou accompagnée (expert, prestataire sous supervision) | M | |

### Expérience utilisateur
| Piste | Effort | Notes |
|---|---|---|
| ⭐ Outil en ligne de commande (`citadel login`, `citadel ssh web01`) avec certificat court | M | Réutilise la CA SSH ; compatible scp, rsync, VS Code Remote. |
| Passkeys / FIDO2 pour la ré-authentification | M | Voir F1. |
| Application mobile ou notifications pour valider une demande | M | |
| Mode bac à sable pour la formation | M | |

### Intelligence et audit
| Piste | Effort | Notes |
|---|---|---|
| ⭐ Résumé automatique des sessions par IA | S | Les enregistrements et le journal des commandes existent déjà. |
| Détection de comportements à risque en temps réel (commande inhabituelle, horaire, exfiltration) | L | Voir E3. |
| Recherche dans le contenu des sessions et en langage naturel dans l'audit | M | |
| Copilote dans le terminal (explique, propose, prévient avant une commande dangereuse) | M | |
| Enregistrements à valeur probante (horodatage RFC 3161) | S | Voir D3. |
| Rapports de conformité (ISO 27001, nLPD, NIS2) et revue d'accès trimestrielle | M | |

### Intégrations et contexte
| Piste | Effort | Notes |
|---|---|---|
| ⭐ Conformité du poste avant l'accès (Intune, CrowdStrike) | M | Rare dans les bastions. |
| Synchronisation des groupes Entra / Okta (SCIM) | M | |
| ⭐ Vulnérabilités du serveur (Tenable) affichées avant la connexion | S | |
| Supervision (PRTG, métriques) dans la fiche du serveur | S | |
| Synchronisation avec l'inventaire (CMDB, AssetSonar), criticité qui durcit les règles | M | |
| Module CrowdStrike NG-SIEM avec règles de détection | S | |
| Fournisseur Terraform | M | |

### Hygiène et sécurité des secrets
| Piste | Effort | Notes |
|---|---|---|
| ⭐ Nettoyage des clés SSH (`authorized_keys` orphelines) | M | Valeur dès le premier jour chez un nouveau client. |
| Mots de passe du coffre vérifiés contre les fuites (k-anonymat) | S | |
| Comptes pièges | S | |
| Secrets pour pipelines CI/CD via OIDC, identités machine | M | |
| Filigrane RDP / terminal, analyse antivirus des fichiers transférés | M | |
| Certificats TLS des serveurs qui expirent | S | |
| Accès de secours (break-glass) scellé avec rotation après usage | M | |
| Haute disponibilité (plusieurs instances, sauvegarde / restauration documentée) | L | |

### Phase 4 : le connecteur est un agent qui découvre le réseau (décision JF, 26/11/2026)
- **Un agent par site**, installé sur un serveur du réseau du client (Linux ou Windows, paquet ou conteneur). Il ouvre une **connexion sortante** vers Citadel (pas de port entrant chez le client) et relaie les sessions SSH, RDP, WinRM, Kubernetes et les tâches vers les serveurs de son site. Il remplace les passerelles actuelles pour ce site.
- **Découverte des serveurs existants** : l'agent scanne les plages réseau que l'admin de l'organisation lui confie explicitement (jamais d'autres) :
  - hôtes actifs, ports d'administration (22 SSH, 3389 RDP, 5985/5986 WinRM, 443, 6443 Kubernetes, équipements réseau) ;
  - identification du système (bannière SSH, RDP, SMB, nom DNS inverse) ;
  - planification (au déploiement, puis périodique) et rythme limité pour ne pas perturber le réseau.
- **Les serveurs trouvés ne sont pas ajoutés d'office** : ils arrivent dans une liste « à valider », comme les VM cloud en attente aujourd'hui (importer avec nœud, zone et étiquettes, ou ignorer). Un serveur disparu est signalé.
- **Sécurité de l'agent** :
  - enrôlement par jeton à usage unique, puis certificat propre à l'agent, révocable depuis Citadel ;
  - l'agent n'exécute que des actions demandées par Citadel pour une session ou une tâche autorisée, et ne donne jamais de shell libre ;
  - plages de scan et actions journalisées dans l'audit de l'organisation ;
  - mise à jour signée de l'agent.
- **Socle de la suite d'exploitation** (axe suivant) : le même agent portera plus tard l'inventaire, la sauvegarde et la collecte de supervision.

## Axe : suite d'exploitation (idée du 26/11/2026)
Faire de Citadel une suite de gestion d'infrastructure où chaque action passe par le bastion (droits, validation, enregistrement, audit). C'est le différenciateur face aux RMM du marché, cibles fréquentes des attaquants. Existant : inventaire, mises à jour, supervision, tâches et Ansible, SFTP, rotation des secrets, Kubernetes. Modules envisagés, activables par organisation (ex. Citadel Access / Ops / Backup) :

| Module | Contenu | Effort |
|---|---|---|
| Sauvegarde | Orchestration (restic ou Borg vers S3, Azure, SFTP), planning, rétention, chiffrement par organisation, **tests de restauration automatiques**, alerte si une sauvegarde manque ; pilotage de Veeam ou Proxmox Backup Server en option | L |
| Mises à jour v2 | Vagues (test, pilote, production), fenêtres de maintenance, politique de redémarrage, report, conformité par client | M |
| Inventaire complet | Matériel, logiciels, licences, garanties, cycle de vie, export CMDB | M |
| Déploiement logiciel | Catalogue de paquets et scripts, déploiement par groupe | M |
| Conformité de configuration | Contrôles CIS ou base maison, score, dérive, correction par playbook validé | M |
| Supervision v2 | Services, ports, certificats, sauvegardes, escalade (Teams, mail, astreinte), page d'état | M |
| Documentation vivante | Fiche par serveur générée (rôle, contacts, procédures, dernières interventions) | S |

Risques : dispersion (avancer module par module, chacun utile seul), concurrence des RMM établis (rester sur l'angle sécurité et audit), responsabilité sur les sauvegardes (d'où les tests de restauration).

### Ordre suggéré
1. Phase 4 : connecteur sortant (agent par site avec découverte des serveurs).
2. Outil en ligne de commande.
3. Accès juste à temps via Teams + ticket obligatoire.
4. Résumé des sessions par IA (démonstration).
5. Conformité du poste (Intune) et vulnérabilités Tenable avant connexion.
6. Mises à jour v2, puis module Sauvegarde (suite d'exploitation).
7. Phase 5 : produit et facturation, selon la grille retenue.
