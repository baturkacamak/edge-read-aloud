#!/usr/bin/env python3
"""Build a store-ready ZIP of the extension.

Usage:
    python3 scripts/package.py

Output:
    dist/sesli-oku-<version>.zip
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

INCLUDE = [
    "manifest.json",
    "icons",
    "src",
    "LICENSE",
    "NOTICE",
    "PRIVACY.md",
]


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    output = ROOT / "dist" / f"sesli-oku-{version}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)

    if output.exists():
        output.unlink()

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in INCLUDE:
            path = ROOT / item
            if path.is_dir():
                for file in sorted(path.rglob("*")):
                    if file.is_file() and not file.name.startswith("."):
                        archive.write(file, file.relative_to(ROOT))
            elif path.is_file():
                archive.write(path, path.relative_to(ROOT))
            else:
                raise SystemExit(f"Missing file: {path}")

    print(f"created {output} ({output.stat().st_size / 1024:.1f} KiB)")
    with zipfile.ZipFile(output) as archive:
        for name in archive.namelist():
            print(f"  {name}")


if __name__ == "__main__":
    main()
