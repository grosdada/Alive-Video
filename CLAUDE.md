# Alive-Video : consignes pour Claude Code

Application locale de David (grosdada) : des **planches de BD dont les cases sont des vidéos**. On découpe la page en
cases (façon komawari, comme Alive-Comics), on dépose une vidéo (ou une image) par case, on règle couleur, cadrage,
lecture et une pile d'effets, et la planche entière s'exporte en un fichier MP4. Née d'une copie d'Alive-Comics
(`grosdada/Alive-Comics`, main @ 21c6c4a) dont toute la génération a été retirée.
Documentation complète, à lire en premier : `docs/ALIVE-VIDEO-DOC.html`.

## Façon de travailler avec David
- Tout en français (interface, messages, docs). David autorise tout : avancer sans bloquer sur des questions.
- **Commit + push après chaque étape** (`origin main`). Ne jamais versionner `local_settings.json`, `projects/`, `data/`.
- Toujours vérifier une modification d'interface dans le navigateur (une accolade manquante casse l'appli).
- Tester sur l'instance de développement (`python tools/dev_instance.py`, port 8793) et sur une **copie** de planche
  (`projects/zz-…`, supprimée ensuite par `DELETE /api/projects/<id>`, qui la met à la corbeille).
- Serveur principal : port **8792** (Alive-Comics garde le 8790). Le lancer détaché (`Lancer_Alive_Video.bat`, ou
  `Start-Process cmd.exe '/c python -m app --no-browser'`). Le relancer pendant un export l'arrête (à relancer).
- Publication en ligne seulement quand David le demande.

## Règles qui ne se discutent pas
- **Même résultat dans le lecteur et dans l'export** : les effets existent deux fois, shaders `FS` de
  `player/alive-player.js` et `app/effects.py`, mêmes passes, même grille (alignée sur les pixels), même arrondi 8 bits.
  Ne jamais modifier l'un sans l'autre ; rejouer le contrôle lecteur / export ensuite (`POST /api/projects/<id>/compare`,
  procédure dans la doc § 11 ; écart moyen attendu ~1/255, au-delà de 3 il y a un défaut).
- Le temps d'une case (`source_frame` en Python = `sourcePos` en JS) est le même des deux côtés : début / fin en numéros
  d'images, vitesse, envers, boucle ou une fois. La copie de lecture et l'export appliquent le même filtre `fps`.
- Les vidéos originales ne sont jamais modifiées (`assets/`) ; le lecteur lit la copie (`proxies/`), l'export l'original.
- Cases à pastille **verte** (`review: "ok"`) : validées par David, ne pas les retoucher. Ne jamais passer une case en vert.
- Sons importés : jamais deux fois le même fichier (`app/sounds.py`) ; un son déjà utilisé déclenche une alerte.
- Rien de génératif dans cette app (ni H3, ni ComfyUI, ni IA) : c'est voulu.

## Repères techniques
- Serveur Python stdlib + `requirements.txt` (pillow, numpy, opencv-python-headless) ; ffmpeg et ffprobe dans le PATH.
- Interface sans compilation : `app/web` (application), `player/` (lecteur WebGL, livre, éditeur de case `alive-edit.js`).
- Export : `app/videoexport.py` (un à la fois, en fils), images de l'original décodées une fois en fichiers bruts.
- Écrire les gros correctifs dans un script Python (fichier) plutôt qu'en heredoc bash : les `\n` y sont mangés.
- Capture du lecteur dans le volet caché du navigateur : remplacer `requestAnimationFrame` par un `MessageChannel`.
