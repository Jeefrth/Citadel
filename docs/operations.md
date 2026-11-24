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
