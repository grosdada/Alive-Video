# Alive-Video

Des planches de BD dont les cases sont des vidéos. On découpe la page en cases (traits droits ou penchés), on dépose une
vidéo dans chaque case, on règle couleur, cadrage, vitesse, sens de lecture, opacité, volume et une pile d'effets, puis
la planche entière sort en **un fichier vidéo MP4**, sons mélangés. La page jouable peut aussi être publiée en HTML
(page seule ou livre à feuilleter).

Même design et même ergonomie qu'[Alive-Comics](https://github.com/grosdada/Alive-Comics), sans aucune génération
(ni MiniMax H3, ni ComfyUI, ni IA) : les vidéos sont les vôtres.

## Lancer

```
Lancer_Alive_Video.bat        (ou : python -m app)
```

L'interface s'ouvre sur http://127.0.0.1:8792/ (Alive-Comics garde le port 8790 : les deux tournent ensemble).
Il faut Python 3.10+, ffmpeg et ffprobe dans le PATH, et `pip install -r requirements.txt` (Pillow, NumPy, OpenCV).

## Sur Mac

### Application autonome (DMG)

[Télécharger la dernière version Mac](https://github.com/grosdada/Alive-Video/releases/latest).

Sur un Mac Apple Silicon (M1 et suivants), macOS 14 ou plus récent : ouvrez le
DMG, glissez **Alive Video** dans **Applications**, puis lancez-la. Rien à installer.
Le menu **▦** permet de rouvrir l'interface, d'afficher les planches et de quitter.
Les données restent dans **Documents › Alive Video**.

Pour mettre à jour : quittez Alive Video depuis son menu, ouvrez le nouveau DMG,
glissez l'application dans Applications et choisissez **Remplacer**. Vos planches
sont conservées. Dans la fenêtre d'export, **Parcourir…** choisit le dossier des vidéos.

La version est signée ad hoc, sans notarisation Apple : si macOS bloque le premier
lancement, clic droit › Ouvrir (ou autorisation dans Confidentialité et sécurité).

Pour fabriquer le DMG sur un Mac Apple Silicon équipé de Python 3.14 et des outils
de développement Apple : `mac/build_dmg.sh`. Le résultat est dans `dist/`.
`COPY_TO_DESKTOP=1 mac/build_dmg.sh` le copie aussi sur le Bureau.
Test du bundle : `.venv/bin/python mac/smoke_test.py 'dist/Alive Video.app'`.

### Installation depuis les sources

Une seule ligne à coller dans le Terminal (Applications › Utilitaires › Terminal) :

```
curl -fsSL https://raw.githubusercontent.com/grosdada/Alive-Video/main/mac/install.sh | bash
```

Elle installe ce qu'il faut (Homebrew, Python, ffmpeg ; le mot de passe de la session Mac est demandé une fois, compter
10 à 20 minutes la première fois), l'application dans `~/Alive-Video` et un raccourci **« Alive Video »** sur le Bureau.
Ensuite : double-clic sur le raccourci, l'application s'ouvre dans le navigateur (Safari ou Chrome) ; laisser la fenêtre
du Terminal ouverte. Elle se met à jour toute seule au lancement quand le Mac est en ligne ; les planches restent sur le
Mac (`~/Alive-Video/projects`).

## Mode d'emploi

1. **Nouvelle planche** : un nom, un format (page BD, manga, 4:5, carré, écran 9:16), le sens et un découpage de départ.
2. **Cadres** : glisser un trait le déplace, glisser un de ses bouts l'incline (Maj : trait droit) ; couper, supprimer,
   pivoter, variante au hasard ; fond, couleur des cases, traits, gouttière, marge. Ctrl+Z / Ctrl+Y.
   Barre du haut : **✏️ Edit** montre les icônes de chaque case (média, filtres, sons) ; hors de ce mode la planche reste
   nette.
3. **Vidéos** : glisser une vidéo sur une case (ou cliquer dedans). Une vidéo par case (une image fixe marche aussi).
   L'original est gardé tel quel ; une copie légère est faite pour l'aperçu (quelques secondes). Molette pour zoomer,
   glisser pour recadrer.
4. **Réglages d'une case** (inspecteur) : vitesse, en boucle ou une fois, à l'envers, volume du son, opacité, sons ajoutés.
5. **Aperçu** : toutes les cases jouent ensemble, comme dans la vidéo exportée (barre de lecture, barre espace) ; mode
   « au survol » pour ne faire jouer que la case sous la souris.
6. **✏️ Éditer** (dans l'aperçu, ou l'icône filtres d'une case) : l'éditeur de case, avec ses onglets
   - **Lecture** : bande d'images, début et fin du passage, boucle, vitesse ;
   - **Couleur** : saturation, luminosité, contraste, température, teinte (« appliquer à toute la page ») ;
   - **Cadrage** : zoom et position ;
   - **Filtres** : opacité, vitesse, lecture inversée, volume, et les effets ajoutés à la demande — flou, couleur,
     N&B · sépia · teinte, vignette, grain, halation, aberration chromatique — chacun avec ses réglages, empilés dans
     l'ordre voulu, coupables sans être retirés ; piles enregistrables en préréglages, copiables sur toute la page ;
   - **Son** : volume de la vidéo, sons ajoutés, musique de la page.
7. **🎞 Animate framing** (barre du haut) : le découpage s'anime. Une timeline s'ouvre sous la planche, une ligne par
   point d'attache des traits ; toucher une attache met la timeline sur sa ligne, la glisser pose une image clé à
   l'instant de la tête de lecture. Pendant ce mode, les vidéos des cases suivent la tête de lecture (repères pour
   poser les clés). Timeline :
   - glisser dans le vide = rectangle de sélection ; Maj ou Ctrl + clic = ajouter une clé ;
   - glisser une clé choisie déplace toute la sélection ; Suppr efface ;
   - clic droit sur une clé : dupliquer, copier / coller, courbe (ease in-out, linéaire, ease in, ease out, versions
     fortes pour les ralentis marqués, palier) ;
   - Ctrl+D, Ctrl+C, Ctrl+V, Ctrl+A ; Ctrl+Z / Ctrl+Y annulent et refont chaque action (même juste après un curseur ou
     une couleur), la sélection des clés est gardée ;
   - Maj + clic sur les noms de ligne = plusieurs lignes ; « ☰ Toutes les lignes », « ◆ Clé partout », « Tout effacer ».

   L'aperçu et la vidéo exportée suivent. Le bouton **🎨 Style de page** de la timeline (allumé ou éteint) ajoute les
   lignes du fond, de la couleur des cases, de la couleur et de l'épaisseur des traits, de la gouttière et de la marge,
   animables de la même façon (chaque ligne a son réglage, qui pose une clé). Les icônes des cases sont cachées.
8. **Exporter la vidéo** : durée (automatique = le plus long passage, ou au choix), résolution (480p à 4K), images par
   seconde (24 à 60), et **Enregistrer dans** : par défaut le dossier `projects/<planche>/video/`, ou un autre choisi avec
   **📁 Parcourir…** (gardé pour la planche ; « ↺ par défaut » y revient). Le dossier par défaut de toutes les planches se
   change dans ⚙ Réglages › Vidéos exportées. Les effets y sont calculés exactement comme dans l'aperçu.
9. **Livres et publication** : comme Alive-Comics (livres de plusieurs planches, projets de rangement, publication par
   SSH une fois réglée dans ⚙ Réglages).

Documentation complète : `docs/ALIVE-VIDEO-DOC.html`.
