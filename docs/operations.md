# Opérations (lot 5)

Transfert de fichiers, commandes sur plusieurs serveurs, playbooks Ansible, passerelles vers les réseaux isolés, import des VM Azure.

## Transfert de fichiers (SFTP)

- Serveurs Linux, depuis la fiche serveur : parcourir, télécharger, envoyer, créer un dossier, renommer, supprimer (fichier ou dossier **vide** seulement).
- Deux droits dans les règles d'accès : `download` (parcourir et télécharger) et `upload` (envoyer, créer, renommer, supprimer). Les ACL de connexion s'appliquent comme pour un terminal.
- Les opérations tournent avec le compte choisi (compte réel ou `@USER` en certificat ; `@INPUT` n'est pas proposé) : les droits du système de fichiers de ce compte s'appliquent, rien de plus.
- Chaque transfert est tracé dans l'audit avec la taille et le **SHA-256** du contenu (`file.upload`, `file.download`, `file.mkdir`, `file.rename`, `file.delete`), y compris les échecs. Taille maximale : paramètre `max_transfer_mb` (500 Mo par défaut). Un envoi n'écrase un fichier existant que sur demande explicite.

## Tâches sur plusieurs serveurs

Sélection des cibles par serveurs, nœuds (avec sous-nœuds) ou étiquettes ; aperçu avant lancement (serveurs exclus et pourquoi). Compte : celui par défaut de chaque serveur, ou un nom de compte précis. Parallélisme et délai réglables.

### Commande

Chaque serveur est traité comme une commande interactive : droit `execute`, ACL de connexion, ACL de commandes. L'IP source évaluée est celle de la personne qui a lancé la tâche (enregistrée avec la tâche), aussi pour les playbooks. Une règle « alerter » laisse passer et notifie ; « refuser » ou « validation » **ignore ce serveur** avec la raison (pas de validation groupée). Sortie, code retour et décision par serveur ; chaque exécution entre dans le journal des commandes (source `job`).

### Playbook Ansible

- Playbooks stockés dans Citadel (YAML, `hosts: all`), avec variables par défaut ; création et modification **réservées aux admins**.
- Lancement : droit `execute` sur chaque cible. Les ACL de commandes **ne s'appliquent pas** au contenu d'un playbook (d'où la restriction aux admins pour l'écrire).
- Variables passées au lancement : un opérateur ne peut remplacer que les variables par défaut déclarées dans le playbook. Pour tout le monde, les variables d'Ansible (`ansible_*`, `hostvars`, `become`...) et toute syntaxe de modèle (`{{`, `{%`) sont refusées, et les valeurs sont écrites `!unsafe` (jamais évaluées). Sans cela, une variable comme `ansible_connection=local` ou `ansible_host=<autre machine>` ferait exécuter le playbook sur le bastion ou enverrait les identifiants ailleurs. Le processus Ansible ne reçoit qu'un environnement minimal.
- Citadel génère un inventaire temporaire (dossier `0700`, supprimé à la fin) avec le compte de chaque serveur : mot de passe (via `sshpass`), clé, ou certificat éphémère signé pour 2 h. Serveurs Windows en WinRM (NTLM) : les modules `ansible.windows` ne sont pas inclus dans ansible-core, utiliser `ansible.builtin.raw` ou installer la collection.
- Journal Ansible en direct, résultat par serveur d'après le récapitulatif. Une ligne `ansible-playbook <nom>` par serveur dans le journal des commandes (source `playbook`).

Une tâche en cours au moment d'un redémarrage du backend est marquée en échec au démarrage suivant.

## Zones et passerelles

Une **zone** regroupe des serveurs joignables uniquement par des **passerelles SSH** (rebond). Une zone peut avoir plusieurs passerelles, essayées par priorité croissante (bascule automatique). Compte de la passerelle : identifiant enregistré ou certificat éphémère.

Tout passe par la passerelle sans réglage supplémentaire : terminal SSH (rebond asyncssh), RDP et WinRM (redirection de port ouverte pour la durée de la session), commandes, monitoring, mises à jour, rotation et vérification des comptes, collecte, fichiers, tâches et playbooks. Bouton « Tester » par passerelle.

Pour le RDP, guacd joint une redirection ouverte par le backend sur le réseau interne compose (`BACKEND_INTERNAL_HOST`, `backend` par défaut), fermée à la fin de la session.

Prérequis côté passerelle : `AllowTcpForwarding yes` dans `sshd_config`.

## Import Azure

- Principal de service avec le rôle **Lecteur** sur les abonnements, secret chiffré dans le coffre.
- Les VM deviennent des serveurs (IP privée, ou publique en option), sous le nœud choisi, dans un sous-nœud par groupe de ressources, dans la zone choisie. Étiquettes Azure reprises, plus `cloud=azure`, `azure_rg`, `azure_location`, `azure_power`. Aux synchronisations suivantes, seules les **nouvelles** clés Azure sont ajoutées : une étiquette déjà présente dans Citadel garde sa valeur, car les étiquettes pilotent les règles d'accès et les ACL (modifier un tag dans Azure ne doit pas ouvrir un accès dans Citadel). Les quatre clés ci-dessus suivent toujours Azure.
- Synchronisation toutes les N minutes (60 par défaut) ou à la demande. Une VM supprimée côté Azure est marquée « disparue », jamais supprimée de Citadel. Les VM importées n'ont pas de compte : un admin en ajoute un.
- Option « seulement les VM démarrées » pour ne pas importer les VM désallouées.
- Option **« revue des nouvelles VM »** : une nouvelle VM n'est pas importée, elle attend dans Infrastructure > Cloud > À valider (notification `cloud.pending` aux admins). Importer la crée comme une synchro normale ; ignorer la garde ignorée aux synchros suivantes (réversible).

## Proxy SSH (lot 7)

Se connecter aux serveurs Linux accordés avec **son propre client SSH**, avec les mêmes contrôles que le terminal web (règle de connexion à Citadel, règles d'accès, ACL de connexion, ACL de commandes ligne par ligne, enregistrement, observation et arrêt par un admin, masquage).

```
ssh -p 2222 'prenom.nom@domaine.ch'@citadel                 menu des serveurs
ssh -p 2222 'prenom.nom@domaine.ch#web-01'@citadel          compte par défaut
ssh -p 2222 'prenom.nom@domaine.ch#root#web-01'@citadel     compte précis
```

- Identifiant : l'e-mail, ou sa partie avant `@` si elle est unique.
- **Menu interactif** (sans serveur dans l'identifiant) : flèches haut / bas (ou Ctrl+P / Ctrl+N), Page haut / bas, Début / Fin, frappe directe pour filtrer (sans tenir compte des majuscules ni des accents, plusieurs mots possibles : `labo app`), Entrée pour choisir, Échap pour effacer le filtre puis revenir (des comptes à la liste des serveurs), Ctrl+C pour quitter. Chaque serveur affiche son adresse, son nœud et ses étiquettes ; le menu s'ouvre sur un écran séparé, le terminal est restauré à la connexion.
- **Kubernetes** : le menu liste aussi les clusters où vous pouvez ouvrir un shell (règle Kubernetes avec `exec`), puis l'espace de noms (seulement ceux où le shell est accordé), le pod (en cours d'exécution) et le conteneur s'il y en a plusieurs ; Échap remonte d'un niveau. Accès direct : `ssh -l '<login>#k8s/<cluster>/<espace de noms>/<pod>[/<conteneur>]' citadel`. Mêmes contrôles que le shell de l'interface (ACL de connexion et de commandes, masquage, enregistrement `k8s`, observation, arrêt).
- Raccourci conseillé dans `~/.ssh/config` : `Host citadel`, `HostName <hôte>`, `Port 2222`, `User <e-mail>`, `IdentityFile ~/.ssh/citadel_ed25519`, puis `ssh citadel`.
- Authentification, à préparer dans Mon compte > Accès SSH :
  - **clé publique** (ed25519 conseillée, RSA 3072 bits au moins) ;
  - **jeton de connexion** : un mot de passe affiché une seule fois, valable de 1 minute à 24 heures, réutilisable jusqu'à son expiration, révocable.
- Chaque connexion entre dans le journal des connexions (méthode `ssh`), réussie ou refusée. Pour une clé, la réussite n'est enregistrée qu'après la vérification de la signature (le client SSH « présente » d'abord ses clés publiques sans rien prouver).
- Un nom de serveur ambigu (plusieurs serveurs du même nom) affiche le menu filtré.
- Volontairement absent : exécution directe (`ssh host commande`), SFTP/SCP, redirection de ports, transfert d'agent. Seul un shell interactif est ouvert.
- Clé d'hôte : générée au premier démarrage, chiffrée dans le coffre (paramètre interne). Son empreinte est affichée dans Mon compte, à vérifier à la première connexion.
- Configuration : `SSH_PROXY_ENABLED` (vrai par défaut), `SSH_PROXY_PORT` (2222), `SSH_PROXY_PUBLIC_HOST` (nom affiché, sinon l'hôte de `PUBLIC_URL`). En production, le port 2222 est publié par le conteneur backend.
- L'authentification forte Entra ne s'applique pas au proxy : protéger les clés privées par une phrase de passe et restreindre si besoin les IP par une règle de connexion `login`.

Le RDP natif (`.rdp` pour mstsc) n'est pas proposé : il faudrait un proxy RDP complet, hors de portée ; le RDP reste dans le navigateur.

## Modèles et push de comptes (lot 7)

Comptes > Modèles : un modèle décrit un compte système (nom, Linux / Windows / les deux, type de secret, privilégié, sudo, groupes, rotation). « Pousser » le crée sur une sélection de serveurs (serveurs, nœuds, étiquettes), en tâche (suivi dans Tâches).

Sur chaque serveur, avec son compte par défaut (qui doit avoir les droits root / administrateur) :
- **Linux** : `useradd` si absent, groupes, secret, règle sudo dans `/etc/sudoers.d/citadel-<nom>` vérifiée par `visudo` avant d'être activée (supprimée si le modèle n'a pas de sudo).
  - mot de passe : généré (24 caractères par défaut), posé par `chpasswd` via l'entrée standard ;
  - clé SSH : paire ed25519 générée, clé publique ajoutée à `authorized_keys` ;
  - certificat : aucun secret, Citadel signe des certificats éphémères (le serveur doit faire confiance à la CA, voir docs/vault.md).
  - Pour les clés et certificats, le mot de passe du compte est mis à `*` (aucun mot de passe, compte non verrouillé : un compte verrouillé `!` est refusé par sshd même avec une clé quand PAM est désactivé).
- **Windows** : compte local (`New-LocalUser` / `Set-LocalUser`), mot de passe uniquement, groupes locaux (par exemple `Administrators`, `Remote Desktop Users`).
- Puis Citadel **vérifie la connexion avec le nouveau secret** avant d'enregistrer le compte (identifiant dédié, chiffré dans le coffre). Le secret n'est jamais affiché.

Un modèle qui **donne des privilèges** (sudo, groupes, compte à privilèges) ne peut être créé, modifié ni poussé que par un admin : le pousser revient à se donner root sur les cibles. La permission `secrets` suffit pour les modèles sans privilège.

Un compte déjà géré par Citadel sur un serveur est ignoré, sauf avec « mettre à jour » (nouveau secret). Noms système refusés (`root`, `administrator`...).
