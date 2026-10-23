"""Serveur local d'Alive-Video (bibliotheque standard, plus Pillow / NumPy / OpenCV pour l'export).

    python -m app            (ou Lancer_Alive_Video.bat)

Sert l'interface (app/web), le lecteur (player/), les fichiers des projets (avec requetes Range, indispensables
pour se deplacer dans les videos) et l'API JSON /api/... . Port 8792 (Alive-Comics garde le 8790).
"""

import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import assemble, compose, edit, effects, geometry, media, publish, settings, sounds, store, videoexport

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "app" / "web"
PLAYER = ROOT / "player"
BOOKS = ROOT / "data" / "books.json"
FOLDERS = ROOT / "data" / "folders.json"      # projets de rangement : {"folders": [{id, name, color}], "assign": {planche: projet}}
UPLOADS = ROOT / "data" / "uploads"           # gros envois (videos) : ecrits sur le disque au fil de l'eau
SPOOL = 16 * 1024 * 1024
ACCENT = "#b36bff"
VERSION = "0.1.0"
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("image/png", ".png")


def open_folder(path):
    """Ouvre un dossier dans l'explorateur du poste (le serveur tourne sur la machine de l'utilisateur)."""
    path = Path(path)
    if not path.is_dir():
        raise FileNotFoundError(str(path))
    if os.name == "nt":
        os.startfile(str(path))                      # noqa: S606 - dossier interne a l'application
    else:
        import subprocess
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])


class ApiError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


# ce que le serveur et l'apercu ecrivent : l'interface de l'application ne les remplace jamais (copie peut-etre ancienne)
SERVER_KEYS = ("edit", "extraSounds", "review")


def merge_project(server_p, ui_p):
    """La version de l'interface gagne (decoupage, medias, cadrage), sauf les retouches du mode edition."""
    out = dict(ui_p)
    out["id"], out["created"] = server_p["id"], server_p.get("created")
    for k in ("published", "export"):              # ecrits par le serveur (publication, reglages d'export)
        if k in server_p:
            out[k] = server_p[k]
        else:
            out.pop(k, None)
    panels = {}
    for pid, panel in (ui_p.get("panels") or {}).items():
        old = (server_p.get("panels") or {}).get(pid, {})
        panel = dict(panel)
        for k in SERVER_KEYS:
            if k in old:
                panel[k] = old[k]
            else:
                panel.pop(k, None)
        panels[pid] = panel
    out["panels"] = panels
    # musique de la page : l'import et l'apercu l'ecrivent aussi ; « rev » dit qui est le plus recent
    prev, cur = server_p.get("pageSound") or {}, dict(ui_p.get("pageSound") or {})
    out["pageSound"] = prev if (prev.get("rev") or 0) > (cur.get("rev") or 0) else cur
    return out


def video_panel(pid, panel_id, src, name):
    """Range une video importee (fichier deja sur le disque) dans la case : original, copie de lecture, affiche."""
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    d = store.pdir(pid)
    safe = store.safe_name(f"{stamp}-{name}")
    dst = d / "assets" / safe
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    try:
        info = media.prepare(dst, d / "proxies", Path(safe).stem)
    except media.MediaError as e:
        dst.unlink(missing_ok=True)
        raise ApiError("vidéo illisible : " + str(e)[-300:])
    video = dict(info, file=f"assets/{safe}", name=name, url=f"/projects/{pid}/assets/{safe}",
                 proxy_url=f"/projects/{pid}/{info['proxy']}", poster_url=f"/projects/{pid}/{info['poster']}")
    if panel_id:
        def setv(p):
            panel = p["panels"].get(panel_id)
            if panel is None:
                raise KeyError(panel_id)
            panel["video"] = video
            panel.pop("image", None)
            panel["view"] = {"zoom": 1, "ox": 0, "oy": 0}
            e = panel.get("edit") or {}
            e.pop("range", None)                        # debut / fin de l'ancienne video
            panel["edit"] = e
        store.mutate(pid, setv)
    return video


