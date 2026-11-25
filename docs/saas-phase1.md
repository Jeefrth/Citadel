# SaaS phase 1 : multi-organisation (en cours)

Décisions validées par JF le 25/11/2026 (objectif : SaaS) :
- Une base, `org_id` sur toutes les tables client, filtre ORM automatique + RLS Postgres (défense en profondeur).
- Rôle par appartenance (OrgMembership) ; super-admin plateforme (`users.is_platform_admin`) ; un utilisateur peut être dans plusieurs organisations (sélecteur).
- Une clé Transit par organisation (`citadel-org-<id>`) et une CA SSH par organisation (clé privée chiffrée avec la clé de l'org). L'organisation par défaut (données actuelles) garde la clé et la CA existantes.
- Paramètres, stockage, SIEM, masquage, notifications, sauvegardes par organisation ; plateforme et coffre globaux.
- Phases suivantes : 2 paramètres/audit par org, 3 identité SaaS (Entra multi-tenant, OIDC, invitations), 4 connecteur sortant, 5 produit (inscription, sous-domaines, facturation, RGPD).

## État (25/11/2026)

Étapes 1 à 6 faites et testées sur une copie de la base (`citadel_saas`), étape 7 (front) en cours, étape 8 : tests faits, revue de sécurité à lancer.

### Modèle et base
- `core/tenancy.py` : contexte (ContextVar `TenantContext` org_id / transit_key / CA / bypass, `TenantContext.for_org(org)`), `tenant(org)`, `system()`, `TenantMixin`, filtre ORM `do_orm_execute` (échec fermé sans organisation), `before_flush` (estampille org_id, refuse une autre org ; audit sans org autorisé pour les événements plateforme), `after_begin` (`SET LOCAL ROLE citadel_rls` + `app.org_id` / `app.bypass`), `apply_to_session` après un changement de contexte dans une transaction ouverte.
- `models/organization.py` (Organization, OrgMembership, OrgInvitation) ; `User` sans rôle stocké : `role`, `custom_role`, `org` sont posés par `bind_user` ; `is_platform_admin`.
- Migration `c1a7d0e5f012` : org « Par défaut » (slug `default`) avec les données existantes, appartenances depuis l'ancien rôle, anciens admins = super-admins, org_id sur 37 tables + app_settings + login_events, unicités par org, rôle `citadel_rls`, RLS ENABLE + FORCE sur 38 tables. Aller-retour downgrade / upgrade vérifié.

### Requêtes et points d'entrée
- `core/auth.py` : `user_orgs`, `resolve_org` (en-tête `X-Citadel-Org`, sinon la première ; une clé d'accès reste dans son org, en-tête contraire = 403), `bind_user`, `bind_request`, `authenticate_ws` (champ `org` du message auth). Première connexion : invitations converties en appartenances ; `AUTO_JOIN_DEFAULT_ORG` (vrai par défaut) met les nouveaux venus lecteurs dans l'org par défaut, comme avant.
- `services/members.py` : toute liste ou résolution d'utilisateurs passe par les membres de l'org courante (`members_query`, `admin_ids`, `names`, `load_member` pour évaluer les droits d'une autre personne).
- WebSockets terminal / k8s / monitor, ticket RDP (org dans le ticket), surveillance RDP, registre des sessions en direct (org_id dans les métadonnées, invisible hors de son org), paramètres (`settings_service.scope()`, clés plateforme à org NULL), API applications (la clé désigne l'org), planificateur et SIEM (une boucle par org), nettoyage des tâches au démarrage (`system()`).
- Proxy SSH : organisation choisie par préfixe `login#acme:serveur` ou par un menu si la personne en a plusieurs ; la règle de connexion à Citadel est évaluée après ce choix (l'authentification SSH réussit, la session est refusée) ; connexions journalisées avec leur org.

### Chiffrement et CA
- Clé Transit par org `citadel-org-<uuid>` (créée avec l'org ; politique OpenBao élargie à `citadel-org-*`, relancer `vault-bootstrap`). Blobs préfixés `okey:<clé>|` ; dans une org, un blob d'une autre clé est refusé (`KeyMismatch`). Backend local : clé dérivée (HKDF) par org. L'org par défaut garde la clé existante.
- CA SSH par org (Ed25519, clé privée chiffrée avec la clé de l'org, signature via fichier temporaire 0600 supprimé aussitôt). L'org par défaut garde la CA existante. Une org avec sa clé mais sans CA refuse de signer.
- CLI `secrets-status|migrate|rotate-key` : org par org.

### API
- `/api/auth/me` (org courante, orgs accessibles, `is_platform_admin`), `/api/orgs/mine`, `/api/org/members` (+ PATCH / DELETE = retirer de l'org), `/api/org/invitations`, `/api/platform/orgs` (super-admin connecté, pas de clé d'accès). `/api/admin/users` et `/api/users` = membres de l'org courante.

### Tests
- `tests/test_tenancy.py` (contexte, clés par org, préfixes forgés, CA, préfixe du proxy) ; suite complète : 158 tests OK.
- `scripts/e2e/org_isolation.py` : 30 vérifications entre deux orgs (listes, 404 en lecture / modification / suppression, mêmes noms dans les deux, invitations, clés d'accès, CA distincte et certificat signé par la bonne, chiffrement croisé refusé, RLS en SQL brut, échec fermé). `scripts/e2e/org_ssh_proxy.py` : préfixe, menu, journal. Lancer dans le conteneur backend avec `PYTHONPATH` sur le code de la branche et une base migrée.

### Limites connues (à traiter en revue ou en phase 2)
- Tables d'association (membres des groupes, cibles des règles) sans org_id : protégées par leurs lignes parentes, pas par la RLS.
- Appareils, clés SSH et jetons du proxy sont globaux à la personne : un admin d'une org qui révoque l'appareil d'un membre partagé le révoque partout.
- Une connexion Entra est journalisée dans l'org de la première requête de l'appareil.
- Limitation de débit et liste d'adresses autorisées : réglages par org, mais le middleware n'en tient pas compte (comme avant).

### Revue de sécurité (25/11/2026, 4 relecteurs + vérification adverse)
Corrigé :
- Invitations : un admin d'organisation ne fait plus entrer directement une personne existante (consentement exigé : acceptation depuis Mon compte, `/api/me/invitations`), réponse identique que l'adresse ait un compte ou non (pas d'énumération). Ajout direct réservé au super-admin (premier admin d'une nouvelle org). La revendication `email` d'Entra (modifiable, non vérifiée) n'est plus utilisée, les invités `#EXT#` sont refusés.
- Retrait d'un membre de l'org par défaut annulé à la connexion suivante : l'adhésion automatique n'a lieu qu'à la création du compte. Le retrait supprime aussi les liens groupes / règles de l'org, désactive les clés d'accès de l'org et termine les sessions ouvertes ; une session ouverte se ferme à la commande suivante d'un membre retiré ou suspendu.
- Afficher les appareils dans B révoquait les clés d'accès de A (rapprochement filtré par org) : recherche en `system()`.
- Notifications : destinataires limités aux membres de l'org.
- Sauvegardes de comptes : clé de stockage par org et unique.
- RLS `app_settings` : lignes plateforme lisibles par tous, modifiables seulement en `system()`.
- Identifiant d'org qui ressemblerait à un UUID refusé ; résolution de l'en-tête par id d'abord.
- Front : organisation lue une fois par onglet ; changement dans un autre onglet = avertissement bloquant (pas d'action dans la mauvaise org).

Non corrigé (faible) : numérotation des demandes de validation globale à la plateforme (le saut de numéros révèle l'activité des autres) ; règles Kubernetes et ACL acceptant des identifiants hors org (sans effet).

## Reste à faire
- Recette dans le navigateur, puis fusion dans `main` (sauvegarde de la base, migration, relancer `vault-bootstrap`).
