"""Fabrique player/grain.png : le bruit du grain, partage par le lecteur (WebGL) et l'export (app/effects.py).

    python tools/make_grain.py

256 x 256 (puissance de 2 : repetable en WebGL 1), gris 8 bits, bruit gaussien centre sur 128, sans structure :
se repete sans raccord visible. Graine fixe : le fichier est toujours le meme.
"""
from pathlib import Path

import numpy as np
from PIL import Image

out = Path(__file__).resolve().parent.parent / "player" / "grain.png"
rng = np.random.default_rng(1987)
g = np.clip(np.rint(128 + rng.normal(0, 46, (256, 256))), 0, 255).astype(np.uint8)
Image.fromarray(g).save(out, optimize=True)
print(out, g.mean(), g.std())
