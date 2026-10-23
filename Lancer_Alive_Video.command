#!/bin/bash
# Alive-Video sur Mac : lance l'application (installation : voir mac/install.sh ou le README).
# Met d'abord l'application a jour si le Mac est en ligne (les planches, dans projects/ et data/, ne bougent pas).
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ ! -x .venv/bin/python ]; then
  echo "Alive-Video n'est pas encore installe. Dans le Terminal :"
  echo "  curl -fsSL https://raw.githubusercontent.com/grosdada/Alive-Video/main/mac/install.sh | bash"
  read -r -p "Entree pour fermer… "
  exit 1
fi
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  if git pull --ff-only -q 2>/dev/null; then
    .venv/bin/pip install -q -r requirements.txt 2>/dev/null || true
  fi
fi
echo "Alive-Video : http://127.0.0.1:8792 — laisser cette fenetre ouverte (la fermer arrete l'application)."
exec .venv/bin/python -m app
