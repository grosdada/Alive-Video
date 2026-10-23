"""Test réel du bundle : import H.264/AAC, effets, page jouable et export 720p.

Usage : python mac/smoke_test.py '/chemin/Alive Video.app'
Les données sont isolées dans build/smoke-data, sur le port de développement 8793.
"""
import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = Path(sys.argv[1]).resolve()
DATA = ROOT / "build" / "smoke-data"
BIN = BUNDLE / "Contents" / "Frameworks" / "bin"
BASE = "http://127.0.0.1:8793"
SOURCE = ast.parse((ROOT / "app" / "server.py").read_text())
EXPECTED_VERSION = next(ast.literal_eval(n.value) for n in SOURCE.body if isinstance(n, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == "VERSION" for t in n.targets))


def request(path, body=None, raw=False, method=None):
    req = urllib.request.Request(BASE + path, data=body if raw else json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/octet-stream" if raw else "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=180) as res:
        return json.load(res)


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    sample = DATA / "mire-son.mp4"
    subprocess.run([str(BIN / "ffmpeg"), "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", str(sample)], check=True)
    env = dict(os.environ, ALIVE_HOME=str(DATA), ALIVE_PORT="8793", PATH="/usr/bin:/bin:/usr/sbin:/sbin")
    log = open(ROOT / "build" / "smoke-launch.log", "w")
    process = subprocess.Popen([str(BUNDLE / "Contents" / "MacOS" / "Alive Video"), "--test-server"], env=env,
                               stdout=log, stderr=log)
    try:
        for _ in range(120):
            try:
                info = request("/api/info")
                break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError("Le bundle n’a pas démarré : voir build/smoke-launch.log")
                time.sleep(0.5)
        else:
            raise TimeoutError("Démarrage du bundle trop long")
        assert info["ffmpeg"] and info["version"] == EXPECTED_VERSION, info
        p = request("/api/projects", {"name": "zz-test-macos", "format": "carre", "preset": "3x2"})
        pid, panel = p["id"], next(iter(p["panels"]))
        request(f"/api/projects/{pid}/panels/{panel}/video?name=mire-son.mp4", sample.read_bytes(), raw=True)
        filters = [{"type": t} for t in ("blur", "grain", "halation", "mono")]
        request(f"/api/projects/{pid}/panels/{panel}", {"edit": {"filters": filters}})
        p = request(f"/api/projects/{pid}")
        cut = p["layout"]["id"]
        p["anim"] = {"tracks": {
            cut + ".a": [{"t": 0, "v": 0.25, "e": "ease2"}, {"t": 2, "v": 0.65}],
            cut + ".b": [{"t": 0, "v": 0.35, "e": "in2"}, {"t": 2, "v": 0.75}],
            "page.bg": [{"t": 0, "v": "#b36bff", "e": "linear"}, {"t": 2, "v": "#247dbc"}],
            "page.fill": [{"t": 0, "v": "#ffffff", "e": "linear"}, {"t": 2, "v": "#ffe8b0"}],
            "page.gutter": [{"t": 0, "v": 8, "e": "linear"}, {"t": 2, "v": 60}]}}
        request(f"/api/projects/{pid}", p, method="PUT")
        preview = request(f"/api/projects/{pid}/export", {})
        def export(folder=""):
            request(f"/api/projects/{pid}/video", {"height": 720, "fps": 25, "duration": 2, "folder": folder})
            for _ in range(240):
                result = request(f"/api/projects/{pid}/video")
                task = result["task"]
                if task["status"] == "error":
                    raise RuntimeError(task)
                if task["status"] == "done":
                    return Path(task["file"])
                time.sleep(0.5)
            raise TimeoutError("Export trop long")
        default_video = export()
        assert default_video.parent == DATA / "projects" / pid / "video"
        custom = DATA / 'Vidéos de Noël "test"'
        video = export(str(custom))
        assert video.is_file() and video.parent == custom
        assert request(f"/api/projects/{pid}/video")["folder"] == str(custom)
        global_folder = DATA / "Dossier par défaut"
        request("/api/settings", {"export": {"folder": str(global_folder)}}, method="PUT")
        fallback_video = export()
        assert fallback_video.is_file() and fallback_video.parent == global_folder
        request("/api/settings", {"export": {"folder": ""}}, method="PUT")
        request(f"/api/projects/{pid}/update", {"export": {"height": 720, "fps": 25, "duration": 2, "folder": str(custom)}})
        from urllib.parse import quote
        with urllib.request.urlopen(BASE + f"/api/projects/{pid}/video/file?name=" + quote(video.name)) as res:
            assert res.read() == video.read_bytes()
        probe = json.loads(subprocess.check_output([str(BIN / "ffprobe"), "-v", "error", "-show_streams",
                                                    "-show_format", "-of", "json", str(video)]))
        assert {s["codec_name"] for s in probe["streams"]} >= {"h264", "aac"}
        assert abs(float(probe["format"]["duration"]) - 2) < 0.2
        subprocess.run([str(BIN / "ffmpeg"), "-v", "error", "-i", str(video), "-f", "null", "-"], check=True)
        # La couleur du fond et la position des traits doivent évoluer dans le MP4.
        import numpy as np
        frames = subprocess.check_output([str(BIN / "ffmpeg"), "-v", "error", "-i", str(video),
                                         "-vf", "select='eq(n,0)+eq(n,40)'", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        frames = np.frombuffer(frames, np.uint8).reshape(2, 720, 720, 3)
        assert abs(frames[0].astype(float) - frames[1]).mean() > 5
        report = {"info": info, "project": pid, "panel": panel, "preview": preview, "video": str(video),
                  "default_video": str(default_video), "global_video": str(fallback_video), "animated": True,
                  "streams": [{k: s[k] for k in ("codec_name", "width", "height", "sample_rate") if k in s}
                              for s in probe["streams"]], "duration": probe["format"]["duration"]}
        (ROOT / "build" / "smoke-result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        process.terminate()
        process.wait(timeout=10)
        log.close()


if __name__ == "__main__":
    main()