class Handler(BaseHTTPRequestHandler):
    server_version = "AliveVideo/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        first = str(args[0]) if args else ""
        if "/api/exports" in first or "/video HTTP" in first or "/rev HTTP" in first:
            return
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---------------------------------------------------------- reponses
    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path, cache="no-cache"):
        path = Path(path)
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m and size:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                    return
                left -= len(chunk)

    def body(self):
        # le corps est lu UNE fois des l'arrivee de la requete (route) : sinon, en keep-alive, des octets non lus
        # se collent a la requete suivante (« {}GET ... » -> erreur 501). Un gros corps (video) est sur le disque.
        if self._spool:
            return self._spool.read_bytes()
        return self._raw

    def body_file(self):
        """Le corps dans un fichier (deplace ensuite par l'appelant)."""
        if self._spool:
            f, self._spool = self._spool, None
            return f
        UPLOADS.mkdir(parents=True, exist_ok=True)
        f = UPLOADS / ("up-" + secrets.token_hex(6))
        f.write_bytes(self._raw)
        return f

    def jbody(self):
        raw = self.body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    # ---------------------------------------------------------- routage
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        n = int(self.headers.get("Content-Length") or 0)
        self._raw, self._spool = b"", None
        if n > SPOOL:
            UPLOADS.mkdir(parents=True, exist_ok=True)
            self._spool = UPLOADS / ("up-" + secrets.token_hex(6))
            left = n
            with open(self._spool, "wb") as fh:
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    fh.write(chunk)
                    left -= len(chunk)
        elif n:
            self._raw = self.rfile.read(n)
        url = urlparse(self.path)
        path = unquote(url.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                return self.api(method, path[5:].strip("/").split("/"), q)
            if method not in ("GET", "HEAD"):
                raise ApiError("méthode non permise", 405)
            if path in ("/", "/index.html"):
                return self.send_file(WEB / "index.html")
            if path.startswith("/web/"):
                return self.send_file(self.inside(WEB, path[5:]))
            if path.startswith("/player/"):
                return self.send_file(self.inside(PLAYER, path[8:]))
            if path.startswith("/projects/"):
                pid, _, rel = path[10:].partition("/")
                return self.send_file(store.path(pid, rel))
            self.send_error(404)
        except sounds.Duplicate as e:            # son deja utilise ailleurs : l'interface previent (et peut forcer)
            self.send_json({"error": str(e), "duplicate": True, "used": e.used}, 409)
        except ApiError as e:
            self.send_json({"error": str(e)}, e.status)
        except FileNotFoundError as e:
            self.send_json({"error": "introuvable : %s" % e}, 404)
        except KeyError as e:
            self.send_json({"error": "case inconnue : %s" % e}, 404)
        except (PermissionError, ValueError) as e:
            self.send_json({"error": str(e)}, 400)
        except (publish.PublishError, media.MediaError) as e:
            self.send_json({"error": str(e)}, 502)
        except Exception as e:                    # noqa: BLE001
            traceback.print_exc()
            self.send_json({"error": "%s: %s" % (e.__class__.__name__, e)}, 500)
        finally:
            if self._spool:
                try:
                    self._spool.unlink()
                except OSError:
                    pass

    @staticmethod
    def inside(base, rel):
        base = base.resolve()
        f = (base / rel).resolve()
        if base not in f.parents:
            raise PermissionError(rel)
        return f

    # ---------------------------------------------------------- API
    def api(self, m, parts, q):
        head = parts[0]
        if head == "info" and m == "GET":
            return self.send_json({"version": VERSION, "ffmpeg": bool(shutil.which("ffmpeg"))})
        if head == "presets" and m == "GET":
            return self.send_json({"effects": effects.EFFECTS, "export": {"heights": videoexport.HEIGHTS,
                                                                           "fps": videoexport.FPS_CHOICES,
                                                                           "defaults": videoexport.DEFAULTS},
                                   "speed": edit.SPEED})
        if head == "layouts" and m == "GET":          # decoupages prets (pilotage par API)
            return self.send_json([{"id": k, "label": v[0]} for k, v in geometry.PRESETS.items()]
                                  + [{"id": "random:N", "label": "N cases au hasard (ex. random:6)"}])
        if head == "settings":
            if m == "GET":
                return self.send_json(settings.public())
            if m == "PUT":
                return self.send_json(settings.update(self.jbody()))
        if head == "exports" and m == "GET":          # exports video en cours (pastilles de l'accueil)
            return self.send_json(videoexport.active())
        if head == "publish":
            if parts[1:] == ["key"] and m == "GET":
                return self.send_json({"public_key": publish.ensure_key()})
            if parts[1:] == ["test"] and m == "POST":
                return self.send_json({"ok": publish.test()})
        if head == "userpresets":                    # piles d'effets enregistrees, pour toutes les planches
            if m == "GET":
                return self.send_json(edit.user_presets())
            if m == "POST":
                return self.send_json(edit.save_user_preset(self.jbody()))
        if head == "books":
            return self.books(m, parts, q)
        if head == "folders":                        # rangement des planches par projet (distinct des livres)
            if m == "GET":
                return self.send_json(json.loads(FOLDERS.read_text(encoding="utf-8")) if FOLDERS.exists() else {"folders": [], "assign": {}})
            if m == "PUT":
                b = self.jbody()
                ids = {f["id"] for f in b.get("folders", [])}
                clean = {"folders": [{"id": f["id"], "name": str(f.get("name") or "Projet"), "color": f.get("color") or ACCENT}
                                     for f in b.get("folders", [])],
                         "assign": {k: v for k, v in (b.get("assign") or {}).items() if v in ids}}
                FOLDERS.parent.mkdir(exist_ok=True)
                FOLDERS.write_text(json.dumps(clean, indent=1, ensure_ascii=False), encoding="utf-8")
                return self.send_json({"ok": True})
        if head == "projects":
            return self.projects(m, parts, q)
        raise ApiError("route inconnue : /api/" + "/".join(parts), 404)

    def projects(self, m, parts, q):
        if len(parts) == 1:
            if m == "GET":
                lst = store.list_projects()
                busy = {t["project"]: t for t in videoexport.active()}
                for x in lst:
                    if x["id"] in busy:
                        x["exporting"] = round(busy[x["id"]].get("progress", 0), 3)
                return self.send_json(lst)
            if m == "POST":
                b = self.jbody()
                page, layout, nxt = b.get("page"), b.get("layout"), None
                if not layout:                         # pilotage : format + sens + decoupage pret (ou au hasard)
                    w, hh = geometry.page_size(b.get("format", "bd"), b.get("orientation", "portrait"))
                    page = dict(geometry.PAGE_DEFAULTS, format=b.get("format", "bd"),
                                orientation=b.get("orientation", "portrait"), width=w, height=hh, **(page or {}))
                    preset = b.get("preset") or "3x2"
                    if preset.startswith("random:"):
                        layout, nxt = geometry.random_layout(int(preset.split(":")[1]), float(b.get("tilt", 0.05)), b.get("seed"))
                    else:
                        layout, nxt = geometry.make_layout(preset)
                p = store.create(b.get("name") or "Nouvelle planche", page, layout)
                ids = geometry.leaves(p["layout"])

                def init(pp):
                    for i in ids:
                        pp["panels"].setdefault(i, store.new_panel())
                    pp["nextId"] = nxt or (max([int(i[1:]) for i in ids if i[1:].isdigit()] or [0]) + 1)
                p = store.mutate(p["id"], init)
                if not b.get("layout"):
                    compose.compose(p["id"])
                    p = store.get(p["id"])
                return self.send_json(p)
        pid = parts[1]
        sub = parts[2] if len(parts) > 2 else ""
        if not sub:
            if m == "GET":
                return self.send_json(store.get(pid))
            if m == "PUT":
                ui = self.jbody()
                with store._lock:
                    merged = merge_project(store.get(pid), ui)
                    return self.send_json(store.save(merged))
            if m == "DELETE":
                store.trash(pid)
                return self.send_json({"ok": True})
        if sub == "upload" and m == "POST":
            name = q.get("name") or "fichier"
            kind = q.get("kind")
            if kind == "video":
                video = video_panel(pid, q.get("panel"), self.body_file(), name)
                return self.send_json(dict(video, project=store.get(pid) if q.get("panel") else None))
            data = self.body()
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
            snd = None
            if kind in ("page", "extra"):              # sons : jamais deux fois le meme fichier
                snd = sounds.place(pid, data, name, q.get("force") == "1")
                rel = snd["file"]
            else:
                rel = store.write_file(pid, "assets", f"{stamp}-{name}", data)
            if kind == "page":
                store.mutate(pid, lambda p: p.setdefault("pageSound", {}).update(mode="file", file=rel, name=name,
                                                                                rev=time.time()))
            if kind == "extra" and q.get("panel"):
                store.mutate(pid, lambda pp: edit.add_extra_sound(pp, q["panel"], rel, name))
            return self.send_json(dict(snd or {}, file=rel, url=f"/projects/{pid}/{rel}"))
        if sub == "rev" and m == "GET":                 # numero de version (l'interface se recharge s'il bouge)
            p = store.get(pid)
            return self.send_json({"rev": p.get("rev", 0), "updated": p.get("updated")})
        if sub == "compose" and m == "POST":            # page.jpg + geometrie, cote serveur
            return self.send_json(compose.compose(pid))
        if sub == "update" and m == "POST":             # reglages de la planche (nom, page, musique, decoupage, export)
            b = self.jbody()

            def upd(p):
                if "name" in b:
                    p["name"] = b["name"]
                if isinstance(b.get("page"), dict):
                    p["page"] = dict(p.get("page") or {}, **b["page"])
                    if "format" in b["page"] or "orientation" in b["page"]:
                        w, hh = geometry.page_size(p["page"].get("format", "bd"), p["page"].get("orientation", "portrait"))
                        p["page"].update(width=w, height=hh)
                if isinstance(b.get("pageSound"), dict):
                    p["pageSound"] = dict(p.get("pageSound") or {}, **b["pageSound"], rev=time.time())
                if isinstance(b.get("export"), dict):
                    s = videoexport.settings_of({}, b["export"])
                    p["export"] = {k: s[k] for k in videoexport.DEFAULTS}
                if isinstance(b.get("layout"), dict):
                    p["layout"] = b["layout"]
                    for i in geometry.leaves(p["layout"]):
                        p["panels"].setdefault(i, store.new_panel())
            return self.send_json(store.mutate(pid, upd))
        if sub == "panels" and len(parts) == 4 and m == "POST":     # cadrage / retouches d'une case (pilotage)
            b = self.jbody()
            bad = set(b) - {"view", "edit", "review"}
            if bad:
                raise ApiError("clés inconnues : " + ", ".join(sorted(bad)) + " (permises : edit, review, view)")
            edit.apply(pid, parts[3], b)
            return self.send_json(store.get(pid)["panels"][parts[3]])
        if sub == "panels" and len(parts) == 5 and parts[4] in ("image", "video", "sound") and m == "POST":
            name = q.get("name") or {"image": "image.png", "video": "video.mp4", "sound": "son.mp3"}[parts[4]]
            if parts[4] == "video":
                return self.send_json(video_panel(pid, parts[3], self.body_file(), name))
            data = self.body()
            if parts[4] == "sound":                           # son ajoute a la case (jamais deux fois le meme fichier)
                snd = sounds.place(pid, data, name, q.get("force") == "1")
                p = store.mutate(pid, lambda pp: edit.add_extra_sound(pp, parts[3], snd["file"], name))
                return self.send_json(dict(snd, extra=p["panels"][parts[3]]["extraSounds"]))
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
            rel = store.write_file(pid, "assets", f"{stamp}-{name}", data)
            from PIL import Image
            with Image.open(store.path(pid, rel)) as im:
                w, hh = im.size

            def setimg(p):
                panel = p["panels"].get(parts[3])
                if panel is None:
                    raise KeyError(parts[3])
                panel["image"] = {"file": rel, "url": f"/projects/{pid}/{rel}", "w": w, "h": hh, "name": name}
                panel.pop("video", None)
                panel["view"] = {"zoom": 1, "ox": 0, "oy": 0}
            store.mutate(pid, setimg)
            return self.send_json({"file": rel, "w": w, "h": hh})
        if sub == "page" and m == "POST":
            name = q.get("name", "")
            if name not in ("page.jpg", "frames.png", "thumb.jpg"):
                raise ApiError("nom de fichier de page invalide")
            rel = store.write_file(pid, "page", name, self.body())
            if name == "thumb.jpg":
                store.mutate(pid, lambda p: p.update(thumb=f"/projects/{pid}/{rel}"))
            return self.send_json({"file": rel})
        if sub == "edit" and len(parts) == 4 and m == "POST":     # mode edition de l'apercu : retouches d'une case
            b = self.jbody()
            edit.apply(pid, parts[3], b)
            if "review" in b and set(b) <= {"review", "book"}:     # pastille de suivi seulement : rien a assembler
                return self.send_json({"ok": True, "page": assemble.read_data(store.pdir(pid) / "export"),
                                       "encoded": [], "report": [], "project": store.get(pid)})
            if "view" in b:                                       # cadrage change : l'image de la page suit
                compose.compose(pid)
            res = assemble.build(pid)                   # rapide : les retouches ne re-encodent rien
            book = next((x for x in self.books_list() if x["id"] == b.get("book")), None) if b.get("book") else None
            if book:
                assemble.sync_book_page(book, pid)
            return self.send_json({"ok": True, "page": assemble.read_data(store.pdir(pid) / "export"),
                                   "encoded": res.get("encoded", []), "report": res.get("report", []),
                                   "project": store.get(pid)})
        if sub == "export" and m == "POST":             # la page jouable (apercu)
            if not store.get(pid).get("geometry") or not store.path(pid, "page/page.jpg").exists():
                compose.compose(pid)
            return self.send_json(assemble.build(pid))
        if sub == "video":                              # export video MP4 de la page
            if len(parts) == 3 and m == "GET":
                p = store.get(pid)
                return self.send_json({"task": videoexport.status(pid), "videos": videoexport.list_videos(pid),
                                       "settings": videoexport.settings_of(p), "auto": videoexport.auto_duration(p)})
            if len(parts) == 3 and m == "POST":
                b = self.jbody()
                if not store.get(pid).get("geometry") or not store.path(pid, "page/page.jpg").exists():
                    compose.compose(pid)
                s = videoexport.settings_of({}, b)
                store.mutate(pid, lambda p: p.update(export={k: s[k] for k in videoexport.DEFAULTS}))
                return self.send_json(videoexport.start(pid))
            if parts[3:] == ["reveal"] and m == "POST":
                folder = store.pdir(pid) / "video"
                folder.mkdir(exist_ok=True)
                open_folder(folder)
                return self.send_json({"ok": True, "folder": str(folder)})
        if sub == "still" and m == "GET":               # une image de l'export a l'instant t (controle, vignettes)
            t = float(q.get("t") or 0)
            png = videoexport.still(pid, t, int(q.get("height") or 720))
            return self.send_bytes(png, "image/png")
        if sub == "compare" and m == "POST":           # controle : capture du lecteur contre l'image de l'export
            return self.send_json(videoexport.compare(pid, self.body(), float(q.get("t") or 0)))
        if sub == "reveal" and m == "POST":
            folder = store.pdir(pid) / "export"
            if not (folder / "index.html").exists():
                assemble.build(pid)
            open_folder(folder)
            return self.send_json({"ok": True, "folder": str(folder)})
        if sub == "publish" and m == "POST":
            b = self.jbody()
            p = store.get(pid)
            name = store.slug(b.get("name") or p.get("name") or pid)
            rep = assemble.build(pid)
            res = publish.publish_folder(store.pdir(pid) / "export", name, p.get("name", name), 1, "page.jpg")
            store.mutate(pid, lambda pp: pp.update(published={"name": name, "url": res["url"], "at": time.time()}))
            return self.send_json(dict(res, report=rep["report"]))
        raise ApiError("route projet inconnue", 404)

    @staticmethod
    def books_list():
        return json.loads(BOOKS.read_text(encoding="utf-8")) if BOOKS.exists() else []

    def books(self, m, parts, q):
        books = self.books_list()
        if len(parts) == 1:
            if m == "GET":
                return self.send_json(books)
            if m == "PUT":
                BOOKS.parent.mkdir(exist_ok=True)
                BOOKS.write_text(json.dumps(self.jbody(), indent=1, ensure_ascii=False), encoding="utf-8")
                return self.send_json({"ok": True})
        if len(parts) == 3 and parts[2] in ("export", "publish") and m == "POST":
            book = next((b for b in books if b["id"] == parts[1]), None)
            if not book or not book.get("pages"):
                raise ApiError("livre vide ou introuvable", 404)
            out = assemble.build_book(book, ROOT / "data" / "books" / book["id"])
            if parts[2] == "export":
                return self.send_json({"ok": True, "url": f"/api/books/{book['id']}/file/index.html"})
            name = store.slug(book.get("slug") or book["title"])
            first = json.loads((out / "book.js").read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))
            cover = first["pages"][0]["base"] + "page.jpg"
            res = publish.publish_folder(out, name, book["title"], len(book["pages"]), cover)
            return self.send_json(res)
        if len(parts) == 3 and parts[2] == "reveal" and m == "POST":
            open_folder(self.inside(ROOT / "data" / "books", parts[1]))
            return self.send_json({"ok": True})
        if len(parts) >= 4 and parts[2] == "file" and m in ("GET", "HEAD"):
            return self.send_file(self.inside(ROOT / "data" / "books" / parts[1], "/".join(parts[3:])))
        raise ApiError("route livre inconnue", 404)


