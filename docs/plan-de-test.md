# Plan de test manuel

Recette fonctionnelle de Citadel, lots 1 à 8, à dérouler dans l'interface (http://localhost:5173) avec les cibles du laboratoire. Les tests automatiques (`pytest`, 139 tests) couvrent la logique ; ce plan vérifie l'application de bout en bout, écrans compris.

Durée indicative : 3 h pour tout, 45 min pour le parcours essentiel (tests marqués **[E]**).

Convention : chaque test a un identifiant, des étapes et un résultat attendu. Cocher `[x]` une fois validé ; noter l'écart sinon (et ouvrir une issue).

---

## 0. Préparation

### 0.1 Laboratoire

```bash
cd ~/citadel
docker compose up -d                 # Citadel
scripts/test-lab.sh up               # cibles Linux, passerelle, cible isolée, k3s (environ 30 s)
scripts/test-lab.sh up --rdp         # idem + bureau RDP (image d'environ 1 Go)
scripts/test-lab.sh users            # utilisateurs de test non-admin + clés d'accès (data/lab/keys.txt)
scripts/test-lab.sh status           # rappel des cibles et identifiants
```

| Cible | Adresse (depuis Citadel) | Comptes |
|---|---|---|
| Linux | `lab-linux`, `lab-linux2` port 22 | `deploy` / `Lab-Admin-2026` (sudo sans mot de passe, compte par défaut) ; `alice` / `Lab-User-2026` (sans sudo) ; ton identifiant (sans mot de passe, pour `@USER` en certificat) |
| Isolée | `lab-isolated` port 22, joignable seulement par la passerelle | `deploy` / `Lab-Admin-2026` |
| Passerelle | `lab-gw` port 22 | `gw` / `Lab-Gw-2026` |
| Kubernetes | `https://lab-k3s:6443` | jeton `data/lab/k3s.token`, CA `data/lab/k3s-ca.crt` |
| RDP | `lab-rdp` port 3389 | `ubuntu` / `ubuntu` |

Non couvert par le laboratoire : cibles Windows / WinRM (mises à jour Windows, push de compte Windows). À tester sur une vraie machine si besoin.

### 0.2 Profils

| Profil | Comment |
|---|---|
| Admin | ton compte Entra |
| Operator, viewer, auditeur (viewer + rôle personnalisé `audit`) | **interface** : un 2e compte Entra du tenant (son 1er login le crée en viewer, puis changer son rôle). **API** : les clés de `scripts/test-lab.sh users` avec `curl -H "Authorization: Bearer <clé>" http://localhost:8010/api/...` |

Les tests de droits marqués **(API)** se font avec ces clés ; ceux marqués **(2e compte)** demandent une session Entra.

### 0.3 Ajouter les serveurs du laboratoire

Toutes ces étapes se font avec ton compte admin. Les noms `lab-*` sont résolus par Citadel (même réseau Docker) : on les saisit tels quels dans le champ « Adresse IP ».

#### 0.3.1 Nœud et identifiants

- [ ] **P1** Serveurs > colonne des nœuds > « Nouveau nœud racine » : nom `Labo` > « Créer le nœud ». Puis, sur `Labo`, « Nouveau sous-nœud » : `Web`.
- [ ] **P2** Serveurs > bouton **Credentials** (en haut à droite) : créer les identifiants, un par un.

  | Nom | Type | Utilisateur | Mot de passe |
  |---|---|---|---|
  | `lab-deploy` | SSH (mot de passe) | `deploy` | `Lab-Admin-2026` |
  | `lab-alice` | SSH (mot de passe) | `alice` | `Lab-User-2026` |
  | `lab-gw` | SSH (mot de passe) | `gw` | `Lab-Gw-2026` |
  | `lab-rdp` | WinRM | `ubuntu` | `ubuntu` (seulement si `up --rdp`) |

  Attendu : les mots de passe ne sont plus jamais affichés ; ils sont chiffrés dans le coffre (`vault:v1:...` en base).

#### 0.3.2 Serveur Linux `lab-linux`

