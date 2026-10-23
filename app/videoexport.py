"""Export video de la planche : toute la page, les videos jouant dans leurs cases, en un MP4 (ffmpeg).

Le rendu reprend le lecteur passe par passe (app/effects.py = shaders du lecteur) :
  - fond de page, cases vides en blanc ;
  - chaque case avec une image ou une video : grille de calcul a la taille de sa boite (comme la texture du
    lecteur), source placee (cadrage), couleur de base, pile d'effets, puis posee dans la page (echantillonnage
    bilineaire, polygone elargi sous le trait, opacite = melange avec le fond) ;
  - les traits des cadres par-dessus.
Le temps est celui du lecteur : image n de l'export = instant n / fps ; chaque case lit l'image source_frame()
(memes regles que le lecteur : debut / fin, vitesse, a l'envers, en boucle ou figee a la fin).
Les videos sont relues dans l'ORIGINAL (pleine qualite), au meme rythme d'images que la copie de lecture.
Son : la piste de chaque video (debut / fin, vitesse avec hauteur conservee, a l'envers, volume, boucle), les sons
ajoutes des cases et la musique de la page, melanges.

Un export a la fois (file d'attente), suivi par GET /api/projects/<id>/video.
"""

import json
import math
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from . import effects as E
from . import geometry as G
from . import media, store

NOFLASH = media.NOFLASH
HEIGHTS = [480, 720, 1080, 1440, 2160]      # petit cote de la video
FPS_CHOICES = [24, 25, 30, 50, 60]
DEFAULTS = {"duration": None, "height": 1080, "fps": 30}
MAX_SECONDS = 600


# ------------------------------------------------------------------ temps (identique au lecteur)
def source_frame(edit, video, t):
    """Image de la video (numero dans le fichier) montree a l'instant t (secondes) de la case."""
    n = max(1, int(video.get("frames") or 1))
    fps = float(video.get("fps_f") or 25)
    a, b = clip_range(edit, n)
    span = b - a + 1
    k = math.floor(t * float(edit.get("speed") or 1) * fps + 1e-6)
    if edit.get("loop", True) is not False:
        k %= span
    else:
        k = max(0, min(k, span - 1))
    return b - k if edit.get("reverse") else a + k


def clip_range(edit, n):
    r = edit.get("range")
    a, b = 0, n - 1
    if isinstance(r, list) and len(r) == 2:
        a = max(0, min(n - 1, int(r[0])))
        b = max(a, min(n - 1, int(r[1])))
    return a, b


def play_seconds(panel):
    """Duree d'un passage de la video de la case (debut -> fin, a sa vitesse)."""
    v, e = panel.get("video") or {}, panel.get("edit") or {}
    if not v.get("frames"):
        return 0.0
    a, b = clip_range(e, int(v["frames"]))
    return (b - a + 1) / float(v.get("fps_f") or 25) / float(e.get("speed") or 1)


def auto_duration(p):
    """Duree par defaut de la page : le plus long passage de ses videos (5 s s'il n'y en a pas)."""
    d = max([play_seconds(pn) for pn in (p.get("panels") or {}).values()] or [0])
    return round(min(MAX_SECONDS, d), 3) if d > 0.2 else 5.0


def settings_of(p, override=None):
    s = dict(DEFAULTS, **{k: v for k, v in ((p.get("export") or {}).items()) if k in DEFAULTS})
    s.update({k: v for k, v in (override or {}).items() if k in DEFAULTS})
    h = int(s.get("height") or 1080)
    s["height"] = h if h in HEIGHTS else 1080
    fps = int(s.get("fps") or 30)
    s["fps"] = fps if fps in FPS_CHOICES else 30
    d = s.get("duration")
    try:
        d = float(d) if d not in (None, "", "auto") else None
    except (TypeError, ValueError):
        d = None
    s["duration"] = round(max(0.5, min(MAX_SECONDS, d)), 3) if d else None
    s["seconds"] = s["duration"] or auto_duration(p)
    return s


def out_size(page_w, page_h, short):
    k = short / min(page_w, page_h)
    even = lambda x: max(2, int(round(x / 2)) * 2)
    return even(page_w * k), even(page_h * k)


# ------------------------------------------------------------------ preparation de la page
def _hex(c, default="#ffffff"):
    c = (c or default).lstrip("#")
    try:
        return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255
    except ValueError:
        return _hex(default)


