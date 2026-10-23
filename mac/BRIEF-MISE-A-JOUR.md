# Consigne pour Claude sur Mac : version 0.1.2 d'« Alive Video » (la timeline)

Pour la femme de David, sur son Mac. Elle ne doit **jamais** voir un Terminal ni une ligne de commande. David autorise
tout : avancer sans poser de questions, expliquer ses choix à la fin. Tout en français.

Dépôt : https://github.com/grosdada/Alive-Video (branche `main`, dernier commit). Lire d'abord `CLAUDE.md`, puis
`mac/VALIDATION-0.1.1.md` (ton compte rendu précédent : DMG 0.1.1 et sélecteur de dossier déjà faits).

## 1. Mettre à jour et refaire le DMG
`git pull`, puis `mac/build_dmg.sh` : `app/server.py` est passé en VERSION 0.1.2. Rejouer `mac/smoke_test.py` sur le
bundle. Déposer le DMG sur le Bureau, et le publier en release GitHub si c'est comme ça que tu as fait pour la 0.1.1.
Ses planches, dans Documents › Alive Video, ne bougent pas.

## 2. Ce qui est nouveau depuis la 0.1.1
- **Timeline (Animate framing)**, les bases d'un logiciel de montage :
  - glisser dans le vide d'une ligne = rectangle de sélection, Maj ou Cmd + clic = ajouter une clé ;
  - glisser une clé choisie déplace toute la sélection ; Suppr (ou ⌫) efface ;
  - clic droit sur une clé : dupliquer (à la tête de lecture, ou juste après), copier / coller, courbes
    (ease in-out, linéaire, ease in, ease out, leurs versions fortes, palier), supprimer ;
  - Cmd+D, Cmd+C, Cmd+V, Cmd+A ; Cmd+Z / Cmd+Maj+Z (ou Cmd+Y) annulent et refont chaque action de la timeline ;
  - Maj ou Cmd + clic sur les noms de ligne, « ☰ Toutes les lignes », « ◆ Clé partout », « Tout effacer ».
- **Nouvelles courbes** `ease2`, `in2`, `out2` (puissance 5). Mêmes formules dans `app/web/js/geometry.js`,
  `player/alive-player.js` et `app/geometry.py`.
- **Les vidéos des cases suivent la tête de lecture** en Animate framing : une `<video>` dans un `<foreignObject>`
  de la planche SVG, découpée par le polygone de la case (`app/web/js/editor.js › liveVideo / syncVideos`). Au
  glisser, la vidéo cherche l'image ; pendant la lecture elle joue (à l'envers : image par image).
- **Annulation** : une étape par action de la timeline, la sélection des clés est gardée, Cmd+Z marche aussi quand
  un curseur, une couleur ou un menu a le focus. Correctif : après une annulation, l'action suivante enregistrait un
  mauvais état (un second Cmd+Z ramenait ce qu'on venait d'annuler).
- **Correctif** : la vignette de la planche renvoie le nouveau numéro `rev`. Avant, l'app rechargeait la planche
  quelques secondes après chaque modification, ce qui vidait Ctrl+Z et la sélection de la timeline.

## 3. À tester dans Safari (c'est là que tout peut différer de Chrome)
- **Vidéos dans les cases** en Animate framing. WebKit a des soucis connus avec la vidéo dans un `foreignObject` :
  vidéo invisible, ou qui déborde de la case penchée. Si c'est le cas, passer à une `<video>` HTML posée au-dessus de
  la planche et découpée par `clip-path: polygon(...)` (coordonnées de la case en % de la page). Retester ensuite
  dans Chrome aussi.
- **Clic droit** : au trackpad (deux doigts) et au ctrl + clic, le menu des clés s'ouvre et la sélection reste entière.
- **Cmd+D** est aussi « Ajouter un signet » dans Safari : la timeline doit dupliquer les clés sans ouvrir la fenêtre
  des signets. Cmd+A ne doit pas sélectionner le texte de la page. Sinon, corriger dans `app/web/js/main.js › keys()`.
- **Rectangle de sélection** : il se trace sans sélectionner de texte, y compris en sortant de la ligne de départ.
- **Cmd+Z / Cmd+Maj+Z** dans la timeline : chaque action s'annule une par une, y compris juste après avoir bougé un
  curseur du Style de page ou choisi une courbe ; et après une minute d'attente (le correctif `rev`). Safari ne doit
  pas intercepter Cmd+Z pour lui-même (rouvrir un onglet fermé, par exemple).
- **Points restés ouverts en 0.1.1**, si le contrôle des applications le permet cette fois :
  - le vrai dialogue « Parcourir… » s'ouvre devant Safari, et l'annulation ne change rien ;
  - « 📁 Dossier des vidéos » ouvre le Finder ;
  - le MP4 se lit dans QuickTime.
- **Contrôle lecteur / export** dans Safari, sur une planche animée qui utilise une courbe forte : choisir t × images/s
  entier. Écart moyen attendu de l'ordre de 1 à 2,5 / 255.

Si quelque chose ne va pas, le corriger dans le dépôt en respectant `CLAUDE.md`, puis commit + push, puis refaire le
DMG. Écrire le compte rendu dans `mac/VALIDATION-0.1.2.md`, sur le modèle de celui de la 0.1.1.

## 4. À la fin, dire à David
- Ce qui a été testé et ce qui ne l'a pas été.
- Où est le nouveau DMG.
- La phrase à dire à sa femme, du genre : « Quitte Alive Video depuis son menu, ouvre le nouveau fichier, glisse
  Alive Video dans Applications et choisis Remplacer ; tes planches sont toujours dans Documents › Alive Video. »
