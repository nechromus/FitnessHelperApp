#!/usr/bin/env python3
"""Setzt eine neue App-Version – vor jedem Commit, der die App ändert.

Aufruf:  python3 tools/bump_version.py "Kurz, was neu ist"

Version = JJJJ.MM.TT-N (N zählt hoch, wenn am selben Tag schon eine Version existiert).
Aktualisiert version.json, src/version.js und alle ?v=… in index.html und src/*.js,
damit das iPhone nach dem Update garantiert die neuen Dateien lädt.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = r"\d{4}\.\d{2}\.\d{2}-\d+"


def next_version(current: str, today: str) -> str:
    if current.startswith(today + "-"):
        return f"{today}-{int(current.rsplit('-', 1)[1]) + 1}"
    return f"{today}-1"


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or not args[0].strip():
        print('Bitte Änderung angeben: python3 tools/bump_version.py "Was ist neu"')
        return 2
    notes = args[0].strip()
    vfile = ROOT / "version.json"
    current = json.loads(vfile.read_text(encoding="utf-8"))["version"]
    today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y.%m.%d")
    new = next_version(current, today)

    vfile.write_text(json.dumps({"version": new, "notes": notes}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (ROOT / "src" / "version.js").write_text(
        "// Wird von tools/bump_version.py gesetzt – nicht von Hand ändern.\n"
        f'export const APP_VERSION = "{new}";\n', encoding="utf-8")
    for f in [ROOT / "index.html", *sorted((ROOT / "src").glob("*.js"))]:
        text = f.read_text(encoding="utf-8")
        updated = re.sub(r"\?v=" + VERSION_RE, f"?v={new}", text)
        if updated != text:
            f.write_text(updated, encoding="utf-8")
    print(f"{current} → {new}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
