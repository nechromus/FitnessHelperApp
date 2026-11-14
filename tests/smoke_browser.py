"""Browser-Smoke-Test: App im iPhone-Format öffnen, Token eintragen, Beispieldatei laden.
api.github.com wird abgefangen – es geht keine echte Anfrage raus.

Aufruf:  python3 tests/smoke_browser.py [--chrome /usr/bin/google-chrome] [--shot screenshot.png]
"""
import argparse
import functools
import http.server
import json
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = {"schema_version": 1, "sample": True, "count": 2, "workouts": [
    {"id": "strava:1", "source": "strava", "type": "run", "name": "Morgenlauf",
     "start_utc": "2026-09-06T05:30:12Z", "start_local": "2026-09-06T07:30:12",
     "duration_s": 2410, "distance_m": 6120.4, "hr_avg": 152},
    {"id": "strava:2", "source": "strava", "type": "ski_nordic", "name": "Langlauf <b>Probe</b>",
     "start_utc": "2026-11-01T10:30:00Z", "start_local": "2026-11-01T11:30:00",
     "duration_s": 5400, "distance_m": 18402, "hr_avg": 138},
]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chrome", default="/usr/bin/google-chrome")
    ap.add_argument("--shot")
    a = ap.parse_args()

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}/"

    requests, errors = [], []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=a.chrome, args=["--no-sandbox"])
        page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        def gh(route):
            requests.append({"url": route.request.url, "auth": route.request.headers.get("authorization")})
            route.fulfill(status=200, content_type="application/json", body=json.dumps(SAMPLE),
                          headers={"Access-Control-Allow-Origin": "*"})
        page.route("https://api.github.com/**", gh)

        page.goto(base)
        assert "Token" in page.text_content("#status"), page.text_content("#status")
        page.click("#btn-settings")
        page.fill("#f-token", "test-token")
        page.click("button[type=submit]")
        page.wait_for_selector("#content:not([hidden])")
        assert page.locator(".workout").count() == 2
        assert page.is_visible("#sample-badge")
        assert "Langlauf <b>Probe</b>" in page.text_content(".workouts")  # kein HTML eingeschleust
        assert "24,5 km" in page.text_content("#tiles"), page.text_content("#tiles")
        assert requests and all(r["url"].startswith("https://api.github.com/") for r in requests)
        assert requests[0]["auth"] == "Bearer test-token"
        # Token ohne "merken" nur in der Sitzung
        assert page.evaluate("localStorage.getItem('fh.token')") is None
        if a.shot:
            page.screenshot(path=a.shot, full_page=True)
        b.close()
    srv.shutdown()
    if errors:
        print("Konsolenfehler:", errors)
        return 1
    print("Smoke-Test OK:", requests[0]["url"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
