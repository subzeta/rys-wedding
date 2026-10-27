#!/usr/bin/env python3
"""Repair missing video covers using ffmpeg, without changing the originals."""
import argparse
import getpass
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import Request, urlopen
from urllib.parse import urlencode


def repair(api_url, code):
    api_url = api_url.rstrip("/")
    token = None

    def request(path, data=None, method=None, jpeg=False):
        headers = {"User-Agent": "GalleryCoverRepair/1.0", "Origin": "https://subzeta.github.io"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if data is not None:
            headers["Content-Type"] = "image/jpeg" if jpeg else "application/json"
            if not jpeg:
                data = json.dumps(data).encode()
        return urlopen(Request(api_url + path, headers=headers, data=data, method=method), timeout=180)

    with request("/api/session", {"role": "admin", "code": code}) as response:
        token = json.load(response)["token"]
    items = []
    cursor = None
    while True:
        with request("/api/items" + ("?" + urlencode({"cursor": cursor}) if cursor else "")) as response:
            page = json.load(response)
        items.extend(item for item in page["items"] if item["kind"] == "video" and not item.get("hasPreview"))
        cursor = page["cursor"]
        if not cursor:
            break
    print(f"Vídeos sin portada: {len(items)}", flush=True)
    failed = []
    for index, item in enumerate(items, 1):
        try:
            with tempfile.TemporaryDirectory(prefix="gallery-cover-") as folder:
                original = Path(folder) / "original"
                cover = Path(folder) / "cover.jpg"
                with request(f'/api/items/{item["id"]}/original') as response, original.open("wb") as output:
                    shutil.copyfileobj(response, output, length=1024 * 1024)
                if original.stat().st_size != item["size"]:
                    raise ValueError("Original incompleto")
                for position in ("0.5", "0"):
                    result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", position, "-i", str(original), "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "5", str(cover)], capture_output=True, timeout=180)
                    if result.returncode == 0 and cover.exists() and 0 < cover.stat().st_size <= 500 * 1024:
                        break
                else:
                    raise ValueError("No se pudo extraer una portada JPEG")
                with request(f'/api/items/{item["id"]}/preview', cover.read_bytes(), method="PUT", jpeg=True) as response:
                    json.load(response)
            print(f'{index}/{len(items)} · {item["name"]}: portada guardada', flush=True)
        except Exception as error:
            failed.append(item["id"])
            print(f'{index}/{len(items)} · {item["name"]}: {type(error).__name__}', flush=True)
    print(f"Portadas reparadas: {len(items) - len(failed)}. Pendientes: {len(failed)}.", flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("api_url")
    parser.add_argument("--env-file", type=Path, help="Archivo privado local con ADMIN_CODE")
    args = parser.parse_args()
    if args.env_file:
        values = dict(line.split("=", 1) for line in args.env_file.read_text().splitlines() if "=" in line and not line.startswith("#"))
        code = values["ADMIN_CODE"].strip().strip("\"'")
    else:
        code = getpass.getpass("Código privado: ")
    repair(args.api_url, code)