class Server(ThreadingHTTPServer):
    """Port exclusif : sous Windows, SO_REUSEADDR laisse deux serveurs se partager le port (l'ancien
    continue alors de repondre a une partie des requetes). Un deuxieme lancement doit echouer proprement."""
    allow_reuse_address = os.name != "nt"
    daemon_threads = True

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def _console_safe():
    """Windows : un clic dans la fenetre du serveur passe la console en « selection » (QuickEdit) et suspend tout
    programme qui y ecrit -> l'application se fige. On coupe QuickEdit et on envoie le journal dans un fichier."""
    if os.name == "nt":
        try:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.GetStdHandle(-10)                       # entree de la console
            mode = ctypes.c_uint32()
            if k.GetConsoleMode(h, ctypes.byref(mode)):
                k.SetConsoleMode(h, (mode.value & ~0x0040) | 0x0080)   # sans QuickEdit, avec ENABLE_EXTENDED_FLAGS
        except (OSError, AttributeError):
            pass
    log = ROOT / "data" / "server.log"
    log.parent.mkdir(exist_ok=True)
    if log.exists() and log.stat().st_size > 5_000_000:
        log.replace(log.with_suffix(".old.log"))
    f = open(log, "a", encoding="utf-8", buffering=1)
    f.write("\n===== demarrage %s =====\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
    sys.stdout = sys.stderr = f
    return log


def main():
    cfg = settings.load()["server"]
    host, port = cfg.get("host", "127.0.0.1"), int(os.environ.get("ALIVE_PORT") or cfg.get("port", 8792))
    if not shutil.which("ffmpeg"):
        print("ATTENTION : ffmpeg introuvable dans le PATH (necessaire pour les videos et l'export)")
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}/"
    try:
        srv = Server((host, port), Handler)
    except OSError:
        print(f"Alive-Video tourne deja sur {url} : ouverture de la page. (Pour le relancer, fermer l'autre fenetre.)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    print(f"Alive-Video {VERSION} : {url}")
    print("Laisser cette fenetre ouverte (la fermer arrete l'application).")
    log = _console_safe()
    if sys.__stdout__:                                   # absent si lance sans console (pythonw)
        sys.__stdout__.write(f"Journal : {log}\n")
        sys.__stdout__.flush()
    if UPLOADS.exists():                                 # envois interrompus
        shutil.rmtree(UPLOADS, ignore_errors=True)
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
