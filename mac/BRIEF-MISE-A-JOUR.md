# Consigne pour Claude sur Mac : mettre à jour « Alive Video » (version du 23/10/2026)

Pour la femme de David, sur son Mac. Elle ne doit **jamais** voir un Terminal ni une ligne de commande. David autorise
tout : avancer sans poser de questions, expliquer ses choix à la fin. Tout en français.

Dépôt : https://github.com/grosdada/Alive-Video (branche `main`, commit `a9ee230` ou plus récent). Lire d'abord
`CLAUDE.md`, puis `mac/BRIEF-DMG.md` (la consigne de fabrication du DMG, toujours valable).

## 1. Mettre à jour
- `git pull` dans le dépôt du Mac (ou le cloner s'il n'y est pas).
- **Si elle a la version DMG** : relancer `mac/build_dmg.sh` (s'il n'existe pas encore, faire d'abord tout
  `mac/BRIEF-DMG.md`), puis lui redonner le nouveau DMG. Ses planches, dans Documents › Alive Video, ne bougent pas.
- **Si elle a la version installée par `mac/install.sh`** : rien à refaire, l'app se met à jour toute seule au
  lancement quand le Mac est en ligne. Il suffit de quitter l'app et de la relancer.

## 2. Ce qui est nouveau
- **✏️ Edit** (barre du haut de l'éditeur de planche) : les icônes des cases (média, filtres, sons) n'apparaissent
  qu'en mode Edit. Hors de ce mode, la planche reste nette.
- **🎞 Animate framing** : la timeline anime les traits par images clés. Son bouton **🎨 Style de page** ajoute les lignes
  fond, couleur des cases, couleur et épaisseur des traits, gouttière et marge, elles aussi animables.
- **Dossier des vidéos exportées** :
  - Dans la fenêtre d'export, une ligne « Enregistrer dans » et un bouton **📁 Parcourir…**. La planche retient le
    dossier choisi.
  - Dans ⚙ Réglages › Vidéos exportées, le dossier par défaut de toutes les planches.
  - Sans choix, les vidéos vont dans le dossier `video/` de la planche, comme avant.

## 3. Le point propre au Mac : « Parcourir… »
Le bouton appelle `POST /api/pickfolder`. Sur Mac, `app/videoexport.py › pick_folder()` lance `osascript` avec
`choose folder` (tkinter ne sert que sous Windows : pas besoin de l'embarquer). À vérifier sur l'app installée :
- **La fenêtre doit s'ouvrir devant Safari.** Si elle reste cachée derrière, ou ne vient pas, la faire passer au
  premier plan dans `pick_folder` (par exemple un `activate` dans le script AppleScript) et retester.
- Annuler ne doit rien changer. Un dossier choisi doit s'afficher dans la ligne « Enregistrer dans ».
- Choisir un dossier du Bureau ou de Documents, puis exporter. macOS peut demander une fois l'autorisation d'accéder
  à ce dossier : c'est normal, il faut accepter. Le MP4 doit arriver dans le dossier choisi.
- Un chemin contenant des espaces ou des accents (« Vidéos de Noël ») doit marcher.
- « 📁 Dossier des vidéos », après l'export, doit ouvrir ce dossier dans le Finder.

Si quelque chose ne va pas, le corriger dans le dépôt en respectant `CLAUDE.md`, puis commit + push, puis refaire le
DMG.

## 4. Tester aussi, dans Safari puis Chrome
- **Edit** : les icônes apparaissent et disparaissent avec le bouton ; elles ne sont jamais là en Animate framing.
- **Animate framing** :
  - glisser une attache pose une clé, et les losanges se déplacent à la souris ;
  - la barre espace joue l'animation ;
  - dans 🎨 Style de page, changer une couleur et la gouttière à deux instants différents : la planche et l'Aperçu
    suivent.
- **Export d'une page animée** (720p suffit) : la vidéo montre le même mouvement que l'Aperçu.
- **Contrôle lecteur / export** (doc § 11) dans Safari, sur la planche animée :
  - choisir un instant qui tombe sur une image de l'export, c'est-à-dire t × images/s entier (par exemple t = 2 à
    25 im/s) ;
  - écart moyen attendu de l'ordre de 1 à 2,5 / 255 ;
  - nettement plus, c'est que Safari ne fait pas le même calcul : à corriger.

## 5. À la fin, dire à David
- Ce qui a été testé et ce qui ne l'a pas été.
- Où est le nouveau DMG, s'il y en a un.
- La phrase à dire à sa femme, du genre : « Quitte Alive Video, ouvre le nouveau fichier, glisse Alive Video dans
  Applications et remplace l'ancienne ; tes planches sont toujours dans Documents › Alive Video. Pour choisir où
  arrivent tes vidéos, clique sur Parcourir dans la fenêtre d'export. »
