"""Videos importees dans les cases : analyse, copie de lecture, image d'affiche, version a l'envers.

L'original reste dans assets/ : l'export video le relit en pleine qualite. Le lecteur lit une copie legere :
  proxies/<nom>.mp4      H.264, 1280 px au plus, images/s constantes, couleurs converties en BT.709 et balisees,
                         une image cle toutes les 15 (sauts rapides), son AAC stereo s'il y en a un
  proxies/<nom>.jpg      la premiere image (editeur, image de la page, vignette)
  proxies/<nom>.rev.mp4  la copie a l'envers (« Lecture inversee »), faite a la demande, par morceaux
Couleurs : la copie passe par le RGB tel que ffmpeg le lit (comme l'export, qui relit l'original en RGB) :
le lecteur et l'export voient les memes couleurs, meme pour une video sans balise de couleur.
Images/s : la copie et l'export appliquent le meme filtre fps a l'original : l'image n de la copie est
l'image n de l'export (temps = n / fps), base commune du lecteur et de l'export.
"""

import json
import os
import shutil
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

NOFLASH = {"creationflags": 0x08000000} if os.name == "nt" else {}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpg", ".mpeg", ".mts", ".m2ts", ".wmv", ".flv", ".ogv", ".gif"}
PROXY_MAX = 1280
MAX_FPS = 60
BT709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"   # balises completes (matrice, primaires, transfert)


class MediaError(RuntimeError):
    pass


def run(args, timeout=None):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, **NOFLASH)
    if r.returncode:
        raise MediaError((r.stderr or r.stdout or "erreur")[-1500:])
    return r.stdout


def ffmpeg(args, timeout=None):
    return run(["ffmpeg", "-v", "error", "-y", *args], timeout)


def _rate(s):
    try:
        f = Fraction(s)
        return f if f > 0 else None
    except (ValueError, ZeroDivisionError, TypeError):
        return None


def probe(path):
    """{w, h (a l'affichage, rotation comprise), fps (texte pour ffmpeg), fps_f, duration, audio}."""
    out = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)])
    info = json.loads(out)
    vs = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"
               and not (s.get("disposition") or {}).get("attached_pic")), None)
    if not vs:
        raise MediaError("aucune piste vidéo dans ce fichier")
    w, h = int(vs.get("width") or 0), int(vs.get("height") or 0)
    rot = 0
    for sd in vs.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    rot = rot or int(float((vs.get("tags") or {}).get("rotate", 0) or 0))
    if abs(rot) % 180 == 90:
        w, h = h, w
    sar = _rate((vs.get("sample_aspect_ratio") or "1:1").replace(":", "/")) or Fraction(1)
    if sar != 1 and sar > 0:                            # pixels non carres : largeur a l'affichage
        w = int(round(w * sar))
    fps = _rate(vs.get("avg_frame_rate")) or _rate(vs.get("r_frame_rate")) or Fraction(25)
    if fps > MAX_FPS:
        fps = Fraction(MAX_FPS)
    fps = fps.limit_denominator(1001)
    dur = float(vs.get("duration") or (info.get("format") or {}).get("duration") or 0)
    audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    if not (w and h):
        raise MediaError("dimensions de la vidéo illisibles")
    return {"w": w, "h": h, "fps": f"{fps.numerator}/{fps.denominator}", "fps_f": float(fps), "duration": dur,
            "audio": audio, "square": sar == 1}


def count_frames(path):
    out = run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
               "stream=nb_read_packets,width,height", "-of", "json", str(path)])
    s = json.loads(out)["streams"][0]
    return int(s["nb_read_packets"]), int(s["width"]), int(s["height"])


def prepare(src, proxies_dir, stem):
    """Copie de lecture + image d'affiche d'une video importee -> infos de la case (chemins relatifs au projet)."""
    src, proxies_dir = Path(src), Path(proxies_dir)
    proxies_dir.mkdir(parents=True, exist_ok=True)
    info = probe(src)
    proxy, poster = proxies_dir / f"{stem}.mp4", proxies_dir / f"{stem}.jpg"
    square = "" if info["square"] else "scale='trunc(iw*sar/2)*2':ih,setsar=1,"     # pixels non carres d'abord
    vf = (f"{square}fps={info['fps']},scale='min({PROXY_MAX},iw)':'min({PROXY_MAX},ih)':force_original_aspect_ratio=decrease:"
          f"force_divisible_by=2:flags=bicubic,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
          f"setsar=1,{BT709}")
    args = ["-i", str(src), "-map", "0:v:0", "-vf", vf, "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "20", "-g", "15", "-keyint_min", "1", "-pix_fmt", "yuv420p", "-colorspace", "bt709",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    if info["audio"]:
        args += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]
    ffmpeg(args + ["-movflags", "+faststart", str(proxy)])
    frames, pw, ph = count_frames(proxy)
    if frames < 1:
        raise MediaError("vidéo vide")
    ffmpeg(["-i", str(proxy), "-frames:v", "1", "-q:v", "3", str(poster)])
    rel = proxies_dir.name
    return {"proxy": f"{rel}/{proxy.name}", "poster": f"{rel}/{poster.name}", "w": info["w"], "h": info["h"],
            "pw": pw, "ph": ph, "fps": info["fps"], "fps_f": round(info["fps_f"], 6), "frames": frames,
            "duration": round(frames / info["fps_f"], 4), "audio": info["audio"]}


def reverse_path(proxy):
    p = Path(proxy)
    return p.with_name(p.stem + ".rev.mp4")


def ensure_reverse(proxy, info, log=print):
    """Copie de lecture a l'envers (image n -> image frames-1-n), faite par morceaux de 2 s (le filtre reverse
    garde tout en memoire) ; le son est inverse d'un bloc. Rien a refaire si elle existe deja."""
    proxy = Path(proxy)
    dst = reverse_path(proxy)
    if dst.exists() and dst.stat().st_mtime >= proxy.stat().st_mtime:
        return dst
    fps, n = Fraction(info["fps"]), int(info["frames"])
    chunk = max(8, int(round(2 * fps)))
    tmp = Path(tempfile.mkdtemp(prefix="av-rev-", dir=proxy.parent))
    try:
        parts = []
        for k, start in enumerate(range(0, n, chunk)):
            cnt = min(chunk, n - start)
            seg = tmp / f"s{k:05d}.mp4"
            ffmpeg(["-ss", f"{float(start / fps):.6f}", "-i", str(proxy), "-map", "0:v:0", "-vf",
                    f"trim=end_frame={cnt},reverse,setpts=N/FRAME_RATE/TB,{BT709}", "-r", info["fps"], "-c:v", "libx264",
                    "-preset", "veryfast", "-crf", "20", "-g", "15", "-pix_fmt", "yuv420p", "-colorspace", "bt709",
                    "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-an", str(seg)])
            parts.append(seg)
        lst = tmp / "list.txt"
        lst.write_text("".join(f"file '{p.name}'\n" for p in reversed(parts)), encoding="utf-8")
        vrev = tmp / "v.mp4"
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(vrev)])
        out = tmp / "out.mp4"
        if info.get("audio"):
            ffmpeg(["-i", str(vrev), "-i", str(proxy), "-map", "0:v:0", "-map", "1:a:0", "-af", "areverse", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(out)])
        else:
            ffmpeg(["-i", str(vrev), "-c", "copy", "-movflags", "+faststart", str(out)])
        out.replace(dst)
        log(f"lecture inversée prête : {dst.name}")
        return dst
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
