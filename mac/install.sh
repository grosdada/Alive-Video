#!/bin/bash
# Alive-Video : installation (ou mise a jour) sur Mac, en une ligne a coller dans le Terminal :
#
#   curl -fsSL https://raw.githubusercontent.com/grosdada/Alive-Video/main/mac/install.sh | bash
#
# Installe ce qu'il faut (Homebrew, Python, ffmpeg), l'application dans ~/Alive-Video et un raccourci
# « Alive Video » sur le Bureau. Relancer la meme ligne plus tard met l'application a jour (les planches restent).
set -e
DEST="$HOME/Alive-Video"
REPO="https://github.com/grosdada/Alive-Video.git"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo ""
echo "=== Alive-Video : installation dans $DEST ==="

# 1. Homebrew (gestionnaire d'outils du Mac) : le mot de passe de la session Mac est demande une fois
if ! command -v brew >/dev/null 2>&1; then
  echo "-> Installation de Homebrew (quelques minutes, le mot de passe de la session Mac va etre demande)…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; else eval "$(/usr/local/bin/brew shellenv)"; fi
fi

# 2. Python, ffmpeg (import des videos, export), git
echo "-> Python, ffmpeg et git…"
for f in python@3.12 ffmpeg git; do
  brew list "$f" >/dev/null 2>&1 || brew install "$f"
done
PY="$(brew --prefix python@3.12)/bin/python3.12"

# 3. L'application (ou sa mise a jour)
if [ -d "$DEST/.git" ]; then
  echo "-> Mise a jour de l'application…"
  git -C "$DEST" pull --ff-only
else
  echo "-> Telechargement de l'application…"
  git clone "$REPO" "$DEST"
fi

# 4. Bibliotheques Python, dans un environnement propre a l'application
echo "-> Bibliotheques Python (Pillow, NumPy, OpenCV)…"
[ -x "$DEST/.venv/bin/python" ] || "$PY" -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q --upgrade pip
"$DEST/.venv/bin/pip" install -q -r "$DEST/requirements.txt"
chmod +x "$DEST/Lancer_Alive_Video.command"

# 5. Raccourci sur le Bureau
SHORT="$HOME/Desktop/Alive Video.command"
cat > "$SHORT" <<EOF
#!/bin/bash
exec "$DEST/Lancer_Alive_Video.command"
EOF
chmod +x "$SHORT"

echo ""
echo "=== Termine. Double-clic sur « Alive Video » (sur le Bureau) pour lancer l'application. ==="
echo "    Elle s'ouvre dans le navigateur : http://127.0.0.1:8792 (laisser la fenetre du Terminal ouverte)."
echo ""