def _mask(poly, kx, ky, box, aa=True):
    """Masque (0..1) d'un polygone de la page dans la boite entiere box = (X0, Y0, X1, Y1) de l'export."""
    import cv2
    X0, Y0, X1, Y1 = box
    m = np.zeros((Y1 - Y0, X1 - X0), np.uint8)
    pts = np.array([[round((x * kx - 0.5 - X0) * 16), round((y * ky - 0.5 - Y0) * 16)] for x, y in poly], np.int32)
    cv2.fillPoly(m, [pts], 255, lineType=cv2.LINE_AA if aa else cv2.LINE_8, shift=4)
    return m


def _box(poly, kx, ky, W, H):
    xs, ys = [x * kx for x, _ in poly], [y * ky for _, y in poly]
    return (max(0, int(math.floor(min(xs))) - 1), max(0, int(math.floor(min(ys))) - 1),
            min(W, int(math.ceil(max(xs))) + 1), min(H, int(math.ceil(max(ys))) + 1))


def raster(bb, sx, sy):
    """Grille de calcul d'une case, alignee sur les pixels de la sortie (meme regle que le lecteur) :
    (X0, Y0, largeur, hauteur) en pixels ; sx, sy = pixels par pixel de page."""
    X0, Y0 = math.floor(bb["x0"] * sx), math.floor(bb["y0"] * sy)
    X1, Y1 = math.ceil(bb["x1"] * sx), math.ceil(bb["y1"] * sy)
    return X0, Y0, max(1, X1 - X0), max(1, Y1 - Y0)


