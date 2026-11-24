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

## Connexions et appareils (lot 6)

- **Journal des connexions** (Audit > Connexions) : chaque connexion à Citadel, réussie ou refusée (règle de connexion, compte désactivé), avec la méthode (Entra ou clé d'accès), l'IP et l'appareil. Une connexion est enregistrée au premier appel d'un appareil, puis après 8 h sans activité. Chacun voit les siennes (Mon compte), les admins voient tout. Export CSV.
- **Appareils** : chaque navigateur envoie un identifiant aléatoire (en-tête `X-Citadel-Device`, gardé dans le navigateur) ; une clé d'accès est son propre appareil. « Déconnecter » un navigateur fait répondre l'API `401 device_revoked` et l'interface se déconnecte. La session Entra, elle, reste valide : pour couper l'accès d'une personne, **désactiver son compte Citadel** (effet immédiat) ou révoquer ses sessions dans Entra. Déconnecter une clé d'accès la désactive.

## Rapports (lot 6)

Audit > Rapports, sur une période (30 jours par défaut) :

| Rapport | Contenu |
|---|---|
| Utilisateurs | rôle, dernière connexion, connexions réussies et refusées, sessions, commandes (dont bloquées), appareils actifs |
| Serveurs | sessions, utilisateurs distincts, commandes (dont bloquées), transferts de fichiers, comptes |
| Comptes | secret (coffre, certificat, aucun), rotation et âge du secret, dernière vérification |

Affichage imprimable (PDF par l'impression du navigateur) ou CSV (formules neutralisées). Chaque consultation est tracée (`report.view`).

## Téléchargement groupé des enregistrements (lot 6)

Sélection de sessions > Télécharger : une archive ZIP avec les sessions SSH au format **asciinema** (`.cast`, `asciinema play fichier.cast`), les sessions RDP au format Guacamole (`.guac`) et un `manifest.csv`. Chaque enregistrement est vérifié (SHA-256) à la sortie : un fichier altéré n'est pas inclus et le manifeste l'indique. 200 sessions au plus par archive. Les non-admins ne téléchargent que leurs propres sessions.