- [ ] **P3** Serveurs > **Ajouter un serveur** :

  | Champ | Valeur |
  |---|---|
  | Nom | `lab-linux` |
  | Nom d'hôte | `lab-linux` |
  | Adresse IP | `lab-linux` |
  | Système | Linux |
  | Port SSH | `22` |
  | Nœud | `Labo` |
  | Zone réseau | aucune |
  | Étiquettes | `env=labo`, `role=web` |
  | Créer un compte par défaut | coché : utilisateur `deploy`, **Compte privilégié** coché, Authentification « Credential enregistré » > `lab-deploy` |

  « Ajouter le serveur ». Attendu : le serveur apparaît sous `Labo`, statut inconnu.
- [ ] **P4** Ligne du serveur > **Tester la connexion** : OK. Puis **Infos système** : Debian 12, uptime, noyau.
- [ ] **P5** Ouvrir la fiche `lab-linux` > section **Comptes** > **Ajouter un compte** : utilisateur `alice`, « Credential enregistré » > `lab-alice`, ni par défaut ni privilégié > enregistrer. Sur la ligne d'`alice` : **Vérifier**. Attendu : OK.
- [ ] **P6** Compte en certificat : **Ajouter un compte**, utilisateur = ton identifiant (la partie avant `@` de ton e-mail, par exemple `jean-francois.reithler`), Authentification **Certificat éphémère (CA Citadel, Linux uniquement)**. Attendu : aucun secret demandé. (Les comptes virtuels `@USER` et `@INPUT` n'ont pas besoin d'être créés : ils viennent des règles d'accès.)

#### 0.3.3 Deuxième serveur `lab-linux2`

- [ ] **P7** Même chose que P3 avec Nom, Nom d'hôte et Adresse IP = `lab-linux2`, nœud `Labo > Web`, étiquettes `env=labo`, `role=app`, compte par défaut `deploy` / `lab-deploy`. Ajouter `alice` comme en P5. Tester la connexion : OK.

#### 0.3.4 Zone, passerelle et serveur isolé `lab-isolated`

- [ ] **P8** Infrastructure > **Zones et passerelles** > **Ajouter une zone** : nom `Isolée`.
- [ ] **P9** Dans la zone `Isolée` > **Ajouter une passerelle** : nom `lab-gw`, Hôte `lab-gw`, Port SSH `22`, Compte `gw`, Authentification « Credential enregistré » > `lab-gw`, Priorité `10`, active. Bouton **Tester** : OK.
- [ ] **P10** Serveurs > **Ajouter un serveur** : Nom, Nom d'hôte et Adresse IP = `lab-isolated`, Linux, port 22, nœud `Labo`, **Zone réseau `Isolée`**, compte par défaut `deploy` / `lab-deploy` privilégié. Tester la connexion : OK (passe par la passerelle).
- [ ] **P11** Contre-test : modifier `lab-isolated`, retirer la zone, Tester la connexion. Attendu : échec (hôte injoignable sans passerelle). Remettre la zone `Isolée`.

#### 0.3.5 Bureau RDP `lab-rdp` (si `up --rdp`)

- [ ] **P12** Serveurs > **Ajouter un serveur** : Nom, Nom d'hôte et Adresse IP = `lab-rdp`, **Système Windows** (c'est le type qui active le RDP), Port RDP `3389`, nœud `Labo`, compte par défaut `ubuntu` / « Credential enregistré » `lab-rdp`.
  Attendu : connexion RDP possible depuis le Terminal. Le bureau de test est un Linux avec xrdp : « Tester la connexion », les infos système et les mises à jour (WinRM) échouent, c'est normal.

#### 0.3.6 Vérifications après ajout

- [ ] **P13** Serveurs : 3 ou 4 serveurs, filtre étiquette `env=labo`, filtre nœud `Labo` (sous-nœud `Web` inclus), recherche `isolated`.
- [ ] **P14** Fiche `lab-linux` > métriques : CPU, RAM et disque remontent après quelques minutes (compte par défaut).
- [ ] **P15** Traces : la page Journal d'audit n'a pas encore d'écran, vérifier en base : `docker compose exec db psql -U citadel -d citadel -c "select action, result from audit_logs order by timestamp desc limit 20"`. Attendu : création des credentials, des comptes, `server.test_connection`.

