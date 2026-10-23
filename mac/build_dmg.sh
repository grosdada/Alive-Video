#!/bin/bash
# Fabrique une app autonome, signée ad hoc, et son image disque.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ARCH="$(uname -m)"
[[ "$ARCH" == arm64 ]] || { echo 'Ce script construit actuellement la version Apple Silicon (arm64).' >&2; exit 1; }
PYTHON="${PYTHON:-python3}"
[[ -x .venv/bin/python ]] || "$PYTHON" -m venv .venv
.venv/bin/python -m pip install -r mac/requirements-build.txt
mkdir -p mac/vendor build dist

download_tool() {
    local name="$1" expected="$2"
    if [[ ! -f "mac/vendor/$name" ]]; then
        curl -fL --retry 3 "https://www.osxexperts.net/${name}9arm.zip" -o "mac/vendor/$name.zip"
        unzip -oq "mac/vendor/$name.zip" -d mac/vendor
    fi
    echo "$expected  mac/vendor/$name" | shasum -a 256 -c -
    chmod +x "mac/vendor/$name"
    # Les outils doivent dépendre exclusivement des bibliothèques système macOS.
    if otool -L "mac/vendor/$name" | tail -n +2 | grep -E '/opt/|/usr/local/|/Users/'; then
        echo "Dépendance externe interdite dans $name" >&2; exit 1
    fi
}
download_tool ffmpeg 591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e
download_tool ffprobe e11c17e8200b3ee4c4c186d245e2b4053f01d56957336c1817fca0b997469106
mac/vendor/ffmpeg -hide_banner -encoders > build/encoders.txt 2>&1
mac/vendor/ffmpeg -hide_banner -filters > build/filters.txt 2>&1
for codec in libx264 aac libmp3lame; do grep -q "$codec" build/encoders.txt; done
grep -q loudnorm build/filters.txt
mkdir -p build/mac-build
mac/vendor/ffmpeg -version > build/mac-build/ffmpeg-version.txt 2>&1
mac/vendor/ffmpeg -L > build/mac-build/ffmpeg-license.txt 2>&1
.venv/bin/python -m pip freeze > build/mac-build/python-packages.txt
git rev-parse HEAD > build/mac-build/source-commit.txt
.venv/bin/python mac/make_icon.py build/AliveVideo.icns
VERSION="$(.venv/bin/python -c 'import ast; t=ast.parse(open("app/server.py").read()); print(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=="VERSION" for x in n.targets)))')"
DATE="${BUILD_DATE:-$(TZ=Europe/Paris date +%Y%m%d)}"
export PYINSTALLER_CONFIG_DIR="$ROOT/build/pyinstaller-cache"
.venv/bin/python -m PyInstaller --noconfirm --clean --windowed --onedir \
    --name 'Alive Video' --osx-bundle-identifier fr.grosdada.alivevideo \
    --icon "$ROOT/build/AliveVideo.icns" --paths "$ROOT" --specpath build \
    --add-data "$ROOT/app/web:app/web" --add-data "$ROOT/player:player" \
    --add-data "$ROOT/docs:docs" --add-data "$ROOT/mac/LISEZ-MOI.txt:." \
    --add-data "$ROOT/build/mac-build:docs/mac-build" \
    --add-binary "$ROOT/mac/vendor/ffmpeg:bin" --add-binary "$ROOT/mac/vendor/ffprobe:bin" \
    --copy-metadata Pillow --copy-metadata numpy --copy-metadata opencv-python-headless \
    --copy-metadata rumps --copy-metadata pyobjc-core --copy-metadata pyobjc-framework-Cocoa \
    --exclude-module tkinter --collect-all rumps --hidden-import AppKit --hidden-import Foundation mac/launcher.py
.venv/bin/python - "$VERSION" <<'PY'
import plistlib, sys
from pathlib import Path
p = Path('dist/Alive Video.app/Contents/Info.plist')
d = plistlib.loads(p.read_bytes())
d.update(CFBundleShortVersionString=sys.argv[1], CFBundleVersion=sys.argv[1], LSUIElement=True,
         NSHighResolutionCapable=True, LSMinimumSystemVersion='14.0',
         NSDesktopFolderUsageDescription='Alive Video exporte vos vidéos dans le dossier du Bureau que vous choisissez.',
         NSDocumentsFolderUsageDescription='Alive Video enregistre vos planches et vidéos dans Documents/Alive Video.')
p.write_bytes(plistlib.dumps(d))
PY
codesign --force --deep --sign - 'dist/Alive Video.app'
codesign --verify --deep --strict --verbose=2 'dist/Alive Video.app'
STAGE="$ROOT/build/dmg"
rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto 'dist/Alive Video.app' "$STAGE/Alive Video.app"
ln -s /Applications "$STAGE/Applications"
cp mac/LISEZ-MOI.txt "$STAGE/Lisez-moi.txt"
DMG="$ROOT/dist/Alive-Video-$VERSION-$DATE-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -volname 'Alive Video' -srcfolder "$STAGE" -ov -format UDZO "$DMG"
hdiutil verify "$DMG"
shasum -a 256 "$DMG" > "$DMG.sha256"
echo "Livraison : $DMG"
if [[ "${COPY_TO_DESKTOP:-0}" == 1 ]]; then
    cp "$DMG" "$HOME/Desktop/"
fi
