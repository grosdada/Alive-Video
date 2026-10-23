"""Entrée macOS autonome : serveur local et menu, sans Terminal."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import urllib.request
import webbrowser

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
TEST = "--test-server" in sys.argv
HOME = Path(os.environ["ALIVE_HOME"]) if TEST else Path.home() / "Documents" / "Alive Video"
os.environ["ALIVE_HOME"] = str(HOME)
os.environ["PATH"] = str(ROOT / "bin") + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin"
PORT = int(os.environ.get("ALIVE_PORT", "8792")) if TEST else 8792
URL = f"http://127.0.0.1:{PORT}/"


def existing_server():
    try:
        with urllib.request.urlopen(URL + "api/info", timeout=2) as response:
            return response.headers.get("Server", "").startswith("AliveVideo/") and "version" in json.load(response)
    except (OSError, ValueError):
        return False


def main():
    HOME.mkdir(parents=True, exist_ok=True)
    (HOME / "projects").mkdir(exist_ok=True)
    (HOME / "data").mkdir(exist_ok=True)
    if existing_server():
        if not TEST:
            webbrowser.open(URL)
        return
    # Le verrou couvre aussi les deux lancements simultanés avant que le port soit ouvert.
    lock = open(HOME / "data" / "mac.lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        import time
        for _ in range(50):
            if existing_server():
                if not TEST:
                    webbrowser.open(URL)
                return
            time.sleep(0.1)
        raise RuntimeError("Alive Video est déjà en cours de démarrage. Réessayez dans quelques secondes.")

    from app import server, videoexport
    server._console_safe()
    srv = server.Server(("127.0.0.1", PORT), server.Handler)
    if TEST:
        srv.serve_forever()
        return

    import rumps

    class AliveVideo(rumps.App):
        def __init__(self):
            super().__init__("Alive Video", title="▦", quit_button=None)
            self.menu = ["Ouvrir Alive Video", "Ouvrir le dossier des planches", None, "Quitter"]

        @rumps.clicked("Ouvrir Alive Video")
        def open_app(self, _):
            webbrowser.open(URL)

        @rumps.clicked("Ouvrir le dossier des planches")
        def open_projects(self, _):
            subprocess.Popen(["/usr/bin/open", str(HOME / "projects")])

        @rumps.clicked("Quitter")
        def quit_app(self, _):
            if videoexport.active() and rumps.alert("Un export est en cours", "Quitter interrompra cet export.",
                                                   ok="Continuer l’export", cancel="Quitter quand même") == 1:
                return
            srv.shutdown()
            srv.server_close()
            rumps.quit_application()

    threading.Thread(target=srv.serve_forever, daemon=True).start()
    webbrowser.open(URL)
    try:
        AliveVideo().run()
    finally:
        srv.shutdown()
        srv.server_close()
        lock.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        if TEST:
            raise
        import rumps
        rumps.alert("Alive Video n’a pas pu démarrer", str(exc) + "\nJournal : Documents/Alive Video/data/server.log")
        sys.exit(1)
