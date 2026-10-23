# Validation macOS 0.1.2 — 23 octobre 2026

Mise à jour depuis `b2659f9`, DMG Apple Silicon autonome, macOS 14 minimum.

## Corrections faites pendant la validation

- Sur Mac, Ctrl-clic retirait la clé du groupe avant d'ouvrir le menu contextuel :
  le menu perdait alors la sélection multiple. Le geste laisse maintenant le menu
  conserver le groupe. Reproduit puis vérifié avec huit clés dans Chrome.
- Annuler un déplacement perdait la sélection, car les clés étaient recherchées
  à leur nouvel instant dans l'ancien état. Une mémoire de sélection par état
  d'historique restaure les instants et les clés choisies. Vérifié sur quatre clés.
  Cette mémoire reste locale, bornée, et ne modifie pas les fichiers des planches.

## Vérifié dans Chrome

- Vidéo visible et découpée dans sa case penchée en Animate framing.
- Cmd+A : toutes les clés choisies, sans sélection de texte ; Cmd+D : duplication
  de quatre à huit clés sans ouvrir les signets ; Cmd+Z et Cmd+Maj+Z : quatre puis huit.
- Clic droit : huit clés conservées et menu complet ; Ctrl-clic : huit conservées après correction.
- Courbes fortes depuis le menu et la liste ; Cmd+Z avec la liste ayant le focus.
  Une nouvelle modification après annulation revient au bon état lors du Cmd+Z suivant.
- Copier/coller depuis le menu : huit clés ajoutées (seize au total). Le raccourci
  Cmd+V n'est pas validé : l'outil de contrôle intercepte le presse-papiers.
- Suppression puis annulation ; rectangle sur deux lignes : quatre clés choisies,
  aucun texte sélectionné ; déplacement groupé ; sélection et historique encore
  présents après les enregistrements automatiques. Annulation du déplacement avec
  les quatre clés restaurées à leurs instants d'origine après le second correctif.
- Comparaison du lecteur/export sur la planche animée, courbes `ease2` et `in2`,
  flou, grain, halation, N&B, 720p à 25 images/s : écarts moyens 0,232/255 à t=0,
  0,172/255 à t=1 et 0,240/255 à t=1,8. 99 % des pixels sous 2 à 3/255.

## Bundle et installation

- DMG monté, application copiée dans `/Applications/Alive Video.app` ; signature ad hoc vérifiée.
- Lanceur du Bureau : lien vers l'application installée, sans script ni Terminal.
- Ancienne instance arrêtée après contrôle qu'aucun export n'était actif ;
  démarrage par le lanceur, réponse `/api/info` = 0.1.2 avec FFmpeg disponible.
- Test du bundle installé : import vidéo et son, effets, courbes fortes, trois
  exports animés H.264/AAC 720 × 720, 25 images/s, deux secondes ; décodage intégral.
  Dossier de la planche, dossier avec espaces/accents/guillemets, dossier des Réglages,
  conservation du choix et téléchargement depuis l'historique vérifiés.
- Les tests utilisent des données isolées ; leurs planches sont mises à la corbeille
  via l'API. Les données de Documents/Alive Video sont conservées.

## Non validé

Safari, vidéo dans le `foreignObject` sous WebKit, geste physique à deux doigts,
lecture QuickTime, vrai dialogue Parcourir et ouverture Finder. Le contrôle natif
des applications a expiré lors des essais précédents de cette session ; les tests
ont donc été faits dans Chrome, et la limite n'est pas présentée comme une validation Safari.
Les calculs d'effets et d'interpolation n'ont pas été modifiés.
