"""Assemblage de la page jouable : lecteur, videos de lecture, images, sons, donnees -> projects/<id>/export/.

L'export est un livre d'une page (index.html + book.js) et contient aussi manga_data.js, pour pouvoir etre repris
tel quel dans un livre de plusieurs pages. Les videos de lecture (copies legeres, app/media.py) y sont liees en
dur (pas de deuxieme copie sur le disque) ; la version a l'envers est faite a la demande.

Donnees d'une case pour le lecteur :
  { id, rect, poly (elargi sous le trait), view {zoom, ox, oy},
    media: {kind: "video", src, rev?, w, h, fps, frames, audio} | {kind: "image", src, w, h},
    fx: {grade, range, loop, speed, reverse, opacity, volume, filters}, more: [{src, vol, loop}] }
Page : { page, frames, size, fps, duration, bg, sound?: {src, vol}, panels }.
"""

import hashlib
import json
import os
import shutil
import subprocess
import threading
from collections import defaultdict
from pathlib import Path

from . import edit as E
from . import geometry as G
from . import media, store, videoexport

from .paths import CODE as ROOT, DATA

PLAYER = ROOT / "player"
PLAYER_FILES = ("alive-player.js", "alive-player.css", "grain.png")
NOFLASH = media.NOFLASH
_LOCKS = defaultdict(threading.Lock)        # un seul assemblage a la fois par planche (retouches rapprochees)
IMAGE_MAX = 2560

# niveaux cibles (LUFS) des sons importes : les curseurs de volume restent comparables
LEVELS = {"page": -23, "extra": -20}


def ffmpeg(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, **NOFLASH)
    if r.returncode:
        raise RuntimeError("ffmpeg : " + r.stderr[-1200:])


def normalize(src, dst, layer):
    """Copie un son en mp3 au niveau cible de sa couche."""
    ffmpeg(["-i", str(src), "-vn", "-af", f"loudnorm=I={LEVELS[layer]}:TP=-1.5:LRA=11", "-ar", "44100",
            "-c:a", "libmp3lame", "-q:a", "2", str(dst)])


def _mtime(f):
    try:
        return round(Path(f).stat().st_mtime, 3)
    except OSError:
        return None


