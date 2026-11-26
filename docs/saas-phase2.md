# SaaS phase 2 : règles par organisation et console plateforme

Faite le 26/11/2026. Les réglages d'une organisation (Paramètres) existaient mais une partie n'était appliquée nulle part ; ils le sont désormais.

## Réglages appliqués
- **Liste d'adresses autorisées** (`ip_allowlist`, adresses ou plages, vide = toutes) : contrôlée au rattachement à l'organisation (`services/org_policy.check_ip` dans `core/auth.bind_user`), donc pour l'application web, l'API, les clés d'accès, les WebSockets (terminal, Kubernetes, supervision), le RDP, le proxy SSH et les clés d'application. Adresse inconnue = refus. Les super-admins ne sont pas bloqués (accès de support) mais chaque accès hors liste est journalisé (`ip_allowlist.bypass`). Un admin ne peut pas enregistrer une liste qui exclut sa propre adresse. Les refus apparaissent dans le journal des connexions.
- **Limite de requêtes** (`rate_limit_requests` par `rate_limit_window_seconds`) : par personne et par organisation, compteur Redis partagé entre processus ; 0 = pas de limite, sinon 30 au minimum. La limite par adresse du middleware reste la protection de la plateforme.
- **Délai d'inactivité** (`idle_timeout_minutes`) et **durées des certificats** (`default_` / `min_` / `max_cert_validity_minutes`, la durée demandée est ramenée dans [min, max]) : appliqués à l'ouverture de chaque terminal (`services/terminal_core.run_session`).
- **Enregistrement des sessions** (`session_recording_enabled`) : désactivé, les sessions SSH, Kubernetes et RDP ne sont plus enregistrées ; la session et son audit restent.
- `max_session_recordings` supprimé (jamais appliqué ; la rétention se règle en jours).

## Numérotation des demandes de validation
Numéros propres à chaque organisation (#1, #2…), attribués sous verrou consultatif Postgres ; unicité (org_id, number). Migration `c1a7d0e5f014` (renumérotation de l'existant par organisation).

## Console plateforme (super-admin)
- `GET /api/platform/overview` : par organisation membres, invitations, serveurs, clusters, sessions des 30 derniers jours, sessions en direct, volume des enregistrements, dernière activité ; totaux plateforme.
- `GET /api/platform/audit` : journal plateforme (événements sans organisation, cycle de vie des organisations, fournisseurs d'identité, accès hors liste d'adresses).
- `/api/auth/me` renvoie aussi `client_ip` (adresse vue par Citadel), pour remplir la liste d'adresses sans se bloquer.

## Tests
`tests/test_org_policy.py`, `scripts/e2e/org_policies.py` (16 vérifications : liste d'adresses, garde-fou d'auto-blocage, contournement audité du super-admin, limite par personne et par organisation, numéros par organisation, console). Les tests e2e des phases 1 et 3 passent toujours.
