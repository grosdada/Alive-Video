# Consigne pour Claude sur Mac : fabriquer « Alive Video.dmg »

Pour la femme de David. Elle ne doit **jamais** voir un Terminal ni une ligne de commande : un fichier DMG, on glisse
« Alive Video » dans Applications, double-clic, ça marche. David autorise tout : avancer sans poser de questions, et
expliquer ses choix à la fin. Tout en français.

Lire d'abord `CLAUDE.md` et `docs/ALIVE-VIDEO-DOC.html` du dépôt (https://github.com/grosdada/Alive-Video).

## Ce que fait l'application aujourd'hui
Un serveur Python local (`python -m app`, bibliothèque standard + Pillow, NumPy, OpenCV), port 8792, qui ouvre
l'interface dans le navigateur. Il appelle `ffmpeg` et `ffprobe` par leur nom (PATH) pour les vidéos et l'export.
Le dossier des données (planches, vidéos, exports, réglages) se déplace avec la variable `ALIVE_HOME`
(`app/paths.py`) ; le code (`app/`, `player/`) peut donc rester en lecture seule dans l'application.

## Ce qu'il faut livrer
1. **`Alive Video.app`**, autonome : Python, Pillow, NumPy, OpenCV (opencv-python-headless) et des `ffmpeg` +
   `ffprobe` statiques embarqués. Rien à installer avant (ni Homebrew, ni Python, ni Xcode).
   - ffmpeg doit avoir `libx264`, `aac`, `libmp3lame` et le filtre `loudnorm` (vérifier `ffmpeg -encoders` /
     `ffmpeg -filters`). Architecture : celle du Mac de destination au minimum (`uname -m`), universelle si c'est simple.
   - Outil d'empaquetage au choix (PyInstaller `--windowed` ou py2app). Les dossiers `app/web/` et `player/` doivent
     se retrouver à côté du paquet `app` (le code les cherche dans `paths.CODE` = le parent du dossier `app`).
2. **Au lancement** (double-clic) :
   - `ALIVE_HOME` = `~/Documents/Alive Video` (créé s'il manque) : ses planches et ses vidéos exportées y sont
     visibles dans le Finder (`projects/<planche>/video/*.mp4`) ;
   - le dossier des ffmpeg embarqués en tête du `PATH` ;
   - le serveur démarré dans l'application (ex. `app.server.main()` dans un fil, avec `--no-browser`), puis le
     navigateur ouvert sur `http://127.0.0.1:8792` ; si le port est déjà pris, c'est qu'elle tourne déjà : juste ouvrir
     le navigateur ;
   - une présence visible pour pouvoir quitter : icône dans la barre des menus (par ex. `rumps`, MIT) ou dans le Dock,
     avec « Ouvrir Alive Video », « Ouvrir le dossier des planches », « Quitter » (arrête le serveur).
3. **Icône** : carré pourpre `#b36bff` aux coins arrondis avec le pictogramme de cases sombre `#1a0b2b` (le même
   dessin que l'icône de `app/web/index.html`), en `.icns`.
4. **Signature** : au moins ad hoc (`codesign --force --deep -s -`), indispensable pour les binaires sur puce Apple.
   Pas de notarisation (pas de compte développeur). Si le DMG est fabriqué sur un autre Mac que le sien puis envoyé
   (AirDrop, mail), la première fois : clic droit sur l'app › Ouvrir › Ouvrir. Le dire à David en une phrase.
5. **DMG** : `Alive-Video-<version>.dmg` (version = `app/server.py` VERSION + date), fenêtre avec l'app et un raccourci
   vers Applications, déposé sur le Bureau du Mac.
6. **`mac/build_dmg.sh`** : un script qui refait tout depuis le dépôt (télécharge ou réutilise ffmpeg, empaquette,
   signe, crée le DMG), pour les prochaines versions. Le committer et le pousser (`origin main`) ; jamais le DMG, l'app
   ni les binaires (à mettre dans `.gitignore`).

## Tester avant de rendre la main
Sur l'app installée depuis le DMG, dans **Safari** (navigateur par défaut du Mac) puis Chrome :
- créer une planche, glisser une vidéo dans une case, Aperçu (les cases jouent, le son après un clic) ;
- ✏️ Éditer › Filtres : ajouter flou, grain, halation, N&B ; la case et la page changent en direct ;
- Exporter la vidéo (720p suffit) et lire le MP4 obtenu (QuickTime) : image et son ;
- le contrôle lecteur / export de la doc (§ 11) dans Safari : écart moyen attendu de l'ordre de 1 à 2 / 255. Bien plus,
  c'est qu'un effet ne fait pas le même calcul dans Safari.
Si Safari pose problème (WebGL 2, lecture des vidéos, `requestVideoFrameCallback`…), corriger dans le dépôt en
respectant CLAUDE.md (un effet = shader du lecteur ET `app/effects.py`), commit + push, puis refaire le DMG.

## À la fin, dire à David
Où est le DMG, sa taille, ce qui a été testé et ce qui ne l'a pas été, et la phrase à dire à sa femme, du genre :
« Ouvre le fichier, glisse Alive Video dans Applications, puis lance-la depuis le Launchpad ; tes planches sont dans
Documents › Alive Video. »
Pour une nouvelle version plus tard : `git pull`, `mac/build_dmg.sh`, et lui redonner le DMG (ses planches restent).
