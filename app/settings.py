"""Reglages propres au poste : local_settings.json dans le dossier des donnees (paths.HOME : le depot par defaut,
jamais versionne).

Aucune cle d'IA ni de service de calcul : Alive-Video ne genere rien. Restent le serveur (port 8792, a cote
d'Alive-Comics sur 8790) et la publication SSH.
"""

import copy
import json
import threading

from .paths import HOME

FILE = HOME / "local_settings.json"
_lock = threading.Lock()

DEFAULTS = {
    "server": {"host": "127.0.0.1", "port": 8792},
    "deploy": {"host": "", "port": 65002, "user": "", "key": "~/.ssh/alive_comics_hostinger", "root": "", "url": ""},
    "export": {"folder": ""},          # dossier des videos exportees ; vide = le dossier video/ de chaque planche
}
SECRET_PATHS = []


def _merge(base, extra):
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load():
    with _lock:
        data = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else {}
    return _merge(DEFAULTS, data)


def save(data):
    with _lock:
        FILE.parent.mkdir(parents=True, exist_ok=True)
        FILE.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")


def _get(d, path):
    for k in path:
        d = d.get(k, {}) if isinstance(d, dict) else {}
    return d if isinstance(d, str) else ""


def _set(d, path, value):
    for k in path[:-1]:
        d = d.setdefault(k, {})
    d[path[-1]] = value


def mask(key):
    return ("••••" + key[-4:]) if key else ""


def public():
    data = load()
    for path in SECRET_PATHS:
        _set(data, path, mask(_get(data, path)))
    return data


def update(patch):
    """Applique un patch venant de l'interface. Une cle masquee (••••) ou absente garde l'ancienne valeur."""
    data = load()
    new = _merge(data, patch)
    for path in SECRET_PATHS:
        v = _get(new, path)
        if v.startswith("••••"):
            _set(new, path, _get(data, path))
    save(new)
    return public()