#### 0.3.7 Règle d'accès de test

- [ ] **P16** Accès > **Règles d'accès** > nouvelle règle `Labo` : utilisateurs = le 2e compte Entra et `Lab Operator`, nœud `Labo`, actions `connect`, `execute`, `upload`, `download`, comptes `alice` et `@USER`, sans fin de validité. Attendu : statut « Active ».
- [ ] **P17** Accès > **Accès effectifs** > `Lab Operator` : `lab-linux`, `lab-linux2`, `lab-isolated` (et `lab-rdp`) avec la règle `Labo` comme source.

---

## 1. Connexion, appareils, compte

- [ ] **A1 [E]** Se connecter. Attendu : tableau de bord, aucun message d'erreur. Mon compte > Mes connexions : une ligne « réussie », méthode Entra, ton IP, « Chrome · macOS » (ou ton navigateur).
- [ ] **A2** Mon compte > Appareils : ce navigateur marqué « cet appareil ». Ouvrir Citadel dans un 2e navigateur (ou une fenêtre privée) : un 2e appareil apparaît.
- [ ] **A3** Depuis le 1er navigateur, déconnecter le 2e appareil. Attendu : dans le 2e navigateur, à la requête suivante, retour à la page de connexion avec le message « Ce navigateur a été déconnecté ». Une nouvelle connexion recrée un appareil.
- [ ] **A4** Audit > Connexions : filtres utilisateur / résultat / méthode / dates, pagination, export CSV (s'ouvre dans un tableur, pas de formule exécutée).
- [ ] **A5** Créer une clé d'accès (Mon compte), l'utiliser avec `curl .../api/auth/me` : elle apparaît comme appareil « clé d'accès ». La déconnecter : la clé est désactivée (401).
- [ ] **A6** Accès > ACL de connexion : règle de portée `login` qui refuserait ton IP. Attendu : refus d'enregistrement (anti-blocage).
- [ ] **A7** Règle `login` refusant une autre IP pour `lab-operator` (API) puis appel avec sa clé : 403, et une connexion « refusée » avec la raison dans Audit > Connexions.

## 2. Inventaire

- [ ] **I1 [E]** Serveurs : liste, recherche (nom, IP), filtre par étiquette, par nœud (sous-nœuds inclus), favoris.
- [ ] **I2** Fiche serveur : infos système, métriques, statut ; modifier une étiquette.
- [ ] **I3** Nœuds : créer « Labo > Web », y déplacer `lab-linux2`, vérifier le filtre récursif.
- [ ] **I4** Cmd+K : rechercher un serveur, une page, une action (« Ajouter un cluster Kubernetes », « Mes appareils »).

## 3. Comptes et coffre

- [ ] **S1 [E]** Paramètres > Coffre de secrets : backend `vault`, transit OK, CA SSH dans le coffre.
- [ ] **S2** Compte `alice` > Vérifier : OK. Changer son mot de passe dans le conteneur (`docker exec lab-linux sh -c 'echo alice:autre | chpasswd'`) puis Vérifier : échec visible.
- [ ] **S3 [E]** Compte `alice` > Faire tourner : nouveau mot de passe posé (`chpasswd` via le compte par défaut), historique du secret mis à jour, Vérifier : OK.
- [ ] **S4** Rotation automatique : activer sur `alice` avec 1 jour ; vérifier la date de prochaine rotation.
- [ ] **S5** Collecte des comptes sur `lab-linux` : `deploy`, `alice`, ton compte, `root` détectés ; `root` signalé à privilèges non géré (notification `discovery.privileged`).
- [ ] **S6** Accès > Comptes découverts : ignorer `root`, gérer un autre compte.

## 4. Droits

- [ ] **D1 [E]** (2e compte operator) Serveurs : seuls `lab-linux` / `lab-linux2` (nœud Labo) visibles. Un serveur hors règle : 404 en accédant à son URL directement.
- [ ] **D2** (2e compte) Connexion avec `alice` OK ; avec `deploy` refusée (compte non accordé).
- [ ] **D3** `@USER` : connexion avec un certificat éphémère à ton nom (compte sans mot de passe sur la cible). Attendu : session ouverte, certificat limité dans le temps.
- [ ] **D4** `@INPUT` (ajouter `@INPUT` à la règle) : saisie `alice` + mot de passe à la connexion, rien n'est enregistré.
- [ ] **D5 (API)** `lab-viewer` avec une règle donnant `execute` : `POST /api/servers/{id}/execute` refusé (plafond viewer).
- [ ] **D6** Accès > Accès effectifs : choisir `lab-operator`, voir pourquoi il voit chaque serveur (règle source).
- [ ] **D7** Règle avec fin de validité dans 2 jours : badge « Expire dans 2 j » ; le rappel `access.expiring` arrive (cloche) au prochain cycle du planificateur (5 min).
- [ ] **D8** Accès > Exporter (JSON) ; modifier un nom dans le fichier, ajouter une référence inconnue ; Importer : simulation (créées, ignorées, erreurs avec la raison), puis import réel.

## 5. Sessions interactives

- [ ] **T1 [E]** Terminal > `lab-linux` (`alice`) : popup de réauthentification Entra, shell, `ls`, `top` puis `q`, Ctrl+R dans l'historique, plusieurs onglets.
- [ ] **T2** Redimensionner la fenêtre : `stty size` suit.
- [ ] **T3** Inactivité : délai `idle_timeout_minutes` (mettre 2 min pour le test) : fermeture avec message.
- [ ] **T4 (RDP)** Serveur `lab-rdp` (OS Windows/RDP, compte `ubuntu`) : bureau affiché, presse-papiers selon les droits copy/paste, déconnexion propre.
- [ ] **T5** Proxy SSH (voir 10.1) puis comparer l'enregistrement avec une session web : identiques.

## 6. Gouvernance

- [ ] **G1 [E]** Paramètres > Commandes (liste de blocage) contient `rm -rf /`. Dans un terminal : `rm -rf /` est bloqué, la ligne est effacée, message rouge, entrée « refusée » au journal des commandes.
- [ ] **G2** Contournements connus fermés : `rm -rf /` suivi de **Ctrl+O** au lieu d'Entrée ; `printf '\e[?1049h'` puis `rm -rf /` ; Ctrl+X Ctrl+E. Attendu : tous bloqués (garde-fou ; pas un bac à sable).
- [ ] **G3** Accès > ACL de commandes : règle « alerter » sur `sudo` : la commande passe, notification `command.alert`.
- [ ] **G4 [E]** Règle « validation » sur `systemctl restart` pour le 2e compte : commande bloquée, demande créée. Valider avec ton compte (Validations) : le 2e compte relance **exactement** la même commande, une seule fois ; une 2e exécution redemande.
- [ ] **G5** 4 yeux strict : une demande créée par toi n'est pas validable par toi (bouton absent / refus), même admin.
- [ ] **G6** ACL de connexion « validation » sur `lab-linux2` pour le 2e compte : connexion en attente, puis ouverte après validation pendant `CONNECT_GRANT_MINUTES`.
- [ ] **G7** ACL de connexion par horaires (plage qui exclut l'heure actuelle) : refus avec le nom de la règle.
- [ ] **G8** Demande d'accès temporaire (2e compte) sur `lab-linux2` pour 1 h ; validée, une règle « Demande #N » apparaît ; l'annuler avant terme.
- [ ] **G9** Notifications : canal e-mail ou Teams ou webhook (Paramètres > Notifications), bouton Tester, puis recevoir une vraie alerte (G3).

## 7. Audit

- [ ] **AU1 [E]** Sessions en direct (2 navigateurs) : une session du 2e compte visible ; Observer : flux en lecture seule, l'utilisateur voit « Cette session est observée » ; Terminer avec un motif : fermeture côté utilisateur, notification `session.killed`.
- [ ] **AU2 [E]** Enregistrements : rejouer une session SSH (vitesses, pause), une session RDP, vérifier l'intégrité (SHA-256 OK).
- [ ] **AU3** Altérer un fichier d'enregistrement local (`data/recordings/...`) puis Vérifier / rejouer : « altéré » signalé, pas de lecture silencieuse.
- [ ] **AU4** Sélectionner plusieurs sessions > Télécharger : ZIP avec `.cast` (lire avec `asciinema play`), `.guac` pour le RDP, `manifest.csv` (statut d'intégrité par fichier).
- [ ] **AU5** Journal des commandes : filtres, lien vers l'instant de l'enregistrement, export CSV.
- [ ] **AU6** Paramètres > Audit : stockage S3 ou Azure (si disponible) + Tester ; rétention ; cible SIEM (syslog ou HEC) + Tester, curseur.
- [ ] **AU7 [E]** Audit > Rapports : utilisateurs, serveurs, comptes sur 30 jours ; Imprimer / PDF (seul le rapport, en clair, paysage) ; CSV.
- [ ] **AU8** Audit > Risques : Analyser maintenant ; attendus au minimum « Compte à privilèges sans rotation : deploy », « Clé d'accès sans expiration » si tu en as une ; ignorer avec une raison (admin), lien Ouvrir vers l'objet.

## 8. Opérations

- [ ] **O1 [E]** Fiche `lab-linux` > Fichiers : parcourir, envoyer un fichier (refus d'écraser sans case cochée), télécharger, renommer, créer un dossier, supprimer un dossier vide (refus si non vide). Audit : SHA-256 de chaque transfert.
- [ ] **O2 [E]** Tâches > Nouvelle tâche « commande » `uptime` sur l'étiquette `env=labo` : aperçu des cibles, exécution parallèle, sortie par serveur. Avec la règle « validation » de G4 : serveur ignoré avec la raison.
- [ ] **O3** Playbook (admin) `hosts: all` avec une variable par défaut ; lancement : journal Ansible en direct, résultat par serveur.
- [ ] **O4 (API)** Variables refusées : `ansible_connection=local`, `{{ lookup(...) }}`, une variable non déclarée (operator). Attendu : 400 avec la raison.
- [ ] **O5 [E]** Zone `Isolée` (préparée en P8 à P11) : sur `lab-isolated`, terminal, commande (Tâches) et fichiers fonctionnent à travers la passerelle. Désactiver la passerelle `lab-gw` : tout échoue avec un message clair ; la réactiver.
- [ ] **O6** Mises à jour : scanner `lab-linux` ; appliquer un paquet (`less`). (API) Nom de paquet `vim; id` : 400. Règle de commandes « validation » sur `system-update` : l'application part en validation.
- [ ] **O7** Azure (si un compte de service de test existe) : synchro, groupes de ressources en sous-nœuds, étiquettes ; option « revue des nouvelles VM » : VM dans Infrastructure > VM à valider, importer / ignorer / remettre à valider.

## 9. Paramètres et administration

- [ ] **AD1** Utilisateurs : changer le rôle du 2e compte (viewer, operator), le désactiver : accès coupé immédiatement. Tenter de rétrograder le dernier admin : refusé.
- [ ] **AD2** Paramètres > Certificats : durées min / max / par défaut appliquées à la connexion `@USER`.
- [ ] **AD3** Cloche : notifications lues / non lues, liens vers l'objet.
- [ ] **AD4** Thème clair / sombre, mouvement réduit (préférence système) respecté.

## 10. Lot 7

### 10.1 Proxy SSH
- [ ] **PX1 [E]** Mon compte > Accès SSH : ajouter ta clé publique (`~/.ssh/id_ed25519.pub`). `ssh -p 2222 'ton.email'@localhost` : vérifier l'empreinte de la clé d'hôte affichée dans Mon compte, puis menu des serveurs, choix du numéro, filtre par texte.
- [ ] **PX2 [E]** `ssh -p 2222 'ton.email#lab-linux'@localhost` : compte par défaut sans question ; `ssh -p 2222 'ton.email#alice#lab-linux'@localhost` : compte précis.
- [ ] **PX3** Jeton de connexion (15 min) : affiché une fois ; connexion avec ce mot de passe ; révoquer : refusé.
- [ ] **PX4** `ssh -p 2222 'ton.email#lab-linux'@localhost id` (exec) et `sftp -P 2222 ...` : refusés avec message.
- [ ] **PX5** Dans une session proxy : `rm -rf /` bloqué, session dans Sessions en direct, enregistrement rejouable, journal des commandes source `terminal`.
- [ ] **PX6** Audit > Connexions : connexions méthode `ssh` ; une seule ligne « réussie » par connexion par clé ; une clé inconnue ou un jeton faux : refus.

### 10.2 Masquage
- [ ] **MA1 [E]** Paramètres > Masquage : ajouter le modèle « Mot de passe affiché », Essayer sur `password=abc`. Dans un terminal : `echo password=hunter2` affiche `password=********` ; le journal des commandes et l'enregistrement aussi.
- [ ] **MA2** Logs Kubernetes du pod `worker` (namespace `demo`) : `password=` et `Bearer` masqués (avec le modèle « Jeton Bearer »).

### 10.3 Modèles et push de comptes
- [ ] **PU1 [E]** Infrastructure > Modèles de comptes : « ops » (`citops`, mot de passe, sudo sans mot de passe, groupe `docker`). Pousser sur `env=labo` : tâche « Push de compte », succès par serveur ; dans le conteneur : `id citops`, `/etc/sudoers.d/citadel-citops`.
- [ ] **PU2** Modèle « clé » (`citkey`, clé SSH) : compte non verrouillé (`getent shadow citkey` = `*`), clé dans `authorized_keys`, compte vérifié dans Citadel.
- [ ] **PU3** Repousser sans « mettre à jour » : ignoré ; avec : nouveau secret.
- [ ] **PU4 (API)** `lab-auditor` / un rôle `secrets` : créer ou pousser un modèle avec sudo : 403 (réservé aux admins) ; modèle sans privilège : autorisé.

### 10.4 Sauvegarde des comptes
- [ ] **BK1 [E]** Paramètres > Sauvegardes : phrase de passe (16 caractères minimum, avertissement), Sauvegarder maintenant > téléchargement `.cab`.
- [ ] **BK2** Relire : `docker compose cp citadel-comptes-*.cab backend:/tmp/b.cab && docker compose exec backend python -m app.cli backup-decrypt /tmp/b.cab` : tous les comptes et secrets ; mauvaise phrase : « Wrong passphrase or altered file ».
- [ ] **BK3** Destination stockage, puis e-mail (si canal e-mail) ; planification `backup_interval_days=1` ; historique (statut, SHA-256).

### 10.5 Applications
- [ ] **AP1 [E]** Paramètres > Applications : « ci » sur l'étiquette `env=labo`, compte `citops`, IP `127.0.0.1/32` ou ton IP ; clé affichée une fois. `curl -H "Authorization: Bearer cap_..." "http://localhost:8010/api/app/v1/secret?server=lab-linux&account=citops"` : secret renvoyé.
- [ ] **AP2** Compte hors portée (`deploy`) : 403 ; IP hors liste : 403 ; mauvaise clé : 401 ; chaque lecture et refus dans le journal d'audit `app.secret_read`.
- [ ] **AP3** Régénérer la clé : l'ancienne ne marche plus.

### 10.6 Rôles personnalisés
- [ ] **RO1 [E]** Paramètres > Rôles : « Auditeur » (`audit`) ; l'attribuer au 2e compte (viewer). Attendu : menus Sessions en direct, Connexions, Rapports, Risques visibles ; tout l'inventaire visible mais aucune connexion possible ; Paramètres absent.
- [ ] **RO2** Ajouter `sessions` : bouton Terminer disponible. Retirer le rôle : menus disparus.
- [ ] **RO3 (API)** Avec la clé `lab-auditor` : `GET /api/reports/users` 200 ; `GET /api/access-policies` 403 ; `GET /api/applications` 403 ; `PATCH /api/admin/users/<lui-même>` avec `{"role":"admin"}` 403.

## 11. Kubernetes

- [ ] **K1 [E]** Kubernetes > Ajouter : `lab-k3s`, `https://lab-k3s:6443`, CA et jeton depuis `data/lab/`. Tester : version v1.31, 8 espaces de noms (dont `demo`, `prod`, `team-a`).
- [ ] **K2** Modifier l'URL sans ressaisir le jeton : refusé avec message ; avec le jeton : accepté.
- [ ] **K3 [E]** Cluster > `demo` : pods (état, prêts, redémarrages), charges, événements ; `prod` : `broken` en erreur d'image (`ErrImagePull`), visible dans les événements.
- [ ] **K4 [E]** Logs d'un pod `web` puis du `worker` (100 / 500 lignes, instance précédente, copier, télécharger).
- [ ] **K5 [E]** Shell dans un pod `web` : réauthentification, `ls`, `rm -rf /` bloqué ; session « Kubernetes » en direct puis rejouable ; journal des commandes avec `cluster/ns/pod/conteneur`.
- [ ] **K6** Mettre `api` (prod) à 1 réplique, redémarrer `web`, redémarrer un pod (confirmation qui explique la recréation).
- [ ] **K7 [E]** Règles d'accès Kubernetes pour le 2e compte : R1 « shell et gérer sur `team-*` », R2 « voir sur `*` ». Attendu : en `team-a`, boutons Shell / Redémarrer présents ; en `prod`, uniquement la lecture (pas de logs, pas de shell, pas d'action) ; (API) actions refusées en 403.
- [ ] **K8** 2e compte viewer avec une règle `exec` : pas de shell (plafond viewer).
- [ ] **K9** ACL de commandes par étiquette `k8s_namespace=prod` : appliquée aux shells de `prod` uniquement ; une règle « validation » qui correspond : refus (pas de 4 yeux en Kubernetes).

## 12. Non-régression sécurité (revues du 25/11)

- [ ] **R1** (API, operator avec `execute`) `POST /api/servers/{id}/updates/apply` `{"packages":["vim; id"]}` : 400 (injection fermée).
- [ ] **R2** Tâche lancée hors de la plage IP autorisée par une ACL de connexion : serveur ignoré (l'IP du lanceur est prise en compte).
- [ ] **R3** Synchro Azure : une étiquette posée dans Citadel n'est pas écrasée par un tag Azure du même nom.
- [ ] **R4** Kubernetes : R1/R2 du test K7 (règles non mélangées).
- [ ] **R5** Proxy SSH : présenter la clé publique d'un autre utilisateur sans la clé privée (`ssh -o IdentitiesOnly=yes -i <clé publique seule>`) : refus, aucune connexion « réussie » journalisée à son nom.
- [ ] **R6** Rôle `kubernetes` non-admin : changer l'URL d'un cluster sans jeton : refusé.

## 13. Fin de recette

```bash
scripts/test-lab.sh down     # cibles, réseau isolé, data/lab, utilisateurs de test
```

Puis dans Citadel : supprimer les serveurs `lab-*`, le cluster `lab-k3s`, les modèles, applications et règles de test, ou les garder pour la prochaine recette.

| Bloc | Tests | OK | KO | Remarques |
|---|---|---|---|---|
| 1 Connexion | 7 | | | |
| 2 Inventaire | 4 | | | |
| 3 Comptes | 6 | | | |
| 4 Droits | 8 | | | |
| 5 Sessions | 5 | | | |
| 6 Gouvernance | 9 | | | |
| 7 Audit | 8 | | | |
| 8 Opérations | 7 | | | |
| 9 Administration | 4 | | | |
| 10 Lot 7 | 19 | | | |
| 11 Kubernetes | 9 | | | |
| 12 Non-régression | 6 | | | |
