"""Effets d'une case (onglet « Filtres » du mode edition) : definitions, nettoyage, et calcul NumPy pour l'export.

Le lecteur (player/alive-player.js, WebGL) applique EXACTEMENT les memes formules, passe par passe : toute
modification ici doit etre reportee dans les shaders FS du lecteur (et inversement). Controle : POST
/api/projects/<id>/compare (une capture du lecteur contre la meme image calculee ici, doc § 11).

Chaine d'une case, dans l'ordre :
  0. source : l'image ou la video placee dans la case (cadrage), puis la couleur de base (onglet Couleur)
  1. les effets de la pile, de haut en bas (chacun peut etre coupe sans etre retire)
  2. l'opacite : melange avec la couleur du fond de la page
Chaque passe est arrondie a 8 bits, comme dans le lecteur (une texture RGBA 8 bits par passe).
Coordonnees d'une case : u, v de 0 a 1 sur sa boite, v = 0 en HAUT ; pixel (i, j) -> ((j + .5) / W, (i + .5) / H).

Unite des tailles (flou, grain, halation, aberration) : 1 = un millieme de la hauteur de la PAGE. Le rendu ne
depend donc pas de la resolution (apercu a l'ecran ou export 4K).
"""

import math
import secrets
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GRAIN_FILE = ROOT / "player" / "grain.png"       # bruit 256 x 256 partage avec le lecteur (tools/make_grain.py)
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
SEPIA = np.array([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]], np.float32)
GRAIN_GAIN = 0.6
BLUR_MIN = 0.3                                   # sigma (pixels) en dessous duquel le flou ne fait rien

# ------------------------------------------------------------------ definitions (interface + nettoyage)
# nombre : {k, label, min, max, step, def, fmt} ; choix : {k, label, choices, def} ; couleur : {k, label, color, def} ;
# case a cocher : {k, label, bool, def}. « show » : parametre affiche seulement si un autre vaut cette valeur.
EFFECTS = [
    {"type": "blur", "label": "Flou", "hint": "Flou gaussien.", "params": [
        {"k": "amount", "label": "Rayon", "min": 0, "max": 40, "step": 0.5, "def": 6, "fmt": "u"}]},
    {"type": "colour", "label": "Couleur", "hint": "Exposition, contraste, saturation, température, teinte.", "params": [
        {"k": "exposure", "label": "Exposition", "min": -2, "max": 2, "step": 0.05, "def": 0, "fmt": "ev"},
        {"k": "contrast", "label": "Contraste", "min": 0, "max": 2, "step": 0.01, "def": 1, "fmt": "pct"},
        {"k": "saturation", "label": "Saturation", "min": 0, "max": 2, "step": 0.01, "def": 1, "fmt": "pct"},
        {"k": "temperature", "label": "Température", "min": -1, "max": 1, "step": 0.01, "def": 0, "fmt": "temp"},
        {"k": "tint", "label": "Vert ↔ magenta", "min": -1, "max": 1, "step": 0.01, "def": 0, "fmt": "tint"},
        {"k": "hue", "label": "Teinte", "min": -180, "max": 180, "step": 1, "def": 0, "fmt": "deg"}]},
    {"type": "mono", "label": "N&B · sépia · teinte", "hint": "Noir et blanc, sépia, ou une seule couleur.", "params": [
        {"k": "mode", "label": "Mode", "choices": [["bw", "Noir et blanc"], ["sepia", "Sépia"], ["tint", "Teinte"]], "def": "bw"},
        {"k": "color", "label": "Couleur", "color": True, "def": "#4f8cff", "show": ["mode", "tint"]},
        {"k": "amount", "label": "Intensité", "min": 0, "max": 1, "step": 0.01, "def": 1, "fmt": "pct"}]},
    {"type": "vignette", "label": "Vignette", "hint": "Assombrit les bords de la case.", "params": [
        {"k": "amount", "label": "Intensité", "min": 0, "max": 1, "step": 0.01, "def": 0.5, "fmt": "pct"},
        {"k": "size", "label": "Taille", "min": 0, "max": 1, "step": 0.01, "def": 0.45, "fmt": "pct"},
        {"k": "softness", "label": "Douceur", "min": 0.05, "max": 1, "step": 0.01, "def": 0.5, "fmt": "pct"}]},
    {"type": "grain", "label": "Grain", "hint": "Grain de pellicule, différent à chaque image.", "params": [
        {"k": "amount", "label": "Intensité", "min": 0, "max": 1, "step": 0.01, "def": 0.35, "fmt": "pct"},
        {"k": "size", "label": "Taille", "min": 0.5, "max": 6, "step": 0.1, "def": 1.5, "fmt": "u"},
        {"k": "animated", "label": "Animé (change à chaque image)", "bool": True, "def": True}]},
    {"type": "halation", "label": "Halation", "hint": "Halo rouge autour des hautes lumières, comme sur la pellicule.", "params": [
        {"k": "amount", "label": "Intensité", "min": 0, "max": 1, "step": 0.01, "def": 0.5, "fmt": "pct"},
        {"k": "threshold", "label": "Seuil", "min": 0, "max": 0.95, "step": 0.01, "def": 0.7, "fmt": "pct"},
        {"k": "radius", "label": "Rayon", "min": 1, "max": 60, "step": 0.5, "def": 12, "fmt": "u"},
        {"k": "color", "label": "Couleur", "color": True, "def": "#ff4a1a"}]},
    {"type": "chroma", "label": "Aberration chromatique", "hint": "Rouge et bleu décalés vers les bords.", "params": [
        {"k": "amount", "label": "Décalage", "min": 0, "max": 30, "step": 0.5, "def": 4, "fmt": "u"}]},
]
BY_TYPE = {e["type"]: e for e in EFFECTS}
MAX_FILTERS = 16


