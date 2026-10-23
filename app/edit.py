"""Retouches d'une case, appliquees par le lecteur en direct ET par l'export video (panel["edit"]) :

  grade    {sat, bright, contrast, temp -1..1, hue degres}      couleur de base (onglet Couleur)
  range    [debut, fin] (numeros d'images de la video, inclus)  debut / fin du passage (onglet Lecture)
  loop     True (defaut) : en boucle ; False : une fois, puis figee sur la derniere image
  speed    vitesse (0,25 a 4) ; reverse : lecture a l'envers
  opacity  0..1 (melange avec le fond de la page) ; volume 0..1 (son de la video)
  filters  pile d'effets (onglet Filtres, app/effects.py)
Plus le cadrage (panel["view"] : zoom, decalage), les sons ajoutes (extraSounds), la pastille de suivi (review)
et le volume de la musique de la page.
"""

import json
import time
from pathlib import Path

from . import effects, store

GRADE = {"sat": (0, 3, 1), "bright": (0.3, 2, 1), "contrast": (0.3, 2, 1), "temp": (-1, 1, 0), "hue": (-180, 180, 0)}
USER_PRESETS = Path(__file__).resolve().parent.parent / "data" / "user_presets.json"
SPEED = (0.25, 4)


def _num(v, lo, hi, default):
    return effects._num(v, lo, hi, default)


def clean(e):
    """Retouches recues de l'apercu ou de l'application -> valeurs bornees, sans les reglages neutres."""
    if not isinstance(e, dict):
        return {}
    out = {}
    g = e.get("grade")
    if isinstance(g, dict):
        gg = {}
        for k, (lo, hi, neutral) in GRADE.items():
            if k in g:
                v = round(_num(g[k], lo, hi, neutral), 3)
                if v != neutral:
                    gg[k] = v
        if gg:
            out["grade"] = gg
    r = e.get("range")
    if isinstance(r, (list, tuple)) and len(r) == 2:
        a, b = int(_num(r[0], 0, 10 ** 7, 0)), int(_num(r[1], 0, 10 ** 7, 0))
        if b >= a:
            out["range"] = [a, b]
    if e.get("loop") is False:
        out["loop"] = False
    sp = round(_num(e.get("speed"), SPEED[0], SPEED[1], 1), 3)
    if sp != 1:
        out["speed"] = sp
    if e.get("reverse") is True:
        out["reverse"] = True
    op = round(_num(e.get("opacity"), 0, 1, 1), 3)
    if op != 1:
        out["opacity"] = op
    vol = round(_num(e.get("volume"), 0, 1, 1), 3)
    if vol != 1:
        out["volume"] = vol
    f = effects.clean_filters(e.get("filters"))
    if f:
        out["filters"] = f
    return out


def clean_view(v):
    if not isinstance(v, dict):
        return {"zoom": 1, "ox": 0, "oy": 0}
    return {"zoom": round(_num(v.get("zoom"), 1, 6, 1), 4), "ox": round(_num(v.get("ox"), -3, 3, 0), 4),
            "oy": round(_num(v.get("oy"), -3, 3, 0), 4)}


def apply(pid, panel_id, b):
    """Enregistre retouches, cadrage, sons ajoutes, suivi ; panel_id « _ » = seulement la page (volume de la musique)."""
    def upd(p):
        if panel_id != "_":
            panel = p["panels"].get(panel_id)
            if panel is None:
                raise KeyError(panel_id)
            if "edit" in b:
                panel["edit"] = clean(b["edit"])
            if isinstance(b.get("view"), dict):
                panel["view"] = clean_view(b["view"])
            if "review" in b:                        # suivi : a voir (defaut) / ok / a retoucher
                panel["review"] = b["review"] if b["review"] in ("ok", "redo") else None
            if isinstance(b.get("extra"), list):     # volumes / boucle / retrait des sons ajoutes
                have = {x.get("file"): x for x in panel.get("extraSounds") or []}
                panel["extraSounds"] = [dict(have[x["file"]], volume=round(_num(x.get("volume"), 0, 1, 0.8), 3),
                                             loop=bool(x.get("loop", True)))
                                        for x in b["extra"] if isinstance(x, dict) and x.get("file") in have]
        if b.get("pageVolume") is not None and p.get("pageSound"):
            p["pageSound"]["volume"] = round(_num(b["pageVolume"], 0, 1, 0.7), 3)
            p["pageSound"]["rev"] = time.time()
    if any(k in b for k in ("edit", "view", "extra", "pageVolume", "review")):
        store.mutate(pid, upd)


def add_extra_sound(p, panel_id, rel, name):
    panel = p["panels"].get(panel_id)
    if panel is None:
        raise KeyError(panel_id)
    panel.setdefault("extraSounds", []).append({"file": rel, "name": name, "volume": 0.8, "loop": True})


# ------------------------------------------------------------------ preréglages de l'utilisateur (toutes les planches)
def user_presets():
    """{"filters": [{name, filters: [...]}]} : piles d'effets enregistrees."""
    try:
        data = json.loads(USER_PRESETS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"filters": data.get("filters") or []}


def save_user_preset(b):
    """b : {kind: "filters", name, value: [...]} ; ou {kind, name, delete: true}. -> tous les prereglages."""
    kind, name = b.get("kind"), (b.get("name") or "").strip()[:40]
    if kind != "filters" or not name:
        raise ValueError("préréglage : kind « filters » et un nom")
    allp = user_presets()
    lst = [x for x in allp.get(kind, []) if x.get("name") != name]
    if not b.get("delete"):
        f = effects.clean_filters(b.get("value"))
        if not f:
            raise ValueError("pile d'effets vide")
        lst.append({"name": name, "filters": f})
    allp[kind] = lst
    USER_PRESETS.parent.mkdir(exist_ok=True)
    USER_PRESETS.write_text(json.dumps(allp, indent=1, ensure_ascii=False), encoding="utf-8")
    return allp
