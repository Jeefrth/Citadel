# Design de Citadel : « Salle de contrôle »

Outil d'administration ouvert toute la journée à côté des terminaux, par des admins infra. Il doit être dense, calme et lisible. **La couleur ne sert qu'à porter un état.**

## Jetons (`frontend/tailwind.config.js`, `frontend/src/index.css`)

| Rôle | Sombre (défaut) | Clair | Classes |
|---|---|---|---|
| Fond | Nuit `#0E1525` | `#F4F6FA` | `bg-background` |
| Surfaces | Ardoise `#1A2336` | blanc | `bg-card`, `bg-raised`, `bg-muted` |
| Texte | `#E6EBF5` | Nuit | `text-foreground` |
| Texte secondaire | Brume `#8A97B0` | `#5B6781` | `text-muted-foreground` |
| En direct, alerte, en attente | Ambre `#F2A93B` | `#B7791F` | `text-live`, `bg-live/10`, `border-live/30` |
| Autorisé, succès, en ligne | Vert `#3DD68C` | `#1F9D62` | `success` |
| Refusé, erreur, hors ligne | Rouge `#F0526B` | `#D1344F` | `danger` (`destructive` pour les boutons) |
| Information neutre | `#7AA2F7` | `#3A6FD8` | `info` |

Action principale : bouton `default` (clair sur nuit en sombre, nuit sur clair en clair). **Jamais de bleu « SaaS » comme couleur d'action.**

**Interdit** : les couleurs Tailwind codées en dur (`bg-red-50`, `text-green-700`, `bg-blue-100`, `text-amber-800`, `bg-white`, `bg-gray-*`...). Elles cassent le thème sombre. Utiliser les jetons ci-dessus, avec des opacités de l'échelle (`/5 /10 /15 /20 /25 /30 /40 /50`). `/12` ou `/8` ne génèrent rien.

## Typographie

- **Hanken Grotesk** pour toute l'interface (classe `font-sans`, par défaut).
- **JetBrains Mono** (`font-mono`) **uniquement** pour les valeurs techniques : hôtes, IP, ports, comptes, commandes, empreintes, identifiants de session, extraits de terminal.
- Échelle dense : `text-xs` 12, `text-sm` 13, `text-base` 14 (corps), `text-lg` 16, `text-xl` 20 (titres de section), `text-2xl` 24 (titre de page, `font-semibold tracking-tight`).
- **Pas de MAJUSCULES** pour les intitulés, en-têtes de tableau ou étiquettes. Pas de `uppercase`, pas de `tracking-wider`. Phrase normale.
- Nombres alignés : `tabular` (utilitaire maison) dans les tableaux et compteurs.

## Mise en page

- Coquille commune (`components/Layout.tsx`) : barre latérale shadcn groupée (Exploitation, Gouvernance, Audit, Administration), en-tête avec fil d'Ariane, indicateur « en direct », Cmd+K, notifications. Les pages n'ont **pas** à répéter le nom de l'application.
- En-tête de page : `PageHeader` = titre (`text-2xl font-semibold tracking-tight`) + une phrase qui dit à quoi sert la page (`text-muted-foreground`) + actions à droite. Pas d'eyebrow au-dessus du titre.
- Tableaux plutôt que grilles de cartes pour les listes d'objets (serveurs, règles, commandes, enregistrements) : c'est un outil de travail. Composant `Table` shadcn, en-têtes en casse normale, lignes de 40 à 44 px, survol `hover:bg-muted/50`.
- Cartes (`Card`) seulement pour regrouper des réglages ou un bloc d'information autonome. Pas de cartes identiques en rang pour décorer.
- Rayon : `rounded-md` pour les contrôles, `rounded-lg` pour les cartes et fenêtres. Pas d'ombres décoratives (`shadow-sm` au plus sur les éléments flottants).
- Bordures `border` fines pour structurer. Pas de dégradés.

## États vides et erreurs

- État vide : une phrase qui dit quoi faire et un bouton qui le fait (« Ajoutez un premier serveur pour commencer. » + « Ajouter un serveur »). Icône discrète en `text-muted-foreground`.
- Erreur : ce qui s'est passé et comment corriger, sans excuses. `ErrorBox` ou `Notice` du kit.
- Chargement : `Skeleton` shadcn sur la forme du contenu, pas de spinner plein écran.

## Mouvement (motion.dev : `import { motion, AnimatePresence } from "motion/react"`)

Seulement **en réponse à une action** :
- ouverture et fermeture de fenêtres et panneaux (déjà gérées par Dialog, Sheet, Dropdown shadcn) ;
- éléments de liste qui apparaissent ou disparaissent après une action (validation approuvée, règle supprimée, notification lue) : `AnimatePresence` + `motion.div layout`, sortie en hauteur et opacité ;
- indicateurs qui glissent (`layoutId`) : onglets, navigation (déjà faits dans le kit et la barre latérale) ;
- confirmation d'un changement de valeur (compteur qui change).

Durées de 0,15 à 0,25 s, ressort `stiffness 500, damping 40` pour les indicateurs. **Pas** d'animation d'entrée sur chaque section ou carte au chargement, **pas** d'effet de survol sur chaque carte, **pas** de boucle sauf le pouls « en direct » (réservé à l'état en direct). `MotionConfig reducedMotion="user"` est déjà global.

## Composants disponibles

- shadcn (`@/components/ui/*`) : alert, avatar, badge, breadcrumb, button, card, checkbox, collapsible, command, dialog, dropdown-menu, input, label, popover, progress, scroll-area, select, separator, sheet, sidebar, skeleton, sonner (`toast` de `sonner` pour les confirmations brèves), switch, table, tabs, textarea, tooltip.
- Kit Citadel (`@/components/kit`) : Modal, ConfirmModal, Field, SaveButton, Chip (tons : default, primary, amber = en direct ou en attente, orange = alerte, green, red, blue), LabelChips, LabelEditor, MultiSelect, Tabs (soulignement animé), Notice, ErrorBox, Toggle, formatDate, classes `btnPrimary`, `btnSecondary`, `iconBtn`, `iconBtnDanger`, `inputCls`.
- Icônes : lucide-react, `size-4` dans les boutons et `size-3.5` dans le texte dense.

## Rédaction

Phrases courtes, verbes d'action, casse de phrase. Un bouton dit ce qu'il fait (« Approuver », « Ouvrir une session », « Enregistrer la règle »), et le message de confirmation reprend le même verbe (« Règle enregistrée »). Pas de tirets longs (— ou –) dans l'interface.


## Raccourci de recherche

La palette de recherche s'ouvre par défaut avec Cmd+K (Ctrl+K hors macOS). Chacun peut le changer dans Mon compte > Raccourci de recherche : modèles (Cmd+Maj+K, « / », Ctrl+Espace, Cmd+P) ou combinaison enregistrée en l'appuyant. Le choix est gardé dans le navigateur (`localStorage`, clé `citadel.shortcut.palette`) et l'indication de la barre du haut le suit. « / » et les touches sans modificateur ne se déclenchent pas pendant la saisie (champs, terminal) ; une lettre ou un chiffre seul est refusé à l'enregistrement.
