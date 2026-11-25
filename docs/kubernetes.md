# Kubernetes (lot 8)

Citadel donne accès aux clusters Kubernetes comme aux serveurs : chacun ne voit que les espaces de noms qui lui sont accordés, chaque action est tracée, et un shell dans un conteneur passe par les mêmes contrôles qu'un terminal SSH.

## Ajouter un cluster

1. Sur le cluster, créer le compte de service de Citadel avec les droits minimaux :
   ```bash
   kubectl apply -f deploy/kubernetes/citadel-rbac.yaml
   kubectl -n citadel-system get secret citadel-token -o jsonpath='{.data.token}' | base64 -d     # jeton
   kubectl -n citadel-system get secret citadel-token -o jsonpath='{.data.ca\.crt}' | base64 -d   # CA (PEM)
   ```
   Le fichier donne la lecture (espaces de noms, pods, logs, événements, charges), `pods/exec`, la suppression de pods et le patch des charges (mise à l'échelle, redémarrage). Retirer les règles d'une fonction qu'on ne veut pas offrir : Kubernetes refusera alors l'opération même si une règle Citadel l'accorde.
2. Kubernetes > Clusters > Ajouter : URL de l'API (`https://hote:6443`), CA (recommandé ; sinon les CA du système), jeton (chiffré dans le coffre, jamais réaffiché), nœud, zone, étiquettes. « Tester » vérifie la version et la lecture des espaces de noms.
   - Dans une **zone**, l'API est jointe par la passerelle SSH (redirection de port), le certificat est toujours vérifié avec le vrai nom de l'API.
   - « Ignorer la vérification TLS » existe pour un laboratoire ; à éviter.
   - Changer l'URL, la CA, la vérification TLS ou la zone d'un cluster exige de **ressaisir le jeton** : le jeton enregistré n'est jamais envoyé ailleurs que là où il a été saisi.

Gestion des clusters et des règles : admins, ou rôle personnalisé avec la permission `kubernetes`.

## Règles d'accès Kubernetes

Une règle donne à des utilisateurs ou groupes, sur des clusters, des **espaces de noms** (noms exacts ou motifs : `team-*`, `*` pour tous) et des **actions** :

| Action | Permet |
|---|---|
| `view` | lister espaces de noms, pods, charges (deployments, statefulsets, daemonsets), événements |
| `logs` | lire les logs d'un conteneur (dernières lignes, instance précédente) |
| `exec` | ouvrir un shell dans un conteneur |
| `manage` | redémarrer un pod (suppression), mettre à l'échelle, redémarrer une charge (rollout restart) |

Chaque règle est évaluée **à part** : une action n'est permise dans un espace de noms que si une même règle donne les deux. « exec et manage sur `dev` » plus « view sur `*` » donnent la lecture partout, mais le shell et les actions seulement dans `dev`. L'écran d'un cluster affiche les boutons selon les droits de l'espace de noms choisi.

Le rôle plafonne comme pour les serveurs : un viewer n'a jamais que `view` et `logs`. Validité dans le temps possible. Un cluster ou un espace de noms non accordé répond 404.

## Shell dans un conteneur

Kubernetes > cluster > pod > Shell. Comme pour un terminal SSH, une réauthentification Entra (MFA par l'accès conditionnel) est demandée au clic. Même chaîne que le terminal SSH (`services/terminal_core.py`) :
- règle de connexion à Citadel puis ACL de connexion ;
- ACL de commandes ligne par ligne ;
- masquage des données ;
- enregistrement (protocole `k8s`, relisible comme une session SSH) ;
- journal des commandes ;
- observation en direct et arrêt par un admin.

Pour les ACL, la cible porte les étiquettes du cluster plus `k8s_cluster=<nom>` et `k8s_namespace=<espace>`, et son nœud. Une règle par étiquette (`k8s_namespace=prod`) ou par nœud s'applique donc ; une règle qui ne liste que des serveurs ne s'applique pas.

**Pas de validation à 4 yeux pour Kubernetes** : une règle « validation » qui correspond à un shell ou à une commande dans un conteneur **refuse**. Les demandes de validation désignent un serveur.

Le shell lance `bash` s'il existe, sinon `sh`. Le journal Kubernetes de l'API (`pods/exec`) montre le compte de service de Citadel : c'est le journal de Citadel qui dit qui l'a ouvert.

## Logs et actions

- Les logs passent par le masquage des données, chaque lecture est tracée (`k8s.logs`).
- Redémarrer un pod (`k8s.pod.delete`), mettre à l'échelle (`k8s.scale`), redémarrer une charge (`k8s.restart`, annotation `kubectl.kubernetes.io/restartedAt`) : tracés avec le résultat, y compris les refus de Kubernetes.

## Limites

- Pas d'édition de manifestes, pas d'`apply`, pas de port-forward : Citadel n'est pas un client Kubernetes complet.
- Un jeton par cluster (celui de Citadel). L'identité Kubernetes des personnes n'est pas utilisée (pas d'impersonation).
