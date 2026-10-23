"""Deuxieme instance pour le developpement : port 8793 (l'instance de l'utilisateur est sur 8792).

    python tools/dev_instance.py

Permet de tester sans toucher a l'instance ouverte par l'utilisateur. Memes dossiers (projects/, data/) : tester sur
une COPIE de planche (projects/zz-...).
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("ALIVE_PORT", "8793")
sys.path.insert(0, str(ROOT))
sys.argv.append("--no-browser")
from app.server import main  # noqa: E402

main()
