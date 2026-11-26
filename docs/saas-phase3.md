# SaaS phase 3 : identité (plusieurs fournisseurs de connexion)

Décisions validées par JF le 25/11/2026 :
- **Sessions Citadel** : le serveur fait la connexion OIDC (code + PKCE) chez le fournisseur, puis délivre sa propre session (jeton d'accès court signé par Citadel + cookie de renouvellement HttpOnly). MSAL disparaît du front. API, WebSockets, proxy SSH et clés d'accès ne changent pas de forme.
- **OIDC seulement** (Entra, Okta, Google, Keycloak, Auth0…). SAML plus tard si un client l'exige.
- **Pas de compte sans invitation** : une personne inconnue n'obtient un compte que si une invitation l'attend (e-mail vérifié par le fournisseur) ou si le SSO de son organisation prévoit l'arrivée automatique (JIT). Sinon : refus, aucun compte créé.

## Modèle
- `identity_providers` : fournisseur OIDC. `org_id` NULL = fournisseur plateforme (bouton sur l'écran de connexion : Microsoft tous comptes, Google), sinon SSO d'une organisation. Champs : type (entra / google / okta / oidc), nom, issuer, client_id, secret chiffré (clé de l'org, ou clé par défaut pour la plateforme), scopes, domaines e-mail (découverte et restriction), `jit_role` (aucun / lecteur / opérateur : arrivée automatique dans l'org), `enforced` (les membres de l'org doivent passer par ce SSO), actif.
- `user_identities` : (fournisseur, issuer, subject) -> utilisateur ; e-mail et e-mail vérifié vus à la dernière connexion. Unique (issuer, subject). Une personne peut lier plusieurs fournisseurs depuis Mon compte (jamais de liaison automatique par e-mail).
- `auth_sessions` : session Citadel (utilisateur, fournisseur, `auth_time`, empreinte du jeton de renouvellement, rotation avec détection de réutilisation, expiration, IP, appareil, révocation).
- Migration : le fournisseur Entra Qim actuel devient le SSO de l'organisation par défaut (`jit_role` lecteur, comme l'adhésion automatique d'avant), `users.entra_object_id` devient une identité. Entra : subject = `oid` (le `sub` OIDC d'Entra dépend de l'application).

## Flux
- Écran de connexion : boutons des fournisseurs plateforme + « SSO de mon entreprise » (e-mail ou identifiant d'organisation -> fournisseur de l'org, découverte par domaine).
- `GET /api/auth/login/{provider}` -> redirection chez le fournisseur (state, nonce, PKCE gardés dans Redis 10 min) ; `GET /api/auth/callback` -> échange du code, validation de l'id_token (JWKS de la découverte, iss, aud, nonce, exp), identité, session, cookie, retour au front.
- `POST /api/auth/refresh` (cookie) -> jeton d'accès (10 min) ; rotation du cookie à chaque appel ; réutilisation d'un ancien cookie = session révoquée.
- `POST /api/auth/logout`, sessions visibles et révocables dans Mon compte (avec les appareils).
- Ré-authentification avant un terminal : fenêtre vers le fournisseur avec `prompt=login` + `max_age=0`, la session reçoit un nouvel `auth_time` ; le serveur exige un `auth_time` récent pour ouvrir un terminal si `mfa_required_for_terminal`.
- SSO imposé : une org `enforced` n'accepte que les sessions ouvertes par son fournisseur (les super-admins gardent un accès de secours).
- Invitation : acceptée seulement avec un e-mail vérifié par le fournisseur (`email_verified`) ; Entra : UPN d'un membre (pas `#EXT#`) du tenant du fournisseur.

## Étapes
1. Modèles + migration (fournisseurs, identités, sessions ; reprise du fournisseur Entra Qim et des identités existantes).
2. Client OIDC (découverte en cache, PKCE / state / nonce dans Redis, échange du code, validation de l'id_token).
3. Sessions Citadel (jeton signé, renouvellement par cookie avec rotation, déconnexion) ; `authenticate_token` n'accepte plus que jetons Citadel et clés d'accès.
4. Endpoints de connexion (fournisseurs, découverte, login, callback, ré-authentification, refresh, logout) et règles de création de compte (refus sans invitation ni JIT).
5. SSO imposé dans `bind_user` ; Mon compte : identités liées (lier, délier), sessions.
6. Administration : SSO de l'organisation (admin de l'org, Paramètres > Authentification), fournisseurs plateforme (super-admin).
7. Front : retrait de MSAL, écran de connexion, gestion du jeton et du renouvellement, ré-authentification des terminaux, pages d'administration.
8. Tests (unitaires + e2e avec un fournisseur OIDC de test local) et revue de sécurité.

## État (25/11/2026)
- Serveur (étapes 1 à 6) fait : `models/auth.py`, migration `c1a7d0e5f013`, `services/oidc.py`, `services/sessions.py`, `services/login.py`, `api/login.py`, `api/providers.py`, SSO imposé et ré-authentification dans `core/auth.py`.
- Tests : `tests/test_login.py`, `scripts/e2e/sso_login.py` (36 vérifications avec un fournisseur OIDC factice lancé par le test : refus sans invitation, JIT par domaine, invitation + e-mail vérifié, e-mail non vérifié refusé, rotation du cookie, rejeu du callback refusé, cookie volé = session révoquée, SSO imposé, ré-authentification avant terminal, jeton de fournisseur ou falsifié refusé, redirection ouverte impossible). Le test se lance avec un serveur de test démarré avec `OIDC_ALLOW_HTTP=true` et `PUBLIC_URL=http://localhost:8001`.
- Corrigé au passage : suppression d'une personne bloquée par la contrainte appareil du journal des connexions (contrainte désormais vérifiée à la validation) ; scripts du laboratoire adaptés aux organisations.
- Front (étape 7) en cours.

## Revue de sécurité (26/11/2026, 3 relecteurs + vérification adverse)
Corrigé :
- Usurpation de n'importe quel compte Entra : la détection « Entra multi-tenant » était une recherche de texte dans l'émetteur ; un fournisseur d'organisation pointant vers son propre serveur pouvait signer des jetons au nom de n'importe qui. Désormais : URL exacte, et tous les points d'accès (clés, jeton, autorisation) doivent être sur l'hôte de l'émetteur (Google : googleapis.com) ; un fournisseur « entra » doit être sur login.microsoftonline.com.
- Captation d'invitations : un SSO d'organisation pouvait affirmer n'importe quelle adresse « vérifiée ». Une adresse n'est retenue (compte, invitations) que si elle vient d'un fournisseur plateforme ou d'un SSO d'organisation pour un domaine **approuvé par un super-admin** (`verified_domains`, `PUT /api/platform/identity-providers/{id}/verified-domains`, demandes en attente : `GET /api/platform/domain-requests`). La découverte par adresse n'utilise que les domaines approuvés.
- Secret `AZURE_CLIENT_SECRET` envoyable à un serveur tiers : réservé au fournisseur Entra de l'org par défaut, tenant et application exacts. Un changement d'émetteur, d'application ou de type efface le secret stocké.
- Connexion forcée (login CSRF) : cookie de liaison `citadel_oidc` posé au départ et exigé au retour ; les fenêtres (ré-authentification, liaison) exigent le cookie de la session qui les a demandées.
- Injection de script dans la fenêtre de retour : plus de script en ligne (données en JSON échappé + `/api/auth/popup.js`, CSP stricte), l'erreur du fournisseur n'est jamais reflétée.
- Ré-authentification sans `auth_time` acceptée : refusée ; l'heure de connexion doit être postérieure à la demande.
- RDP ouvrable sans ré-authentification récente : le ticket RDP l'exige aussi.
- Requêtes du serveur vers des adresses internes (SSRF) via l'émetteur : adresses privées, locales et métadonnées refusées, pas de redirection suivie, réponse du fournisseur non renvoyée.

## Prérequis côté Entra (JF)
L'application `srv_gest` est aujourd'hui de type SPA (pas de secret). L'échange du code se fait désormais côté serveur : ajouter une plateforme **Web** avec l'URI de redirection `http://localhost:5173/api/auth/callback` et créer un **secret client** (à mettre dans `.env` : `AZURE_CLIENT_SECRET`, repris par la migration dans le fournisseur).
La ré-authentification exige la revendication `auth_time` dans le jeton d'ID : dans l'application, **Configuration des jetons > Ajouter une revendication facultative > ID > auth_time**.