class Panel:
    """Une case avec une image ou une video, preparee pour l'export : grille, masque, images source."""

    def __init__(self, pid, d, g, panel, page, kx, ky, W, H, unit, stroke):
        self.id, self.panel = g["id"], panel
        self.edit = panel.get("edit") or {}
        self.filters = [f for f in E.clean_filters(self.edit.get("filters")) if f.get("on", True)]
        self.video = panel.get("video") if (panel.get("video") or {}).get("file") else None
        self.image = None if self.video else panel.get("image")
        x0, y0, x1, y1 = g["rect"]
        bb = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "w": x1 - x0, "h": y1 - y0}
        self.bb = bb
        # grille de la case (= texture du lecteur), alignee sur les pixels de l'export
        self.X0, self.Y0, self.fw, self.fh = raster(bb, kx, ky)
        mw, mh = (self.video or self.image)["w"], (self.video or self.image)["h"]
        pl = G.placement(bb, mw, mh, panel.get("view"))
        # source decodee a la taille de son placement dans l'export : le pixel j de la grille tombe sur le pixel
        # X0 + j - round(x du placement) de la source (a une demi-image pres) : aucun reechantillonnage
        self.dw, self.dh = max(2, int(round(pl["w"] * kx))), max(2, int(round(pl["h"] * ky)))
        cx, cy = self.X0 - int(round(pl["x"] * kx)), self.Y0 - int(round(pl["y"] * ky))
        c0x, c0y = max(0, min(self.dw - 1, cx)), max(0, min(self.dh - 1, cy))
        c1x, c1y = max(c0x + 1, min(self.dw, cx + self.fw)), max(c0y + 1, min(self.dh, cy + self.fh))
        self.crop = (c0x, c0y, c1x - c0x, c1y - c0y)
        # bords hors de la source (case un peu plus large que l'image) : prolonges, comme CLAMP_TO_EDGE
        self.pad = (c0y - cy, cy + self.fh - c1y, c0x - cx, cx + self.fw - c1x)
        # pose dans la page : polygone elargi sous le trait (comme le lecteur), bords prolonges hors de la grille
        self.poly = G.grow(g["poly"], stroke / 2 + 1)
        self.box = _box(self.poly, kx, ky, W, H)
        X0, Y0, X1, Y1 = self.box
        self.mask = (_mask(self.poly, kx, ky, self.box).astype(np.float32) / 255)[..., None]
        self.place = (Y0 - self.Y0, self.Y0 + self.fh - Y1, X0 - self.X0, self.X0 + self.fw - X1)
        self.opacity = float(self.edit.get("opacity", 1))
        self.grade = self.edit.get("grade") or {}
        self.ctx = {"unit": unit, "units": (self.fw / kx / page["height"] * 1000, self.fh / ky / page["height"] * 1000),
                    "seed": E.panel_seed(self.id)}
        self.src = None                      # images decodees (memmap) ou image fixe
        self.first = 0

    def load(self, d, tmp, one=None):
        cx, cy, cw, ch = self.crop
        if self.image:
            from PIL import Image
            with Image.open(d / self.image["file"]) as im:
                im = im.convert("RGB")
                im = im.resize((self.dw, self.dh), Image.LANCZOS if self.dw < im.width else Image.BICUBIC)
                arr = np.asarray(im)[cy:cy + ch, cx:cx + cw]
            self.src = np.ascontiguousarray(arr)[None]
            return
        v = self.video
        n = int(v["frames"])
        a, b = clip_range(self.edit, n)
        if one is not None:                              # une seule image (apercu fixe)
            a = b = one
        raw = tmp / f"{self.id}.raw"
        flags = "area" if self.dw < v["w"] else "bicubic"
        vf = (f"fps={v['fps']},trim=start_frame={a}:end_frame={b + 1},"
              f"scale={self.dw}:{self.dh}:flags={flags},crop={cw}:{ch}:{cx}:{cy},format=rgb24")
        media.ffmpeg(["-i", str(d / v["file"]), "-map", "0:v:0", "-vf", vf, "-fps_mode", "passthrough", "-an",
                      "-f", "rawvideo", "-pix_fmt", "rgb24", str(raw)])
        count = raw.stat().st_size // (cw * ch * 3)
        if count < 1:
            raise media.MediaError(f"case {self.id} : aucune image lue dans la vidéo")
        self.src = np.memmap(raw, np.uint8, "r", shape=(count, ch, cw, 3))
        self.first = a

    def frame_at(self, t, k):
        """Image calculee de la case (grille fh x fw) a l'instant t ; k = numero d'image de l'export (grain)."""
        import cv2
        if self.video:
            idx = source_frame(self.edit, self.video, t) - self.first
            img = self.src[max(0, min(len(self.src) - 1, idx))]
        else:
            img = self.src[0]
        top, bottom, left, right = self.pad
        if top or bottom or left or right:
            img = cv2.copyMakeBorder(np.asarray(img), max(0, top), max(0, bottom), max(0, left), max(0, right),
                                     cv2.BORDER_REPLICATE)
        c = np.asarray(img, np.float32)
        c *= np.float32(1 / 255)
        c = E.q8(E.base_grade(c, self.grade))
        return E.chain(c, self.filters, dict(self.ctx, frame=k))

    def compose(self, frame, c, bg):
        """Pose la case calculee dans l'image de la page (uint8), opacite = melange avec le fond."""
        import cv2
        top, bottom, left, right = self.place
        if top < 0 or bottom < 0 or left < 0 or right < 0:          # le polygone elargi deborde de la grille
            c = cv2.copyMakeBorder(c, max(0, -top), max(0, -bottom), max(0, -left), max(0, -right), cv2.BORDER_REPLICATE)
            top, bottom, left, right = max(0, top), max(0, bottom), max(0, left), max(0, right)
        hh, ww = c.shape[:2]
        c = c[top:hh - bottom, left:ww - right]
        X0, Y0, X1, Y1 = self.box
        if self.opacity < 1:
            c = bg + (c - bg) * np.float32(self.opacity)
        reg = frame[Y0:Y1, X0:X1].astype(np.float32) * np.float32(1 / 255)
        reg += (c - reg) * self.mask
        reg *= 255
        np.rint(reg, out=reg)
        frame[Y0:Y1, X0:X1] = np.clip(reg, 0, 255).astype(np.uint8)