def _num(v, lo, hi, default):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    return max(lo, min(hi, x))


def _color(v, default):
    s = str(v or "").strip().lower()
    if len(s) == 7 and s[0] == "#" and all(c in "0123456789abcdef" for c in s[1:]):
        return s
    return default


def clean_filters(lst):
    """Pile d'effets recue de l'interface -> liste propre (types connus, parametres bornes et complets)."""
    out = []
    for f in lst if isinstance(lst, list) else []:
        if not isinstance(f, dict) or f.get("type") not in BY_TYPE:
            continue
        spec = BY_TYPE[f["type"]]
        fid = str(f.get("id") or "")
        if not (0 < len(fid) <= 12 and fid.isalnum()):
            fid = secrets.token_hex(3)
        e = {"id": fid, "type": f["type"], "on": f.get("on") is not False}
        for p in spec["params"]:
            k, v = p["k"], f.get(p["k"])
            if "choices" in p:
                e[k] = v if v in [c[0] for c in p["choices"]] else p["def"]
            elif p.get("color"):
                e[k] = _color(v, p["def"])
            elif p.get("bool"):
                e[k] = bool(v) if isinstance(v, bool) else p["def"]
            else:
                e[k] = round(_num(v, p["min"], p["max"], p["def"]), 4)
        out.append(e)
        if len(out) >= MAX_FILTERS:
            break
    return out