def link(src, dst):
    """Lien dur (meme disque, aucune copie), sinon copie ; rien a faire si dst est deja ce fichier."""
    src, dst = Path(src), Path(dst)
    if dst.exists():
        try:
            if os.path.samefile(src, dst) or (dst.stat().st_size == src.stat().st_size
                                               and dst.stat().st_mtime >= src.stat().st_mtime):
                return
        except OSError:
            pass
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def page_key(p, d):
    """Empreinte de tout ce qui change la page exportee : si elle n'a pas bouge, l'export existant est bon."""
    panels = {}
    for pid_, panel in sorted((p.get("panels") or {}).items()):
        v, im = panel.get("video") or {}, panel.get("image") or {}
        panels[pid_] = {"video": [v.get("file"), v.get("proxy"), _mtime(d / v["proxy"]) if v.get("proxy") else None],
                        "image": [im.get("file"), _mtime(d / im["file"]) if im.get("file") else None],
                        "view": panel.get("view"), "edit": panel.get("edit"),
                        "extra": [[x.get("file"), x.get("volume"), x.get("loop"), _mtime(d / x["file"]) if x.get("file") else None]
                                  for x in panel.get("extraSounds") or []]}
    ps = p.get("pageSound") or {}
    page_sound = {k: ps.get(k) for k in ("mode", "file", "volume")}
    if ps.get("file"):
        page_sound["mtime"] = _mtime(d / ps["file"])
    blob = {"v": 1, "name": p.get("name"), "geometry": p.get("geometry"), "pageSound": page_sound,
            "page": p.get("page"), "export": videoexport.settings_of(p), "panels": panels,
            "files": [_mtime(d / "page" / n) for n in ("page.jpg", "frames.png")],
            "player": [_mtime(PLAYER / n) for n in ("book.html", *PLAYER_FILES)]}
    return hashlib.sha1(json.dumps(blob, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def build(pid, log=print, force=False):
    with _LOCKS[pid]:
        return _build(pid, log, force)


def player_fx(panel):
    """Retouches transmises au lecteur (les memes que celles de l'export video)."""
    return E.clean(panel.get("edit") or {})


def _build(pid, log=print, force=False):
    p = store.get(pid)
    d = store.pdir(pid)
    geo = p.get("geometry") or {}
    if not geo.get("panels"):
        raise ValueError("géométrie de la planche absente : ouvrir la planche dans l'éditeur une fois")
    out = d / "export"
    for sub in ("videos", "images", "sons"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    cache_f = out / ".cache.json"
    cache = json.loads(cache_f.read_text(encoding="utf-8")) if cache_f.exists() else {}
    pkey = page_key(p, d)
    done = cache.get("_page") or {}
    if not force and done.get("key") == pkey and (out / "index.html").exists() and done.get("result"):
        return dict(done["result"], cached=True)          # rien n'a change : la page deja assemblee est bonne
    sons_cache = cache.setdefault("_sons", {})

    def norm(src, name, layer):
        dst = out / "sons" / name
        sig = f"{src}|{_mtime(src)}|{layer}|{LEVELS[layer]}"
        if sons_cache.get(name) != sig or not dst.exists():
            normalize(src, dst, layer)
            sons_cache[name] = sig
        return dst
    for name in ("page.jpg", "frames.png"):
        src = d / "page" / name
        if not src.exists():
            raise FileNotFoundError(f"{name} manquant : l'éditeur l'envoie à chaque enregistrement")
        shutil.copy2(src, out / name)
    page = dict(G.PAGE_DEFAULTS, **(p.get("page") or {}))
    stroke = float(page.get("strokeWidth", 4))
    s = videoexport.settings_of(p)
    data = {"page": "page.jpg", "frames": "frames.png", "size": geo["size"], "fps": s["fps"], "duration": s["seconds"],
            "bg": page.get("bg") or "#ffffff", "panels": []}
    report, encoded = [], []
    for g in geo["panels"]:
        panel = p["panels"].get(g["id"]) or {}
        entry = {"id": g["id"], "rect": [round(v, 1) for v in g["rect"]], "poly": G.grow(g["poly"], stroke / 2 + 1),
                 "view": E.clean_view(panel.get("view"))}
        v, im = panel.get("video") or {}, panel.get("image") or {}
        fx = player_fx(panel)
        if v.get("proxy") and (d / v["proxy"]).exists():
            proxy = d / v["proxy"]
            name = f"videos/{proxy.name}"
            link(proxy, out / name)
            entry["media"] = {"kind": "video", "src": name, "w": v["w"], "h": v["h"], "fps": v["fps_f"],
                              "frames": v["frames"], "audio": bool(v.get("audio"))}
            if fx.get("reverse"):
                try:
                    rev = media.ensure_reverse(proxy, v, log)
                    link(rev, out / f"videos/{rev.name}")
                    entry["media"]["rev"] = f"videos/{rev.name}"
                except media.MediaError as e:
                    report.append(f"{g['id']} : lecture inversée impossible ({e})")
            report.append(f"{g['id']} vidéo {v['frames']} images")
        elif im.get("file") and (d / im["file"]).exists():
            src = d / im["file"]
            name = f"images/{src.stem}.jpg"
            dst = out / name
            if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
                from PIL import Image
                with Image.open(src) as pic:
                    pic = pic.convert("RGB")
                    pic.thumbnail((IMAGE_MAX, IMAGE_MAX), Image.LANCZOS)
                    pic.save(dst, "JPEG", quality=92)
            entry["media"] = {"kind": "image", "src": name, "w": im.get("w"), "h": im.get("h")}
            report.append(f"{g['id']} image")
        if fx and entry.get("media"):
            entry["fx"] = fx
        more = []                                    # sons ajoutes
        for i, x in enumerate(panel.get("extraSounds") or []):
            if x.get("file") and (d / x["file"]).exists():
                name = f"{g['id']}_plus{i + 1}.mp3"
                norm(d / x["file"], name, "extra")
                more.append({"src": f"sons/{name}", "vol": float(x.get("volume", 0.8)), "loop": bool(x.get("loop", True))})
        if more:
            entry["more"] = more
        data["panels"].append(entry)
    ps = p.get("pageSound") or {}
    if ps.get("mode") == "file" and ps.get("file") and (d / ps["file"]).exists():
        norm(d / ps["file"], "page.mp3", "page")
        data["sound"] = {"src": "sons/page.mp3", "vol": float(ps.get("volume", 0.7))}
    (out / "manga_data.js").write_text("window.MANGA = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
    book = {"title": p.get("name", "Planche"), "pages": [{"title": p.get("name", ""), "base": "", "project": pid,
                                                           "data": data}]}
    (out / "book.js").write_text("window.ALIVE_BOOK = " + json.dumps(book, ensure_ascii=False) + ";\n", encoding="utf-8")
    copy_player(out)
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    # ne garder que les fichiers encore utilises
    used = set(data_files(data))
    for sub in ("videos", "sons", "images"):
        for f in (out / sub).iterdir():
            if f"{sub}/{f.name}" not in used:
                try:
                    f.unlink()
                except OSError:
                    pass
    result = {"ok": True, "report": report, "url": f"/projects/{pid}/export/index.html",
              "videos": sum(1 for e in data["panels"] if (e.get("media") or {}).get("kind") == "video"),
              "panels": len(data["panels"])}
    cache["_page"] = {"key": pkey, "result": result}
    cache_f.write_text(json.dumps(cache), encoding="utf-8")
    return dict(result, cached=False, encoded=encoded)


def copy_player(out):
    shutil.copy2(PLAYER / "book.html", Path(out) / "index.html")
    for f in PLAYER_FILES:
        shutil.copy2(PLAYER / f, Path(out) / f)


def read_data(folder):
    """Donnees d'une page assemblee (manga_data.js)."""
    raw = (Path(folder) / "manga_data.js").read_text(encoding="utf-8")
    return json.loads(raw.split("=", 1)[1].strip().rstrip(";"))


def data_files(data):
    """Fichiers dont une page a besoin (relatifs a son dossier)."""
    files = [data["page"], data["frames"]]
    for e in data["panels"]:
        m = e.get("media") or {}
        files += [m[k] for k in ("src", "rev") if m.get(k)]
        files += [x["src"] for x in e.get("more") or []]
    if data.get("sound"):
        files.append(data["sound"]["src"])
    return files


def sync_book_page(book, pid):
    """Reporte une planche retouchee dans le livre deja assemble (data/books/<id>), sans tout reconstruire."""
    out = DATA / "books" / book["id"]
    bj = out / "book.js"
    if not bj.exists():
        return None
    B = json.loads(bj.read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))
    src = store.pdir(pid) / "export"
    data = read_data(src)
    hit = None
    for i, pg in enumerate(B["pages"]):
        owner = pg.get("project") or (book["pages"][i] if i < len(book.get("pages") or []) else None)
        if owner != pid:
            continue
        for rel in data_files(data):
            b = out / pg["base"] / rel
            b.parent.mkdir(parents=True, exist_ok=True)
            link(src / rel, b)
        pg["data"], pg["project"], hit = data, pid, data
    if hit is not None:
        bj.write_text("window.ALIVE_BOOK = " + json.dumps(B, ensure_ascii=False) + ";\n", encoding="utf-8")
        copy_player(out)
    return hit


def build_book(book, out, log=print):
    """Livre de plusieurs planches : book = {"title", "pages": [project_id...]} -> dossier out."""
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    pages = []
    for i, pid in enumerate(book["pages"]):
        build(pid, log)
        src = store.pdir(pid) / "export"
        base = f"pages/{i + 1:02d}-{store.slug(store.get(pid).get('name', pid))}/"
        data = read_data(src)
        for rel in data_files(data):
            (out / base / rel).parent.mkdir(parents=True, exist_ok=True)
            link(src / rel, out / base / rel)
        pages.append({"title": store.get(pid).get("name", ""), "base": base, "project": pid, "data": data})
    (out / "book.js").write_text("window.ALIVE_BOOK = " + json.dumps({"title": book["title"], "pages": pages},
                                                                       ensure_ascii=False) + ";\n", encoding="utf-8")
    copy_player(out)
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    return out