def prepare(pid, s, tmp, still=None, log=print):
    """Tout ce qui ne change pas d'une image a l'autre. still = instant d'une image seule (apercu fixe)."""
    p = store.get(pid)
    d = store.pdir(pid)
    geo = p.get("geometry") or {}
    if not geo.get("panels"):
        from . import compose
        compose.compose(pid)
        p = store.get(pid)
        geo = p["geometry"]
    page = dict(G.PAGE_DEFAULTS, **(p.get("page") or {}))
    PW, PH = geo["size"]
    page["width"], page["height"] = PW, PH
    W, H = out_size(PW, PH, s["height"])
    kx, ky = W / PW, H / PH
    unit = H / 1000
    stroke = float(page.get("strokeWidth") or 0)
    bg = _hex(page.get("bg"), "#ffffff")
    base = np.empty((H, W, 3), np.float32)
    base[:] = bg
    panels = []
    for g in geo["panels"]:
        panel = (p.get("panels") or {}).get(g["id"]) or {}
        has = (panel.get("video") or {}).get("file") or (panel.get("image") or {}).get("file")
        if not has:                                       # case vide : papier blanc (comme l'image de la page)
            box = _box(g["poly"], kx, ky, W, H)
            m = (_mask(g["poly"], kx, ky, box).astype(np.float32) / 255)[..., None]
            X0, Y0, X1, Y1 = box
            base[Y0:Y1, X0:X1] = base[Y0:Y1, X0:X1] * (1 - m) + m
            continue
        panels.append(Panel(pid, d, g, panel, page, kx, ky, W, H, unit, stroke))
    # traits des cadres : bande entre le polygone decale de +w/2 et celui de -w/2 (coins en onglet)
    import cv2
    smask = np.zeros((H, W), np.uint8)
    if stroke > 0:
        for g in geo["panels"]:
            outer = G.offset(g["poly"], stroke / 2)
            inner = G.offset(g["poly"], -stroke / 2)
            to = lambda poly: np.array([[round((x * kx - 0.5) * 16), round((y * ky - 0.5) * 16)] for x, y in poly], np.int32)
            cv2.fillPoly(smask, [to(outer)], 255, lineType=cv2.LINE_AA, shift=4)
            cv2.fillPoly(smask, [to(inner)], 0, lineType=cv2.LINE_AA, shift=4)
    flat = np.flatnonzero(smask.reshape(-1))
    stroke_px = (flat, (smask.reshape(-1)[flat].astype(np.float32) / 255)[:, None], _hex(page.get("stroke"), "#111111"))
    # sources : une case par fil (chaque decodage est un processus ffmpeg)
    t_still = still

    def load(pn):
        pn.load(d, tmp, source_frame(pn.edit, pn.video, t_still) if (still is not None and pn.video) else None)
    with ThreadPoolExecutor(max_workers=max(1, min(4, os.cpu_count() or 2))) as ex:
        list(ex.map(load, panels))
    base = np.rint(np.clip(base, 0, 1) * 255).astype(np.uint8)
    return {"p": p, "d": d, "W": W, "H": H, "base": base, "bg": bg, "panels": panels, "stroke": stroke_px,
            "page": page}


def render(P, n, fps):
    """Image n de l'export (uint8 H x W x 3)."""
    t = n / fps
    out = P["base"].copy()
    for pn in P["panels"]:
        pn.compose(out, pn.frame_at(t, n), P["bg"])
    flat, a, sc = P["stroke"]
    if len(flat):
        o = out.reshape(-1, 3)
        o[flat] = np.rint(o[flat].astype(np.float32) * (1 - a) + sc * 255 * a).astype(np.uint8)
    return out


