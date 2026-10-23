"""Icône vectorielle du site redessinée aux tailles macOS, sans outil externe."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw

out = Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (1024, 1024))
d = ImageDraw.Draw(image)
d.rounded_rectangle((64, 64, 960, 960), radius=160, fill="#b36bff")
for box in ((192, 192, 544, 480), (608, 192, 832, 832), (192, 544, 544, 832)):
    d.rectangle(box, fill="#1a0b2b")
image.save(out, format="ICNS", sizes=[(s, s) for s in (16, 32, 64, 128, 256, 512, 1024)])
