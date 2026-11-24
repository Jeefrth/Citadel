# Audit (lot 4)

Enregistrement SSH et RDP, journal des commandes, supervision et coupure en direct, stockage externe avec rétention, export SIEM.

## Enregistrements

| | SSH | RDP |
|---|---|---|
| Moteur | Citadel (entrées et sorties horodatées) | guacd natif (dump du protocole Guacamole) |
| Frappes clavier | enregistrées (comme le terminal) | **non enregistrées** (`recording-include-keys=false`, pour ne pas capter de mots de passe) |
| Relecture | xterm.js, vitesse variable, saut à un instant | `Guacamole.SessionRecording` dans le navigateur |

- La ligne d'enregistrement est créée **dès l'ouverture** de la session : une session interrompue (crash) laisse une trace.
- À la fermeture, le contenu est compressé (gzip), envoyé au stockage actif et son **SHA-256** est conservé en base. Chaque relecture revérifie l'empreinte : un enregistrement altéré est refusé (HTTP 409). Bouton « Vérifier l'intégrité » dans Sessions.
- Si le stockage externe est indisponible, l'enregistrement est écrit sur le disque local plutôt que perdu.
- Supprimer un serveur ne supprime plus ses enregistrements (ils restent consultables, détachés du serveur).
- Consultations et suppressions d'enregistrements sont tracées dans l'audit (`recording.view`, `recording.delete`).

## Stockage et rétention

Paramètres > Audit :

| Type | Configuration | Secret (chiffré dans le coffre) |
|---|---|---|
| Local | `RECORDING_DIR` (`data/recordings/store`) | aucun |
| S3 compatible | endpoint, bucket, région, access key, TLS, préfixe (AWS S3, SeaweedFS, Garage, Ceph...) | secret key |
| Azure Blob | URL du conteneur (https), préfixe | jeton SAS du conteneur (droits create/write/read/delete) |

Changer de stockage n'affecte pas les anciens enregistrements : chacun se relit depuis l'endroit où il a été écrit.

Rétention (`recording_retention_days`, `command_log_retention_days`, 0 = illimitée) appliquée par le planificateur, purge tracée dans l'audit.

## Journal des commandes

Chaque commande passée par Citadel (ligne du terminal ou API d'exécution) est enregistrée avec l'utilisateur, le serveur, le compte, la décision des ACL (autorisée, alerte, refusée, en validation, validée), la règle, le code retour (API) et sa **position dans l'enregistrement**, pour l'ouvrir au bon instant. Recherche plein texte indexée (`pg_trgm`), export CSV (formules neutralisées). Les utilisateurs non admin ne voient que leurs propres commandes.

Même limite que les ACL de commandes : le terminal est reconstitué ligne par ligne, c'est un journal fiable pour un usage normal, pas une preuve contre un utilisateur qui chercherait à masquer ses commandes. L'enregistrement complet reste la référence.

## Sessions en direct

- Registre partagé dans Redis (fonctionne avec plusieurs workers), visible dans « Sessions en direct ».
- **Observer** : SSH = flux en lecture seule avec rattrapage de l'écran récent ; RDP = jonction en lecture seule à la connexion guacd existante (partage natif).
- L'utilisateur est prévenu qu'il est observé (`notify_user_on_monitor`, activé par défaut, recommandé pour la transparence vis-à-vis des collaborateurs).
- **Terminer** : coupe la session (SSH ou RDP) avec un motif affiché à l'utilisateur, notifié et tracé (`session.kill`).

## Export SIEM

Chaque cible a un curseur persistant par flux (`audit`, `commands`) : envoi au moins une fois, reprise après redémarrage, un seul expéditeur actif même avec plusieurs workers (verrou Redis). À la création : « à partir de maintenant » ou « tout l'historique ».

| Format | Transport | Pour |
|---|---|---|
| CEF | syslog UDP / TCP / TLS (RFC 5424, trame RFC 6587) | Microsoft Sentinel (via AMA), QRadar, ArcSight |
| JSON | syslog ou HTTP (tableau JSON) | Elastic, Graylog, collecteurs génériques |
| HEC | HTTP (`Authorization: Splunk <token>`, ou Bearer) | Splunk, **CrowdStrike Falcon NG-SIEM / LogScale** (ingestion HEC) |

## Sécurité

- guacd n'est plus publié sur le réseau (il n'a pas d'authentification) : seul le backend le joint.
- Les tickets de supervision RDP ne peuvent pas ouvrir de session, et inversement.
- En production, le backend tourne avec l'UID 1000 (celui de guacd) pour lire les dumps RDP ; le job d'initialisation prépare les répertoires partagés.