def still(pid, t=0.0, height=720, overrides=None):
    """Une image de l'export a l'instant t (PNG), par le meme calcul : controle lecteur / export, vignettes."""
    from PIL import Image
    import io
    p = store.get(pid)
    s = settings_of(p, dict(overrides or {}, height=height))
    tmp = Path(tempfile.mkdtemp(prefix="av-still-", dir=store.pdir(pid)))
    try:
        P = prepare(pid, s, tmp, still=t)
        n = int(round(t * s["fps"]))
        img = render(P, n, s["fps"])
        for pn in P["panels"]:
            pn.src = None
        buf = io.BytesIO()
        Image.fromarray(img).save(buf, "PNG")
        return buf.getvalue()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def compare(pid, png, t):
    """Controle lecteur / export : png = la page capturee dans le lecteur (AlivePlayer.capture) a l'instant t, a la
    taille de l'export. Meme image calculee ici, puis ecarts (0..255) par case, loin des traits (ou le lecteur pose
    frames.png et l'export trace les traits lui-meme). Images gardees dans projects/<id>/compare/."""
    import io
    import cv2
    from PIL import Image
    cap = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
    H, W = cap.shape[:2]
    p = store.get(pid)
    s = settings_of(p)
    s["height"] = min(W, H)
    out = store.pdir(pid) / "compare"
    out.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="av-cmp-", dir=store.pdir(pid)))
    try:
        P = prepare(pid, s, tmp, still=t)
        if (P["W"], P["H"]) != (W, H):
            raise ValueError(f"capture {W}x{H}, export {P['W']}x{P['H']} : capturer a la taille de l'export")
        n = int(round(t * s["fps"]))
        exp = render(P, n, s["fps"])
        flat = P["stroke"][0]
        stroke = np.zeros(H * W, np.uint8)
        stroke[flat] = 255
        stroke = cv2.dilate(stroke.reshape(H, W), np.ones((7, 7), np.uint8))
        diff = np.abs(cap.astype(np.int16) - exp.astype(np.int16)).astype(np.uint8)
        stats = []
        for pn in P["panels"]:
            X0, Y0, X1, Y1 = pn.box
            zone = (pn.mask[..., 0] > 0.99) & (stroke[Y0:Y1, X0:X1] == 0)
            d = diff[Y0:Y1, X0:X1][zone]
            if not d.size:
                continue
            stats.append({"panel": pn.id, "pixels": int(zone.sum()), "mean": round(float(d.mean()), 3),
                          "p99": int(np.percentile(d, 99)), "max": int(d.max()),
                          "filters": [f["type"] for f in pn.filters]})
        for pn in P["panels"]:
            pn.src = None
        Image.fromarray(cap).save(out / "lecteur.png")
        Image.fromarray(exp).save(out / "export.png")
        Image.fromarray(np.clip(diff.astype(np.int32) * 8, 0, 255).astype(np.uint8)).save(out / "ecart-x8.png")
        return {"t": t, "size": [W, H], "panels": stats, "folder": str(out)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ son
def _tempo(speed):
    out, s = [], float(speed)
    while s > 2.0:
        out.append("atempo=2.0"); s /= 2.0
    while s < 0.5:
        out.append("atempo=0.5"); s /= 0.5
    if abs(s - 1) > 1e-6:
        out.append(f"atempo={s:.6f}")
    return out


def build_audio(P, s, tmp, export_dir, log=print):
    """Melange des sons de la page -> fichier m4a (ou None s'il n'y a aucun son)."""
    D = s["seconds"]
    inputs, chains = [], []
    p, d = P["p"], P["d"]
    for pn in P["panels"]:
        v, e = pn.video, pn.edit
        vol = float(e.get("volume", 1))
        if not v or not v.get("audio") or vol <= 0:
            continue
        a, b = clip_range(e, int(v["frames"]))
        fps = float(v["fps_f"])
        wav = tmp / f"a_{pn.id}.wav"
        af = [f"atrim=start={a / fps:.6f}:end={(b + 1) / fps:.6f}", "asetpts=PTS-STARTPTS"]
        if e.get("reverse"):
            af.append("areverse")
        af += _tempo(e.get("speed") or 1)
        af += ["aresample=48000", "aformat=sample_fmts=s16:channel_layouts=stereo"]
        try:
            media.ffmpeg(["-i", str(d / v["file"]), "-map", "0:a:0", "-vn", "-af", ",".join(af), "-c:a", "pcm_s16le", str(wav)])
        except media.MediaError as ex:
            log(f"case {pn.id} : son illisible ({ex})")
            continue
        loop = e.get("loop", True) is not False
        inputs.append((wav, loop, vol))
    data = None
    try:
        from . import assemble
        data = assemble.read_data(export_dir)
    except (OSError, ValueError):
        pass
    if data:
        for entry in data.get("panels") or []:
            for x in entry.get("more") or []:
                inputs.append((export_dir / x["src"], bool(x.get("loop", True)), float(x.get("vol", 0.8))))
        if data.get("sound"):
            inputs.append((export_dir / data["sound"]["src"], True, float(data["sound"].get("vol", 0.7))))
    inputs = [x for x in inputs if Path(x[0]).exists()]
    if not inputs:
        return None
    args, parts = [], []
    for i, (f, loop, vol) in enumerate(inputs):
        args += (["-stream_loop", "-1"] if loop else []) + ["-i", str(f)]
        parts.append(f"[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={vol:.4f},"
                     f"apad,atrim=0:{D:.6f}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(inputs)))
    graph = ";".join(parts) + f";{mix}amix=inputs={len(inputs)}:normalize=0:duration=longest,atrim=0:{D:.6f},alimiter=limit=0.98[out]"
    out = tmp / "audio.m4a"
    media.ffmpeg([*args, "-filter_complex", graph, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(out)])
    return out


# ------------------------------------------------------------------ export complet
def export(pid, s, progress=lambda f, m="": None, log=print):
    from . import assemble
    d = store.pdir(pid)
    outdir = d / "video"
    outdir.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="_tmp-", dir=outdir))
    try:
        progress(0.01, "préparation de la page")
        assemble.build(pid)                               # sons egalises (les memes que le lecteur)
        P = prepare(pid, s, tmp, log=log)
        fps, D = s["fps"], s["seconds"]
        N = max(1, int(round(D * fps)))
        W, H = P["W"], P["H"]
        progress(0.12, "rendu des images")
        vid = tmp / "video.mp4"
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps),
               "-i", "pipe:0", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264",
               "-preset", "medium", "-crf", "18", "-g", str(fps * 2), "-colorspace", "bt709", "-color_primaries", "bt709",
               "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", str(vid)]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, **NOFLASH)
        err = []
        threading.Thread(target=lambda: err.append(proc.stderr.read()), daemon=True).start()
        import cv2
        threads = cv2.getNumThreads()
        cv2.setNumThreads(1)
        workers = max(1, min(8, (os.cpu_count() or 2) - 1))
        t0 = time.time()
        try:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                pending = {}
                nxt = 0
                for n in range(N):
                    while nxt < N and len(pending) < workers * 2:
                        pending[nxt] = ex.submit(render, P, nxt, fps)
                        nxt += 1
                    img = pending.pop(n).result()
                    try:
                        proc.stdin.write(img.tobytes())
                    except (BrokenPipeError, OSError):
                        raise media.MediaError("encodeur arrêté : " + (b"".join(err).decode("utf-8", "replace")[-600:]))
                    if n % 5 == 0 or n == N - 1:
                        el = time.time() - t0
                        left = el / (n + 1) * (N - n - 1)
                        progress(0.12 + 0.8 * (n + 1) / N, f"image {n + 1} / {N} · reste ~{int(left)} s")
        finally:
            cv2.setNumThreads(threads)
            try:
                proc.stdin.close()
            except OSError:
                pass
            proc.wait()
        if proc.returncode:
            raise media.MediaError("encodage : " + b"".join(err).decode("utf-8", "replace")[-800:])
        for pn in P["panels"]:
            pn.src = None                                  # libere les fichiers d'images avant de les effacer
        progress(0.94, "mixage des sons")
        aud = build_audio(P, s, tmp, d / "export", log=log)
        name = f"{store.slug(P['p'].get('name') or pid)}-{time.strftime('%Y%m%d-%H%M%S')}.mp4"
        final = outdir / name
        if aud:
            media.ffmpeg(["-i", str(vid), "-i", str(aud), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest",
                          "-movflags", "+faststart", str(final)])
        else:
            shutil.move(str(vid), str(final))
        progress(1.0, "terminé")
        return final, {"width": W, "height": H, "fps": fps, "seconds": D, "frames": N, "audio": bool(aud)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ file d'attente (un export a la fois)
_tasks = {}
_lock = threading.Lock()
_queue = queue.Queue()
_worker = None


def _run():
    while True:
        pid = _queue.get()
        task = _tasks.get(pid)
        if not task or task["status"] != "queued":
            continue
        task.update(status="running", started=time.time(), progress=0.0, message="démarrage")

        def prog(f, m=""):
            task.update(progress=round(f, 4), message=m)
        try:
            final, meta = export(pid, task["settings"], prog)
            task.update(status="done", finished=time.time(), file=f"video/{final.name}",
                        url=f"/projects/{pid}/video/{final.name}", meta=meta, progress=1.0, message="terminé")
        except Exception as e:                       # noqa: BLE001
            traceback.print_exc()
            task.update(status="error", finished=time.time(), error=str(e)[-800:], message="erreur")


def start(pid, override=None):
    global _worker
    p = store.get(pid)
    s = settings_of(p, override)
    with _lock:
        cur = _tasks.get(pid)
        if cur and cur["status"] in ("queued", "running"):
            raise ValueError("un export de cette planche est déjà en cours")
        _tasks[pid] = {"project": pid, "status": "queued", "progress": 0.0, "message": "en file", "settings": s,
                       "created": time.time()}
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, daemon=True, name="export-video")
            _worker.start()
    _queue.put(pid)
    return dict(_tasks[pid])


def status(pid):
    t = _tasks.get(pid)
    return dict(t) if t else None


def active():
    return [dict(t) for t in _tasks.values() if t["status"] in ("queued", "running")]


def list_videos(pid):
    d = store.pdir(pid) / "video"
    if not d.exists():
        return []
    out = []
    for f in sorted(d.glob("*.mp4"), key=lambda f: -f.stat().st_mtime):
        out.append({"name": f.name, "url": f"/projects/{pid}/video/{f.name}", "size": f.stat().st_size,
                    "time": f.stat().st_mtime})
    return out
