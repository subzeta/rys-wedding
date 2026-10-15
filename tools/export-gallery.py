#!/usr/bin/env python3
"""Download all originals through the private gallery API; no R2 keys required."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


def export(api_url, destination, code):
    parsed = urlparse(api_url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}):
        raise ValueError("Usa la dirección HTTPS del Worker.")
    api_url = api_url.rstrip("/")
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    def request(path, token=None, data=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        return urlopen(Request(api_url + path, data=body, headers=headers), timeout=180)

    with request("/api/session", data={"role": "admin", "code": code}) as response:
        token = json.load(response)["token"]

    cursor = None
    catalogue = []
    while True:
        query = "?" + urlencode({"cursor": cursor}) if cursor else ""
        with request("/api/items" + query, token=token) as response:
            page = json.load(response)
        for item in page["items"]:
            # One directory per ID preserves duplicate names and prevents path traversal.
            folder = destination / item["id"]
            if not re.fullmatch(r"\d{13}-[a-f0-9-]{36}", item["id"]):
                raise ValueError("Identificador de archivo no válido.")
            folder.mkdir(exist_ok=True)
            filename = item["name"].replace("\\", "/").split("/")[-1]
            if filename in {"", ".", "..", "metadata.json", ".original.part"}:
                filename = "original-" + item["id"]
            target = folder / filename
            if not target.exists() or target.stat().st_size != item["size"]:
                temporary = folder / ".original.part"
                try:
                    with request(f'/api/items/{item["id"]}/original', token=token) as response:
                        with temporary.open("wb") as output:
                            shutil.copyfileobj(response, output, length=1024 * 1024)
                    if temporary.stat().st_size != item["size"]:
                        raise ValueError("La descarga está incompleta. Ejecuta de nuevo el exportador.")
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
            (folder / "metadata.json").write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
            catalogue.append(item)
            print(f'{len(catalogue)}. {item["name"]} ✓')
        cursor = page["cursor"]
        if not cursor:
            break
    (destination / "catalogo.json").write_text(json.dumps(catalogue, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(catalogue)} originales guardados en {destination}")
    print("Comprueba la copia antes de borrar nada de Cloudflare.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("api_url", help="URL pública del Worker, sin /api")
    parser.add_argument("destination", nargs="?", default="recuerdos")
    args = parser.parse_args()
    try:
        export(args.api_url, args.destination, getpass.getpass("Código privado de Raquel y Sergio: "))
    except (HTTPError, URLError, ValueError, OSError) as error:
        print(f"No se ha completado la exportación: {error}", file=sys.stderr)
        sys.exit(1)