def hex_rgb(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


# ------------------------------------------------------------------ calcul (images float32 H x W x 3, 0..1)
BLUR_DIRECT = 6.0                                # au-dela (sigma en pixels), flou calcule sur une image reduite


def q8(x):
    """Arrondi 8 bits d'une passe (le lecteur ecrit chaque passe dans une texture RGBA 8 bits). Modifie x."""
    np.clip(x, 0, 1, out=x)
    x *= 255
    np.rint(x, out=x)
    x *= np.float32(1 / 255)
    return x


def uv_grid(h, w):
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    v = (np.arange(h, dtype=np.float32) + 0.5) / h
    return u, v


def resample(img, sx, sy, wrap=False):
    """Echantillonnage bilineaire SEPARABLE (comme texture2D en LINEAR) : sx (largeur de sortie) = abscisses source
    en pixels (centre du pixel 0 = 0), sy (hauteur de sortie) = ordonnees. Bords : prolonges (CLAMP_TO_EDGE) ou
    repetes (REPEAT, pour le grain)."""
    H, W = img.shape[:2]
    x0 = np.floor(sx).astype(np.int64)
    y0 = np.floor(sy).astype(np.int64)
    fx = (sx - x0).astype(np.float32)
    fy = (sy - y0).astype(np.float32)
    if wrap:
        xa, xb, ya, yb = x0 % W, (x0 + 1) % W, y0 % H, (y0 + 1) % H
    else:
        xa, xb = np.clip(x0, 0, W - 1), np.clip(x0 + 1, 0, W - 1)
        ya, yb = np.clip(y0, 0, H - 1), np.clip(y0 + 1, 0, H - 1)
    fys = fy.reshape((-1,) + (1,) * (img.ndim - 1))
    ra = img[ya]
    rows = ra + (img[yb] - ra) * fys                   # d'abord les lignes (copies contigues), puis les colonnes
    ca = rows[:, xa]
    fxs = fx.reshape((1, -1) + (1,) * (img.ndim - 2))
    return (ca + (rows[:, xb] - ca) * fxs).astype(np.float32, copy=False)


def grade_matrix(gain=1.0, contrast=1.0, sat=1.0, temp=0.0, tint=0.0, hue=0.0):
    """La formule de grade() du lecteur est affine (aucun bornage avant la fin) : out = A c + b, puis bornage.
    Etapes : gain, contraste autour du gris, saturation (luma Rec. 709), temperature (rouge <-> bleu),
    vert <-> magenta, rotation de teinte autour de l'axe des gris (formule de Rodrigues)."""
    A = np.eye(3) * gain * contrast
    b = np.full(3, 0.5 * (1 - contrast))
    L = np.outer(np.ones(3), LUMA.astype(np.float64))
    S = sat * np.eye(3) + (1 - sat) * L
    A, b = S @ A, S @ b
    b = b + np.array([0.07, 0.0, -0.07]) * temp + np.array([0.05, -0.06, 0.05]) * tint
    if hue:
        a = math.radians(hue)
        co, si, k = math.cos(a), math.sin(a), 0.57735026919
        K = np.array([[0, -k, k], [k, 0, -k], [-k, k, 0]])        # produit vectoriel par (k, k, k)
        R = co * np.eye(3) + si * K + (1 - co) * k * k * np.ones((3, 3))
        A, b = R @ A, R @ b
    return np.hstack([A, b[:, None]]).astype(np.float32)


def affine(c, M):
    """out = M[:, :3] c + M[:, 3] pour chaque pixel (une seule passe OpenCV)."""
    import cv2
    return cv2.transform(c, M)


def grade(c, gain=1.0, contrast=1.0, sat=1.0, temp=0.0, tint=0.0, hue=0.0):
    out = affine(c, grade_matrix(gain, contrast, sat, temp, tint, hue))
    return np.clip(out, 0, 1, out=out)


def base_grade(c, g):
    """Couleur de base (onglet Couleur) : {sat, bright, contrast, temp, hue}."""
    g = g or {}
    if not g:
        return c
    return grade(c, g.get("bright", 1), g.get("contrast", 1), g.get("sat", 1), g.get("temp", 0), 0, g.get("hue", 0))


def gauss_kernel(sigma):
    r = int(math.ceil(3 * sigma))
    i = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(i * i) / np.float32(2 * sigma * sigma))
    return (k / k.sum()).astype(np.float32)


def blur_plan(sigma):
    """(facteur de reduction, sigma a cette echelle) : meme regle que le lecteur."""
    f = int(math.ceil(sigma / BLUR_DIRECT)) if sigma > BLUR_DIRECT else 1
    return f, sigma / f


