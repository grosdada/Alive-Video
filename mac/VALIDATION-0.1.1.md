# Validation macOS 0.1.1 — 23 octobre 2026

DMG Apple Silicon, macOS 14 minimum, fabriqué avec `mac/build_dmg.sh`.
La signature ad hoc, l'intégrité du DMG et la copie de l'application depuis
le DMG monté ont été vérifiées. Aucun prérequis Python ou Homebrew à l'exécution.

## Vérifié

- Sur l'instance isolée de développement (8793), dans Chrome : création d'une
  planche `zz-…`, apparition des icônes avec Edit, disparition avec Animate framing.
- Déplacement d'une attache : clé enregistrée ; seconde clé à un autre instant ;
  déplacement du losange de 2,03 à 2,53 secondes ; lecture et pause avec Espace.
- Style de page : couleur et gouttière à deux instants, rendu visible dans la planche.
- Sur le bundle extrait du DMG, avec des données isolées : import H.264/AAC,
  flou, grain, halation et N&B ; animation des traits, fond, cases et gouttière.
- Trois exports MP4 720 × 720, 25 images/s, 2 secondes : dossier de la planche,
  dossier choisi `Vidéos de Noël "test"`, puis dossier par défaut des Réglages.
  Présence du fichier, dossier retenu, téléchargement par l'API et historique vérifiés.
- MP4 décodés intégralement avec le FFmpeg embarqué : H.264 et AAC 48 kHz ;
  différence entre les images 0 et 40 confirmant le mouvement et le changement de style.
- Comparaison du lecteur Chrome avec l'export à 720p, sur une image exacte de
  l'export : écarts moyens de 0,232/255 à t=0, 0,338/255 à t=1 et 0,233/255
  à t=1,8 ; 99 % des pixels sous 2 à 3/255 dans la case vidéo.
- Tests du contrat du sélecteur macOS : chemin passé en argument (espaces,
  accents et guillemets), activation, annulation, erreur remontée et dossier racine.

## Non validé visuellement

Safari, QuickTime, le passage réel du dialogue natif devant le navigateur,
son annulation et l'ouverture du dossier choisi dans le Finder. Le contrôle des
applications natives a expiré lors des tentatives précédentes dans cette session ;
le contrôle de Chrome fonctionne. Les tests du sélecteur utilisent un sous-processus
simulé ; ils ne constituent pas un test manuel du dialogue.

Le sélecteur appelle désormais `activate` avant `choose folder`, et passe le chemin
en argument plutôt que de l'insérer dans le code AppleScript. Aucune modification
des calculs d'effets ou d'interpolation n'a été nécessaire.

## Rejouer

```sh
.venv/bin/python mac/test_pick_folder.py
mac/build_dmg.sh
.venv/bin/python mac/smoke_test.py 'dist/Alive Video.app'
```

Pour le contrôle visuel, servir le bundle en mode `--test-server` avec
`ALIVE_HOME` pointant vers les données de test et `ALIVE_PORT=8793`, puis copier
`mac/compare_player.html` dans le dossier `export/` de la planche de test.
Ouvrir cette page dans le navigateur et cliquer sur Comparer.
