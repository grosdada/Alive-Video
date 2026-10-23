"""Ou sont le code et les donnees.

CODE : le depot (app/, player/), en lecture seule dans une application empaquetee (Mac : Alive Video.app).
HOME : les donnees de l'utilisateur (projects/, data/, local_settings.json). Par defaut le depot lui-meme, comme
avant ; la variable d'environnement ALIVE_HOME les met ailleurs (application Mac : ~/Documents/Alive Video).
"""

import os
from pathlib import Path

CODE = Path(__file__).resolve().parent.parent
HOME = Path(os.path.expanduser(os.environ.get("ALIVE_HOME") or "")).resolve() if os.environ.get("ALIVE_HOME") else CODE
DATA = HOME / "data"