def blur(c, sigma):
    """Flou gaussien separable, bords prolonges, deux passes (horizontale puis verticale) arrondies a 8 bits.
    Sigma > 6 pixels : comme le lecteur, l'image est reduite d'un facteur f = ceil(sigma / 6) (bilineaire, centres
    alignes), floutee avec sigma / f, puis agrandie (bilineaire)."""
    import cv2
    if sigma < BLUR_MIN:
        return c
    h, w = c.shape[:2]
    f, s = blur_plan(sigma)
    src = c
    if f > 1:
        wl, hl = max(1, -(-w // f)), max(1, -(-h // f))
        src = q8(cv2.resize(c, (wl, hl), interpolation=cv2.INTER_LINEAR))
    k = gauss_kernel(s)
    out = q8(cv2.filter2D(src, -1, k.reshape(1, -1), borderType=cv2.BORDER_REPLICATE))
    out = q8(cv2.filter2D(out, -1, k.reshape(-1, 1), borderType=cv2.BORDER_REPLICATE))
    if f > 1:
        out = q8(cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR))
    return out


_GRAIN = None


def grain_tex():
    global _GRAIN
    if _GRAIN is None:
        from PIL import Image
        with Image.open(GRAIN_FILE) as im:
            _GRAIN = np.asarray(im.convert("L"), np.float32) / 255
    return _GRAIN


def grain_offset(k, seed):
    """Decalage du bruit pour l'image numero k (suite R2) et la case (graine) : identique dans le lecteur."""
    ox = ((k * 0.7548776662466927 + seed * 0.3819660112501051) % 1.0) * 256
    oy = ((k * 0.5698402909980532 + seed * 0.6180339887498949) % 1.0) * 256
    return ox, oy


def panel_seed(panel_id):
    """Graine du grain d'une case (deux cases n'ont pas le meme grain) : meme calcul que le lecteur."""
    s = 0
    for ch in str(panel_id):
        s = (s * 31 + ord(ch)) % 1000003
    return s % 997


_VIG = {}


def vignette_map(h, w, amount, size, softness):
    key = (h, w, amount, size, softness)
    m = _VIG.get(key)
    if m is None:
        u, v = uv_grid(h, w)
        d = np.sqrt(((u - 0.5) * 2)[None, :] ** 2 + ((v - 0.5) * 2)[:, None] ** 2) / np.float32(math.sqrt(2))
        x = np.clip((d - np.float32(size)) / np.float32(softness), 0, 1)
        m = (1 - np.float32(amount) * (x * x * (3 - 2 * x)))[..., None].astype(np.float32)
        if len(_VIG) > 64:
            _VIG.clear()
        _VIG[key] = m
    return m


def luma(c):
    return c[..., 0] * LUMA[0] + c[..., 1] * LUMA[1] + c[..., 2] * LUMA[2]


def apply(c, f, ctx):
    """Un effet sur l'image c (float32, H x W x 3). ctx : {unit (pixels par unite), units (w, h de la case en unites),
    frame (numero d'image pour le grain), seed}. Renvoie l'image arrondie a 8 bits (une ou plusieurs passes)."""
    t = f["type"]
    h, w = c.shape[:2]
    if t == "colour":
        return q8(affine(c, grade_matrix(2 ** f["exposure"], f["contrast"], f["saturation"], f["temperature"],
                                         f["tint"], f["hue"])))
    if t == "mono":
        a = float(f["amount"])
        if f["mode"] == "bw":                            # melange lineaire : une seule operation
            M = (1 - a) * np.eye(3) + a * np.outer(np.ones(3), LUMA)
            return q8(affine(c, np.hstack([M, np.zeros((3, 1))]).astype(np.float32)))
        if f["mode"] == "sepia":
            m = np.clip(affine(c, np.hstack([SEPIA, np.zeros((3, 1), np.float32)])), 0, 1)
        else:                                            # teinte : noir -> couleur (au gris moyen) -> blanc
            col = hex_rgb(f["color"])
            lum = luma(c)[..., None]
            m = np.where(lum < 0.5, col * (2 * lum), col + (1 - col) * (2 * lum - 1))
        return q8(c + (m - c) * np.float32(a))
    if t == "vignette":
        return q8(c * vignette_map(h, w, f["amount"], f["size"], f["softness"]))
    if t == "grain":
        if f["amount"] <= 0:
            return c
        u, v = uv_grid(h, w)
        k = ctx.get("frame", 0) if f.get("animated", True) else 0
        ox, oy = grain_offset(k, ctx.get("seed", 0))
        uw, uh = ctx["units"]
        size = max(0.05, f["size"])
        qx = u * np.float32(uw / size) + np.float32(ox)
        qy = v * np.float32(uh / size) + np.float32(oy)
        g = resample(grain_tex(), qx - 0.5, qy - 0.5, wrap=True)
        g -= 0.5
        g *= np.float32(f["amount"] * GRAIN_GAIN)
        return q8(c + g[..., None])
    if t == "blur":
        return blur(c, f["amount"] * ctx["unit"])
    if t == "halation":
        thr = min(0.95, f["threshold"])
        hl = q8(np.clip((luma(c) - np.float32(thr)) / np.float32(1 - thr), 0, 1).astype(np.float32))
        glow = blur(hl, f["radius"] * ctx["unit"])
        return q8(c + hex_rgb(f["color"]) * (glow * np.float32(f["amount"] * 2))[..., None])
    if t == "chroma":
        if f["amount"] <= 0:
            return c
        uw, uh = ctx["units"]
        k = f["amount"] / (0.5 * math.hypot(uw, uh))
        u, v = uv_grid(h, w)
        out = c.copy()
        for ch, s_ in ((0, 1 + k), (2, 1 - k)):
            sx = (0.5 + (u - 0.5) * np.float32(s_)) * w - 0.5
            sy = (0.5 + (v - 0.5) * np.float32(s_)) * h - 0.5
            out[..., ch] = resample(np.ascontiguousarray(c[..., ch]), sx, sy)
        return q8(out)
    return c


def chain(c, filters, ctx):
    """Pile d'effets (dans l'ordre, sauf ceux qui sont coupes)."""
    for f in filters or []:
        if f.get("on", True):
            c = apply(c, f, ctx)
    return c
