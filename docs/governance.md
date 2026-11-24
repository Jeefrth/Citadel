# Gouvernance (lot 3)

ACL de connexion et de commandes, validation à 4 yeux, demandes d'accès temporaires, notifications.

## Ordre d'évaluation

Pour chaque action sur un serveur (terminal, RDP, exécution de commande) :

1. **Accès à Citadel** : règles de connexion de portée `login` (IP source, horaires).
2. **Règles d'accès** (lot 1) : le serveur doit être visible et l'action accordée, avec un compte autorisé.
3. **ACL de connexion** de portée `connect` : autoriser, refuser ou soumettre à validation.
4. **ACL de commandes** (exécution et terminal) : liste de blocage globale (Paramètres > Commandes), puis règles par priorité.

Dans chaque liste de règles, **la priorité la plus basse passe en premier et la première règle qui correspond s'applique**. Si aucune règle ne correspond, l'action est autorisée (les règles d'accès ont déjà filtré).

Une règle correspond quand tous ses critères renseignés correspondent : utilisateurs ou groupes, serveurs, nœuds (avec leurs sous-nœuds) ou étiquettes, comptes, IP source (CIDR) et plages horaires (fuseau `TIMEZONE`, plages de nuit possibles, par exemple 22:00 à 06:00). Un critère vide veut dire « tous ».

Exemple « prod seulement depuis le VPN, en heures ouvrées » :

| Priorité | Portée | Action | Critères |
|---|---|---|---|
| 10 | connect | autoriser | étiquette `env=prod`, IP `10.165.0.0/24`, lun-ven 07:00-19:00 |
| 20 | connect | validation | étiquette `env=prod` |

Hors VPN ou hors horaires, la connexion part en validation.

**Anti-blocage** : Citadel refuse d'enregistrer une règle `login` qui bloquerait l'admin qui la crée depuis son adresse actuelle.

## ACL de commandes

| Action | Effet |
|---|---|
| Autoriser | Exécutée, arrête l'évaluation (exceptions avant un refus plus large) |
| Refuser | Jamais transmise au serveur ; audit + notification |
| Alerter | Exécutée ; audit + notification aux admins |
| Validation | Bloquée ; une demande est créée. Une fois approuvée, **la même commande exacte** peut être lancée **une seule fois** pendant `COMMAND_GRANT_MINUTES` (30 min) |

Dans le **terminal interactif**, Citadel reconstitue chaque ligne avant de transmettre Entrée :
- frappe simple, retour arrière, Ctrl+U, Ctrl+C : depuis les touches ;
- ligne éditée (flèches, historique, Tab, Ctrl+R) : relue dans l'écho du serveur, avec une émulation de curseur, après avoir attendu cet écho (au plus 0,6 s) ;
- applications plein écran (vim, less, top) : seules les touches tapées sont vérifiées, et seul un refus ou une validation a un effet (Entrée retenue, entrée au journal). Un faux passage en plein écran (`printf` de la séquence) ne désactive donc pas les règles ;
- Ctrl+O (exécuter et passer à la suivante) compte comme Entrée, et le préfixe Ctrl+X (Ctrl+X Ctrl+E exécute la ligne depuis un éditeur) est ignoré à l'invite du shell.

Une ligne refusée est effacée (Ctrl+E, Ctrl+U) et n'entre même pas dans l'historique du shell.

C'est un **garde-fou, pas un bac à sable** : alias, scripts, encodages ou lignes très longues qui débordent de l'écran peuvent le contourner. L'enregistrement des sessions reste la source de vérité. Pour une interdiction stricte, préférer les droits du compte sur le serveur (sudoers).

## Mises à jour système

Appliquer des mises à jour (Mises à jour, ou la fiche serveur) suit les mêmes règles qu'une commande : ACL de connexion, puis ACL de commandes sur la ligne canonique `system-update --all` ou `system-update <paquets>`, et entrée au journal des commandes (source `updates`). Les noms de paquets sont strictement validés (lettres, chiffres, `.+:~_-`). Pour réserver les mises à jour en prod à une validation, créer une règle de commandes « validation » sur le motif `system-update`.

## Validation à 4 yeux

- Valideurs : les membres des groupes choisis dans la règle, sinon les admins.
- **Le demandeur ne peut jamais valider sa propre demande**, même s'il est admin. S'il n'existe aucun autre valideur, la demande reste en attente (l'interface le signale).
- Une demande en attente expire après `APPROVAL_PENDING_HOURS` (24 h).
- Connexion approuvée : réutilisable pendant `CONNECT_GRANT_MINUTES` (60 min).

## Demandes d'accès temporaires

N'importe quel utilisateur peut demander un accès (serveurs ou nœuds, actions, comptes, durée de 1 h à 30 j, motif obligatoire). Une fois approuvée, Citadel crée une règle d'accès « Demande #N » limitée à cette durée. Le demandeur peut l'annuler plus tôt.

## Notifications

Toujours dans l'application (cloche). Canaux externes, chacun abonné à des événements et à un niveau minimum :

| Canal | Configuration | Secret (chiffré dans le coffre) |
|---|---|---|
| E-mail | SMTP (465 SSL ou STARTTLS), expéditeur, destinataires fixes, option « écrire aussi aux personnes concernées » | mot de passe SMTP |
| Teams | Webhook d'un flux **Workflows** « Publier dans un canal quand une requête webhook est reçue » (carte adaptative) | URL du webhook |
| Webhook | POST JSON `{source, event, level, title, body, link, timestamp}` | URL |

Événements : demande à valider, décision, commande surveillée, commande refusée, connexion refusée, échec de rotation, compte privilégié non géré découvert.

## IP source derrière un reverse proxy

Citadel n'utilise `X-Forwarded-For` que si la requête vient d'un proxy listé dans `TRUSTED_PROXIES`. En production, nginx (le conteneur `frontend`, à l'adresse fixe `172.31.250.10`) **écrase** cet en-tête avec l'adresse réelle du client sur `/api/` et `/ws/`, et lui seul est déclaré de confiance. Ne jamais mettre des plages entières (`10.0.0.0/8`...) dans `TRUSTED_PROXIES` : un client de ces plages pourrait alors choisir l'IP vue par les ACL. Si un autre reverse proxy est placé devant nginx, configurer `set_real_ip_from` / `real_ip_header` dans nginx.

## Fin des règles d'accès, import et export (lot 6)

- **Rappel** : `access_expiry_notice_days` jours (3 par défaut, 0 : jamais) avant la fin d'une règle d'accès, les personnes concernées (utilisateurs et membres des groupes) et les admins sont prévenus (événement `access.expiring`). Un seul rappel par date de fin ; changer la date réarme le rappel.
- **Export** (Accès > Exporter) : JSON portable, les références sont des noms (utilisateurs par e-mail, ou `oid:<id Entra>` sans e-mail ; groupes et serveurs par nom ; nœuds par chemin `Prod/Web`).
- **Import** : toujours une simulation d'abord (créées, remplacées, ignorées, en erreur avec la raison). Une règle dont une référence est inconnue n'est pas importée du tout. Une règle qui existe déjà est ignorée, sauf si « remplacer » est coché.
