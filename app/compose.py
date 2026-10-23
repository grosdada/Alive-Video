"""Composition cote serveur (sans navigateur) : ce que l'editeur fait en canvas, en Python/Pillow.

    compose(pid) ->  project.geometry, page/page.jpg (fond, cases, images, affiche de chaque video, traits),
                     page/frames.png (traits seuls), page/thumb.jpg

Sert au pilotage par API (une autre instance remplit la planche par HTTP, sans interface) et apres un
changement de cadrage fait dans l'apercu.
"""

from PIL import Image, ImageDraw

from . import geometry as G
from . import store

Image.MAX_IMAGE_PIXELS = None


def _hex(c, default):
    c = (c or default).lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4)) if len(c) == 6 else _hex(default, default)


def _placed(img, bb, view, w, h):
    """(image redimensionnee, position) : w, h = taille du media (l'affiche d'une video est plus petite que l'original)."""
    pl = G.placement(bb, w, h, view)
    pw, ph = max(1, round(pl["w"])), max(1, round(pl["h"]))
    return img.resize((pw, ph), Image.LANCZOS), (round(pl["x"]), round(pl["y"]))


def picture(d, panel):
    """Image a poser dans la case : l'image importee, ou l'affiche (premiere image) de la video. -> (Image, w, h)."""
    v, im = panel.get("video") or {}, panel.get("image") or {}
    if v.get("poster") and (d / v["poster"]).exists():
        return Image.open(d / v["poster"]).convert("RGB"), v["w"], v["h"]
    if im.get("file") and (d / im["file"]).exists():
        pic = Image.open(d / im["file"]).convert("RGB")
        return pic, pic.width, pic.height
    return None, 0, 0


def compose(pid, panels_only=None):
    p = store.get(pid)
    d = store.pdir(pid)
    page = dict(G.PAGE_DEFAULTS, **(p.get("page") or {}))
    geo = G.compute(page, p["layout"])
    W, H = page["width"], page["height"]
    bg, stroke, sw = _hex(page.get("bg"), "#ffffff"), _hex(page.get("stroke"), "#111111"), int(page.get("strokeWidth") or 0)
    canvas = Image.new("RGB", (W, H), bg)
    frames = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for g in geo:
        panel = p["panels"].get(g["id"]) or {}
        bb, poly = g["bbox"], [tuple(pt) for pt in g["poly"]]
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        layer = Image.new("RGB", (W, H), (255, 255, 255))
        img, iw, ih = picture(d, panel)
        if img is not None:
            pic, pos = _placed(img, bb, panel.get("view"), iw, ih)
            layer.paste(pic, pos)
        canvas = Image.composite(layer, canvas, mask)
    if sw > 0:
        for g in geo:
            pts = [tuple(pt) for pt in g["poly"]] + [tuple(g["poly"][0])]
            ImageDraw.Draw(canvas).line(pts, fill=stroke, width=sw, joint="curve")
            ImageDraw.Draw(frames).line(pts, fill=stroke + (255,), width=sw, joint="curve")
    (d / "page").mkdir(exist_ok=True)
    canvas.save(d / "page" / "page.jpg", quality=92)
    frames.save(d / "page" / "frames.png")
    thumb = canvas.copy()
    thumb.thumbnail((360, 360 * H // W))
    thumb.save(d / "page" / "thumb.jpg", quality=80)

    def setgeo(pp):
        pp["geometry"] = {"size": [W, H], "panels": [
            {"id": g["id"], "order": g["order"],
             "rect": [round(v, 1) for v in (g["bbox"]["x0"], g["bbox"]["y0"], g["bbox"]["x1"], g["bbox"]["y1"])],
             "poly": [[round(x, 1), round(y, 1)] for x, y in g["poly"]]} for g in geo]}
        pp["thumb"] = f"/projects/{pid}/page/thumb.jpg"
    store.mutate(pid, setgeo)
    return {"panels": [{"id": g["id"], "order": g["order"],
                        "media": "video" if (p["panels"].get(g["id"]) or {}).get("video") else
                                 "image" if (p["panels"].get(g["id"]) or {}).get("image") else None,
                        "rect": [round(v) for v in (g["bbox"]["x0"], g["bbox"]["y0"], g["bbox"]["x1"], g["bbox"]["y1"])]}
                       for g in geo],
            "page": f"/projects/{pid}/page/page.jpg"}
