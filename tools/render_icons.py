"""Erzeugt die PNG-Icons aus icons/icon.svg und icons/icon-maskable.svg (Playwright + Chrome).
Aufruf: python3 tools/render_icons.py
"""
import pathlib, sys
from playwright.sync_api import sync_playwright
d = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent / "icons"
jobs = [("icon.svg", "apple-touch-icon.png", 180), ("icon.svg", "icon-192.png", 192),
        ("icon.svg", "icon-512.png", 512), ("icon-maskable.svg", "icon-maskable-512.png", 512),
        ("icon.svg", "favicon-32.png", 32)]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for src, dst, n in jobs:
        pg = b.new_page(viewport={"width": n, "height": n})
        svg = (d / src).read_text()
        pg.set_content(f'<html><body style="margin:0">{svg.replace("<svg ", f"<svg width=\"{n}\" height=\"{n}\" ", 1)}</body></html>')
        pg.screenshot(path=str(d / dst), omit_background=False)
        pg.close()
    b.close()
print("ok")
